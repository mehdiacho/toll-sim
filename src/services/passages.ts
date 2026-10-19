import { z } from "zod";
import type { Db, Queryable } from "../db/index.js";
import { unprocessable } from "../errors.js";
import { normalizePlate } from "../identifiers.js";
import { audit } from "./audit.js";
import { lockedBalance, post } from "./ledger.js";
import { findTariff } from "./tariffs.js";

export const passageInput = z
  .object({
    source_event_id: z.string().min(1).max(128),
    gantry_id: z.string().min(1),
    passed_at: z.coerce.date(),
    plate: z.string().max(20).nullish(),
    tag_id: z.string().max(64).nullish(),
    detected_class: z.string().nullish(),
    read_confidence: z.number().min(0).max(1).nullish(),
    // ANPR runner-up readings and the plate crop; stored only if the read goes to review.
    read_candidates: z
      .array(z.object({ plate: z.string().max(20), confidence: z.number().min(0).max(1) }))
      .max(5)
      .nullish(),
    image_b64: z.string().max(300_000).nullish(),
  })
  .refine((p) => p.plate || p.tag_id, { message: "plate or tag_id is required" });

export const passageBatchInput = z.object({ events: z.array(z.unknown()).min(1).max(500) });

export type PassageInput = z.infer<typeof passageInput>;

/** Class assumed when an unregistered vehicle's class could not be detected. */
const DEFAULT_CLASS = "1";

export interface IngestResult {
  duplicate: boolean;
  passage: Record<string, any>;
  violation?: Record<string, any>;
  review_id?: string;
}

export interface IngestOptions {
  actor: string;
  graceDays: number;
  /** Plate reads below this confidence, with no tag match, go to manual review. */
  reviewThreshold: number;
}

/**
 * Rate one gantry read and settle it: charge the account if it can pay, or
 * record the passage as unpaid with a violation if it cannot. Idempotent on
 * (gantry_id, source_event_id).
 */
export async function ingestPassage(db: Db, input: PassageInput, opts: IngestOptions): Promise<IngestResult> {
  try {
    return await db.tx((q) => ingestInTx(q, input, opts));
  } catch (err: any) {
    // Two copies of the same event raced past the duplicate check.
    if (err?.code === "23505") {
      const existing = await findBySourceEvent(db, input.gantry_id, input.source_event_id);
      if (existing) return duplicateOf(db, existing);
    }
    throw err;
  }
}

async function findBySourceEvent(q: Queryable, gantryId: string, sourceEventId: string) {
  const { rows } = await q.query("SELECT * FROM passages WHERE gantry_id = $1 AND source_event_id = $2", [
    gantryId,
    sourceEventId,
  ]);
  return rows[0] ?? null;
}

async function duplicateOf(q: Queryable, passage: Record<string, any>): Promise<IngestResult> {
  const { rows } = await q.query("SELECT * FROM violations WHERE passage_id = $1", [passage.id]);
  return { duplicate: true, passage, violation: rows[0] };
}

async function ingestInTx(q: Queryable, input: PassageInput, opts: IngestOptions): Promise<IngestResult> {
  const existing = await findBySourceEvent(q, input.gantry_id, input.source_event_id);
  if (existing) return duplicateOf(q, existing);

  const gantry = await q.query<{ active: boolean }>("SELECT active FROM gantries WHERE id = $1", [input.gantry_id]);
  if (!gantry.rows[0]) throw unprocessable("unknown_gantry", `unknown gantry ${input.gantry_id}`);
  if (!gantry.rows[0].active) throw unprocessable("gantry_inactive", `gantry ${input.gantry_id} is not active`);

  if (input.detected_class) {
    const c = await q.query("SELECT 1 FROM vehicle_classes WHERE code = $1", [input.detected_class]);
    if (!c.rows[0]) throw unprocessable("invalid_vehicle_class", `unknown vehicle class ${input.detected_class}`);
  }

  const plate = input.plate ? normalizePlate(input.plate) : null;
  const tagId = input.tag_id?.trim() || null;
  const image = input.image_b64 ? decodeImage(input.image_b64) : null;

  // A tag is a stronger identifier than a camera read, so it wins when present.
  const tagged = tagId ? await findVehicle(q, "tag_id", tagId) : undefined;

  // An unsure camera read with no tag behind it goes to a person, not to the
  // ledger: charging or ticketing the wrong plate is the failure that sinks trust.
  const needsReview =
    !tagged && plate !== null && input.read_confidence != null && input.read_confidence < opts.reviewThreshold;
  if (needsReview) {
    const chargedClass = input.detected_class ?? DEFAULT_CLASS;
    const tariff = await requireTariff(q, input.gantry_id, chargedClass, input.passed_at);
    const { rows } = await q.query(
      `INSERT INTO passages (gantry_id, source_event_id, passed_at, plate_read, tag_id, read_confidence, detected_class,
                             charged_class, amount_thebe, status, match_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'review', 'none') RETURNING *`,
      [
        input.gantry_id,
        input.source_event_id,
        input.passed_at,
        plate,
        tagId,
        input.read_confidence,
        input.detected_class ?? null,
        chargedClass,
        tariff.amount_thebe,
      ],
    );
    const passage = rows[0];
    const review = await q.query<{ id: string }>(
      `INSERT INTO plate_reviews (passage_id, plate_read, read_confidence, candidates, image, image_type)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        passage.id,
        plate,
        input.read_confidence,
        JSON.stringify(input.read_candidates ?? []),
        image?.bytes ?? null,
        image?.type ?? null,
      ],
    );
    const reviewId = review.rows[0].id;
    await audit(q, opts.actor, "passage.queued_for_review", "passage", passage.id, {
      gantry_id: input.gantry_id,
      source_event_id: input.source_event_id,
      plate_read: plate,
      read_confidence: input.read_confidence,
      review_id: reviewId,
    });
    return { duplicate: false, passage, review_id: reviewId };
  }

  const d = await decide(q, {
    gantryId: input.gantry_id,
    passedAt: input.passed_at,
    detectedClass: input.detected_class ?? null,
    vehicle: tagged ?? (plate ? await findVehicle(q, "plate", plate) : undefined),
    matchMethod: tagged ? "tag" : "plate",
  });

  const { rows } = await q.query(
    `INSERT INTO passages (gantry_id, source_event_id, passed_at, plate_read, tag_id, read_confidence, detected_class,
                           vehicle_id, account_id, charged_class, amount_thebe, status, match_method, class_mismatch)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
    [
      input.gantry_id,
      input.source_event_id,
      input.passed_at,
      plate,
      tagId,
      input.read_confidence ?? null,
      input.detected_class ?? null,
      d.vehicle?.id ?? null,
      d.vehicle?.account_id ?? null,
      d.chargedClass,
      d.amount,
      d.status,
      d.matchMethod,
      d.classMismatch,
    ],
  );
  const passage = rows[0];
  const violation = await settle(q, passage, d, plate, input.passed_at, opts.graceDays);

  await audit(q, opts.actor, "passage.rated", "passage", passage.id, {
    gantry_id: input.gantry_id,
    source_event_id: input.source_event_id,
    match_method: d.matchMethod,
    charged_class: d.chargedClass,
    amount_thebe: d.amount,
    tariff_id: d.tariffId,
    status: d.status,
    violation_id: violation?.id ?? null,
    violation_reason: d.violationReason,
  });

  return { duplicate: false, passage, violation };
}

export type VehicleMatch = { id: string; account_id: string; vehicle_class: string };

export async function findVehicle(q: Queryable, by: "tag_id" | "plate", value: string): Promise<VehicleMatch | undefined> {
  const { rows } = await q.query<VehicleMatch>(
    `SELECT id, account_id, vehicle_class FROM vehicles WHERE active AND ${by} = $1`,
    [value],
  );
  return rows[0];
}

async function requireTariff(q: Queryable, gantryId: string, vehicleClass: string, at: Date) {
  const tariff = await findTariff(q, gantryId, vehicleClass, at);
  if (!tariff) throw unprocessable("no_tariff", `no tariff for class ${vehicleClass} at ${gantryId} on ${at.toISOString()}`);
  return tariff;
}

export interface Decision {
  vehicle?: VehicleMatch;
  matchMethod: "tag" | "plate" | "manual" | "none";
  chargedClass: string;
  classMismatch: boolean;
  amount: number;
  tariffId: unknown;
  status: "charged" | "unpaid";
  violationReason: "insufficient_funds" | "unregistered_vehicle" | "account_inactive" | null;
}

/**
 * Price a passage and decide whether it can be charged. Locks the account row
 * when there is one, so call it inside the transaction that settles.
 */
export async function decide(
  q: Queryable,
  p: {
    gantryId: string;
    passedAt: Date;
    detectedClass: string | null;
    vehicle?: VehicleMatch;
    matchMethod: Decision["matchMethod"];
  },
): Promise<Decision> {
  const vehicle = p.vehicle;
  // Bill the registered class. A detector that disagrees is flagged for review,
  // not used to silently re-price the passage.
  const chargedClass = vehicle?.vehicle_class ?? p.detectedClass ?? DEFAULT_CLASS;
  const classMismatch = Boolean(vehicle && p.detectedClass && p.detectedClass !== vehicle.vehicle_class);
  const tariff = await requireTariff(q, p.gantryId, chargedClass, p.passedAt);
  const amount = tariff.amount_thebe;

  let status: Decision["status"] = "unpaid";
  let violationReason: Decision["violationReason"] = null;
  if (!vehicle) {
    violationReason = "unregistered_vehicle";
  } else {
    const account = await lockedBalance(q, vehicle.account_id);
    if (account.status !== "active") violationReason = "account_inactive";
    else if (account.balance_thebe < amount) violationReason = "insufficient_funds";
    else status = "charged";
  }
  return {
    vehicle,
    matchMethod: vehicle ? p.matchMethod : "none",
    chargedClass,
    classMismatch,
    amount,
    tariffId: tariff.id,
    status,
    violationReason,
  };
}

/** Post the toll, or open the violation, for a passage already written with decision d. */
export async function settle(
  q: Queryable,
  passage: Record<string, any>,
  d: Decision,
  plate: string | null,
  graceFrom: Date,
  graceDays: number,
): Promise<Record<string, any> | undefined> {
  if (d.status === "charged" && d.amount > 0) {
    await post(q, d.vehicle!.account_id, {
      kind: "toll",
      amountThebe: -d.amount,
      passageId: passage.id,
      description: `Toll ${passage.gantry_id} class ${d.chargedClass}`,
    });
  }
  if (!d.violationReason) return undefined;
  const dueBy = new Date(graceFrom.getTime() + graceDays * 86_400_000);
  const { rows } = await q.query(
    `INSERT INTO violations (passage_id, plate, account_id, reason, amount_due_thebe, due_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [passage.id, plate, d.vehicle?.account_id ?? null, d.violationReason, d.amount, dueBy],
  );
  return rows[0];
}

const IMAGE_MAGIC: [string, string][] = [
  ["/9j/", "image/jpeg"],
  ["iVBORw0KGgo", "image/png"],
  ["UklGR", "image/webp"],
];

function decodeImage(b64: string): { bytes: Buffer; type: string } {
  const data = b64.replace(/^data:[^,]*,/, "");
  const type = IMAGE_MAGIC.find(([magic]) => data.startsWith(magic))?.[1];
  if (!type) throw unprocessable("invalid_image", "image_b64 must be a base64 JPEG, PNG or WebP");
  return { bytes: Buffer.from(data, "base64"), type };
}

export const passageQuery = z.object({
  plate: z.string().optional(),
  gantry_id: z.string().optional(),
  account_id: z.uuid().optional(),
  status: z.enum(["charged", "unpaid", "waived", "review"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export async function listPassages(q: Queryable, f: z.infer<typeof passageQuery>) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (column: string, value: unknown) => {
    params.push(value);
    where.push(`${column} = $${params.length}`);
  };
  if (f.plate) add("plate_read", normalizePlate(f.plate));
  if (f.gantry_id) add("gantry_id", f.gantry_id);
  if (f.account_id) add("account_id", f.account_id);
  if (f.status) add("status", f.status);
  params.push(f.limit);
  const { rows } = await q.query(
    `SELECT * FROM passages ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY passed_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}
