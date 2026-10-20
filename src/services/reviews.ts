import { z } from "zod";
import type { Db, Queryable } from "../db/index.js";
import { AppError, unprocessable } from "../errors.js";
import { normalizePlate } from "../identifiers.js";
import { audit } from "./audit.js";
import { decide, findVehicle, settle } from "./passages.js";

export const reviewQuery = z.object({
  status: z.enum(["open", "resolved"]).default("open"),
  gantry_id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const resolveInput = z
  .object({
    decision: z.enum(["confirmed", "corrected", "unreadable"]),
    plate: z.string().min(2).max(20).optional(),
    reviewer: z.string().trim().min(1).max(100).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine((r) => r.decision !== "corrected" || r.plate, { message: "a corrected review needs the plate" });

const columns = `r.id, r.passage_id, r.plate_read, r.read_confidence, r.candidates, r.status, r.decision,
  r.resolved_plate, r.reviewer, r.created_at, r.resolved_at, (r.image IS NOT NULL) AS has_image,
  p.gantry_id, p.passed_at, p.detected_class, p.charged_class, p.amount_thebe, p.status AS passage_status`;

/** Oldest first for the open queue (work it in order), newest first once resolved. */
export async function listReviews(q: Queryable, f: z.infer<typeof reviewQuery>) {
  const { rows } = await q.query(
    `SELECT ${columns}
     FROM plate_reviews r JOIN passages p ON p.id = r.passage_id
     WHERE r.status = $1 AND ($2::text IS NULL OR p.gantry_id = $2)
     ORDER BY ${f.status === "open" ? "r.created_at, p.passed_at" : "r.resolved_at DESC"}
     LIMIT $3`,
    [f.status, f.gantry_id ?? null, f.limit],
  );
  const counts = await q.query<{ status: string; n: number }>(
    "SELECT status, count(*)::int AS n FROM plate_reviews GROUP BY status",
  );
  return {
    open: counts.rows.find((c) => c.status === "open")?.n ?? 0,
    resolved: counts.rows.find((c) => c.status === "resolved")?.n ?? 0,
    items: rows,
  };
}

export async function getReview(q: Queryable, id: string) {
  const { rows } = await q.query(
    `SELECT ${columns} FROM plate_reviews r JOIN passages p ON p.id = r.passage_id WHERE r.id = $1`,
    [id],
  );
  if (!rows[0]) throw new AppError(404, "not_found", "review not found");
  return rows[0];
}

export async function getReviewImage(q: Queryable, id: string): Promise<{ bytes: Buffer; type: string } | null> {
  const { rows } = await q.query<{ image: Buffer | Uint8Array | null; image_type: string | null }>(
    "SELECT image, image_type FROM plate_reviews WHERE id = $1",
    [id],
  );
  if (!rows[0]) throw new AppError(404, "not_found", "review not found");
  const { image, image_type } = rows[0];
  return image ? { bytes: Buffer.from(image), type: image_type ?? "application/octet-stream" } : null;
}

/**
 * Settle a review. Confirmed or corrected, the passage is rated against the
 * agreed plate exactly as an automatic read would be: charged if the owner can
 * pay, unpaid with a violation otherwise. Unreadable, it is waived: there is
 * no one it can fairly be billed to.
 */
export async function resolveReview(
  db: Db,
  id: string,
  input: z.infer<typeof resolveInput>,
  actor: string,
  graceDays: number,
) {
  return db.tx(async (q) => {
    const { rows } = await q.query("SELECT * FROM plate_reviews WHERE id = $1 FOR UPDATE", [id]);
    const review = rows[0];
    if (!review) throw new AppError(404, "not_found", "review not found");
    if (review.status !== "open") throw new AppError(409, "already_resolved", `review was already ${review.decision}`);
    const passage = (await q.query("SELECT * FROM passages WHERE id = $1 FOR UPDATE", [review.passage_id])).rows[0];
    const reviewer = input.reviewer ?? actor;

    let plate: string | null = null;
    let violation: Record<string, any> | undefined;
    let updated: Record<string, any>;
    if (input.decision === "unreadable") {
      updated = (await q.query("UPDATE passages SET status = 'waived' WHERE id = $1 RETURNING *", [passage.id])).rows[0];
    } else {
      plate = input.decision === "confirmed" ? review.plate_read : normalizePlate(input.plate!);
      if (!plate) throw unprocessable("no_plate", "nothing to confirm: the camera returned no plate");
      const d = await decide(q, {
        gantryId: passage.gantry_id,
        passedAt: passage.passed_at,
        detectedClass: passage.detected_class,
        vehicle: await findVehicle(q, "plate", plate),
        matchMethod: "manual",
        runner: passage.payment_method === "runner",
      });
      updated = (
        await q.query(
          `UPDATE passages SET plate_read = $2, vehicle_id = $3, account_id = $4, charged_class = $5, amount_thebe = $6,
                  status = $7, match_method = $8, class_mismatch = $9
           WHERE id = $1 RETURNING *`,
          [passage.id, plate, d.vehicle?.id ?? null, d.vehicle?.account_id ?? null, d.chargedClass, d.amount,
           d.status, d.matchMethod, d.classMismatch],
        )
      ).rows[0];
      // The grace period runs from when the driver could first know, not from
      // the passage: a slow review queue must not eat into it.
      const graceFrom = new Date(Math.max(Date.now(), new Date(passage.passed_at).getTime()));
      violation = await settle(q, updated, d, plate, graceFrom, graceDays);
    }

    const resolved = (
      await q.query(
        `UPDATE plate_reviews SET status = 'resolved', decision = $2, resolved_plate = $3, reviewer = $4, resolved_at = now()
         WHERE id = $1 RETURNING id, status, decision, resolved_plate, reviewer, resolved_at`,
        [id, input.decision, plate, reviewer],
      )
    ).rows[0];
    await audit(q, actor, "review.resolved", "passage", passage.id, {
      review_id: id,
      decision: input.decision,
      plate_read: review.plate_read,
      resolved_plate: plate,
      reviewer,
      note: input.note ?? null,
      status: updated.status,
      amount_thebe: updated.amount_thebe,
      violation_id: violation?.id ?? null,
    });
    return {
      review: resolved,
      passage: { id: updated.id, status: updated.status, match_method: updated.match_method, amount_thebe: updated.amount_thebe },
      violation_reason: violation?.reason ?? null,
    };
  });
}
