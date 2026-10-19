import { z } from "zod";
import type { Db, Queryable } from "../db/index.js";
import { AppError, conflict, notFound, unprocessable } from "../errors.js";
import { audit } from "./audit.js";
import { post } from "./ledger.js";
import { bwDate, notify, pula } from "./outbox.js";
import { findTariff } from "./tariffs.js";

export const DISPUTE_REASONS = [
  "not_my_vehicle",
  "plate_misread",
  "wrong_class",
  "already_paid",
  "vehicle_stolen",
  "other",
] as const;

const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;

export const raiseDisputeInput = z.object({
  passage_id: z.uuid(),
  reason: z.enum(DISPUTE_REASONS),
  description: z.string().trim().min(10).max(2000),
  evidence: z
    .array(
      z.object({
        filename: z.string().trim().min(1).max(200),
        data_b64: z.string().min(8).max(Math.ceil((MAX_EVIDENCE_BYTES * 4) / 3) + 64),
      }),
    )
    .max(3)
    .default([]),
});

export const resolveDisputeInput = z.object({
  decision: z.enum(["upheld", "rejected"]),
  note: z.string().trim().min(5).max(1000),
  /** Upheld wrong-class disputes: re-rate the passage at this class instead of cancelling it. */
  corrected_class: z.string().optional(),
});

export const disputeQuery = z.object({
  status: z.enum(["open", "upheld", "rejected"]).optional(),
  account_id: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const EVIDENCE_MAGIC: [string, string][] = [
  ["/9j/", "image/jpeg"],
  ["iVBORw0KGgo", "image/png"],
  ["UklGR", "image/webp"],
  ["JVBER", "application/pdf"],
];

function decodeEvidence(b64: string) {
  const data = b64.replace(/^data:[^,]*,/, "");
  const type = EVIDENCE_MAGIC.find(([magic]) => data.startsWith(magic))?.[1];
  if (!type) throw unprocessable("invalid_evidence", "evidence must be a JPEG, PNG, WebP or PDF file");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > MAX_EVIDENCE_BYTES) throw unprocessable("evidence_too_large", "each file must be 2 MB or less");
  return { bytes, type };
}

export interface RaiseContext {
  actor: string;
  /** The motorist raising it. Absent when an operator logs one on someone's behalf. */
  accountId?: string;
  windowDays: number;
}

/**
 * Who may dispute a passage: the account it was billed to, or the account a
 * violation is against, or (for an unregistered-vehicle violation) whoever now
 * has that plate registered.
 */
export async function canActOnPassage(q: Queryable, accountId: string, passageId: string) {
  const { rows } = await q.query(
    `SELECT 1 FROM passages p LEFT JOIN violations v ON v.passage_id = p.id
     WHERE p.id = $1 AND (
       p.account_id = $2 OR v.account_id = $2 OR
       (v.account_id IS NULL AND v.plate IN (SELECT plate FROM vehicles WHERE account_id = $2 AND active)))`,
    [passageId, accountId],
  );
  return rows.length > 0;
}

/**
 * Open a dispute. While it is open, the violation (if any) is frozen: the
 * enforcement ladder skips it, so nobody collects fees on a charge that is
 * being contested.
 */
export async function raiseDispute(db: Db, input: z.infer<typeof raiseDisputeInput>, ctx: RaiseContext) {
  const files = input.evidence.map((e) => ({ filename: e.filename, ...decodeEvidence(e.data_b64) }));
  try {
    return await db.tx(async (q) => {
      const { rows } = await q.query("SELECT * FROM passages WHERE id = $1 FOR UPDATE", [input.passage_id]);
      const passage = rows[0];
      if (!passage) throw notFound("passage");
      if (ctx.accountId && !(await canActOnPassage(q, ctx.accountId, passage.id))) throw notFound("passage");
      if (!["charged", "unpaid"].includes(passage.status)) {
        throw conflict("nothing_to_dispute", `this passage is ${passage.status}; there is no charge to dispute`);
      }
      const age = Date.now() - new Date(passage.passed_at).getTime();
      if (age > ctx.windowDays * 86_400_000) {
        throw conflict("dispute_window_closed", `passages can be disputed for ${ctx.windowDays} days`);
      }
      const upheld = await q.query("SELECT 1 FROM disputes WHERE passage_id = $1 AND status = 'upheld'", [passage.id]);
      if (upheld.rows[0]) throw conflict("already_upheld", "a dispute on this passage was already upheld");

      const { rows: vrows } = await q.query("SELECT * FROM violations WHERE passage_id = $1", [passage.id]);
      const violation = vrows[0];
      const accountId = ctx.accountId ?? passage.account_id ?? violation?.account_id ?? null;
      const { rows: drows } = await q.query(
        `INSERT INTO disputes (passage_id, violation_id, account_id, raised_by, reason, description)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [passage.id, violation?.id ?? null, accountId, ctx.actor, input.reason, input.description],
      );
      const dispute = drows[0];
      for (const f of files) {
        await q.query("INSERT INTO dispute_evidence (dispute_id, filename, content_type, data) VALUES ($1, $2, $3, $4)", [
          dispute.id,
          f.filename,
          f.type,
          f.bytes,
        ]);
      }
      await audit(q, ctx.actor, "dispute.raised", "dispute", dispute.id, {
        passage_id: passage.id,
        violation_id: violation?.id ?? null,
        reason: input.reason,
        evidence: files.map((f) => ({ filename: f.filename, type: f.type, bytes: f.bytes.length })),
      });
      if (accountId) {
        await notify(q, { accountId }, {
          kind: "dispute_received",
          subject: `Dispute received, ref ${ref(dispute.id)}`,
          body:
            `We have received your dispute about the passage through ${passage.gantry_id} on ${bwDate(passage.passed_at)}. ` +
            (violation?.status === "open" ? "No fees will be added while we look into it. " : "") +
            `We will let you know the outcome. Ref ${ref(dispute.id)}.`,
          relatedType: "dispute",
          relatedId: dispute.id,
        });
      }
      return { ...dispute, evidence_count: files.length };
    });
  } catch (err: any) {
    if (err?.code === "23505") throw conflict("dispute_open", "this passage already has an open dispute");
    throw err;
  }
}

const listColumns = `d.*, p.gantry_id, p.passed_at, p.plate_read, p.charged_class, p.detected_class, p.amount_thebe,
  p.status AS passage_status, v.status AS violation_status, v.stage AS violation_stage,
  v.amount_due_thebe + v.penalty_thebe AS violation_owed_thebe, a.holder_name,
  (SELECT count(*)::int FROM dispute_evidence e WHERE e.dispute_id = d.id) AS evidence_count`;

/** Open disputes oldest first (work them in order); decided ones newest first. */
export async function listDisputes(q: Queryable, f: z.infer<typeof disputeQuery>) {
  const { rows } = await q.query(
    `SELECT ${listColumns}
     FROM disputes d JOIN passages p ON p.id = d.passage_id
     LEFT JOIN violations v ON v.id = d.violation_id LEFT JOIN accounts a ON a.id = d.account_id
     WHERE ($1::text IS NULL OR d.status = $1) AND ($2::uuid IS NULL OR d.account_id = $2)
     ORDER BY CASE WHEN d.status = 'open' THEN d.created_at END, d.resolved_at DESC NULLS LAST, d.created_at DESC
     LIMIT $3`,
    [f.status ?? null, f.account_id ?? null, f.limit],
  );
  const counts = await q.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM disputes GROUP BY status");
  const by = Object.fromEntries(counts.rows.map((r) => [r.status, r.n]));
  return { open: by.open ?? 0, upheld: by.upheld ?? 0, rejected: by.rejected ?? 0, items: rows };
}

/** Everything an operator needs to decide: the charge, the camera read, the registration, the evidence, the history. */
export async function getDispute(q: Queryable, id: string) {
  const { rows } = await q.query(
    `SELECT ${listColumns}
     FROM disputes d JOIN passages p ON p.id = d.passage_id
     LEFT JOIN violations v ON v.id = d.violation_id LEFT JOIN accounts a ON a.id = d.account_id
     WHERE d.id = $1`,
    [id],
  );
  const dispute = rows[0];
  if (!dispute) throw notFound("dispute");
  const [passage, violation, evidence, camera, vehicles, paid, history] = await Promise.all([
    q.query("SELECT * FROM passages WHERE id = $1", [dispute.passage_id]),
    q.query("SELECT * FROM violations WHERE passage_id = $1", [dispute.passage_id]),
    q.query(
      "SELECT id, filename, content_type, length(data)::int AS bytes, created_at FROM dispute_evidence WHERE dispute_id = $1 ORDER BY created_at",
      [id],
    ),
    q.query(
      `SELECT id AS review_id, plate_read, read_confidence, candidates, decision, resolved_plate, reviewer, (image IS NOT NULL) AS has_image
       FROM plate_reviews WHERE passage_id = $1`,
      [dispute.passage_id],
    ),
    dispute.account_id
      ? q.query("SELECT id, plate, vehicle_class, tag_id, active FROM vehicles WHERE account_id = $1 ORDER BY created_at", [
          dispute.account_id,
        ])
      : Promise.resolve({ rows: [] }),
    q.query(
      `SELECT kind, -sum(amount_thebe)::int AS thebe FROM ledger_entries
       WHERE passage_id = $1 AND kind IN ('toll', 'penalty', 'refund') GROUP BY kind`,
      [dispute.passage_id],
    ),
    q.query(
      `SELECT seq, at, actor, action, entity_type, data FROM audit_log
       WHERE (entity_type = 'passage' AND entity_id = $1) OR (entity_type = 'dispute' AND entity_id = $2)
          OR (entity_type = 'violation' AND entity_id = $3)
       ORDER BY seq`,
      [String(dispute.passage_id), String(id), String(dispute.violation_id ?? "")],
    ),
  ]);
  return {
    ...dispute,
    passage: passage.rows[0],
    violation: violation.rows[0] ?? null,
    evidence: evidence.rows,
    camera: camera.rows[0] ?? null,
    vehicles: vehicles.rows,
    paid: Object.fromEntries(paid.rows.map((r: any) => [r.kind, r.thebe])),
    history: history.rows,
  };
}

export async function getEvidence(q: Queryable, disputeId: string, evidenceId: string) {
  const { rows } = await q.query<{ filename: string; content_type: string; data: Buffer }>(
    "SELECT filename, content_type, data FROM dispute_evidence WHERE id = $1 AND dispute_id = $2",
    [evidenceId, disputeId],
  );
  if (!rows[0]) throw notFound("evidence");
  return rows[0];
}

/** The camera crop behind a passage, if the gantry sent one (it does for reads that went to review). */
export async function getPassageImage(q: Queryable, passageId: string) {
  const { rows } = await q.query<{ image: Buffer; image_type: string }>(
    "SELECT image, image_type FROM plate_reviews WHERE passage_id = $1 AND image IS NOT NULL",
    [passageId],
  );
  return rows[0] ? { bytes: Buffer.from(rows[0].image), type: rows[0].image_type } : null;
}

/**
 * Decide a dispute.
 *
 * Upheld: an open violation is waived (fees and all); a passage already paid is
 * refunded in full, toll and fees, to the account that paid. With
 * corrected_class it is re-rated instead: the motorist pays the right class's
 * toll and gets the difference back. A decision never makes a charge larger.
 *
 * Rejected: the violation resumes where it was, and its clock is pushed back by
 * however long the dispute was open, so contesting a charge in good faith never
 * costs the motorist any of their time to pay.
 */
export async function resolveDispute(db: Db, id: string, input: z.infer<typeof resolveDisputeInput>, actor: string) {
  return db.tx(async (q) => {
    const { rows } = await q.query("SELECT * FROM disputes WHERE id = $1 FOR UPDATE", [id]);
    const dispute = rows[0];
    if (!dispute) throw notFound("dispute");
    if (dispute.status !== "open") throw conflict("already_resolved", `dispute was already ${dispute.status}`);
    const passage = (await q.query("SELECT * FROM passages WHERE id = $1 FOR UPDATE", [dispute.passage_id])).rows[0];
    const violation = (await q.query("SELECT * FROM violations WHERE passage_id = $1 FOR UPDATE", [passage.id])).rows[0];
    const vOpen = violation?.status === "open";

    let refund = 0;
    let outcome: string;
    if (input.decision === "rejected") {
      if (input.corrected_class) throw unprocessable("class_on_rejection", "corrected_class only applies to an upheld dispute");
      if (vOpen) {
        await q.query("UPDATE violations SET due_by = due_by + (now() - $2::timestamptz) WHERE id = $1", [
          violation.id,
          dispute.created_at,
        ]);
      }
      outcome = vOpen ? "The charge stands and the time you had left to pay has been restored." : "The charge stands.";
    } else if (input.corrected_class && input.corrected_class !== passage.charged_class) {
      const tariff = await findTariff(q, passage.gantry_id, input.corrected_class, passage.passed_at);
      if (!tariff) throw unprocessable("invalid_vehicle_class", `no tariff for class ${input.corrected_class}`);
      const amount = Math.min(tariff.amount_thebe, passage.amount_thebe);
      if (vOpen) {
        await q.query("UPDATE violations SET amount_due_thebe = $2 WHERE id = $1", [violation.id, amount]);
      } else if (passage.status === "charged") {
        const payer = await paidFor(q, passage.id, ["toll"]);
        refund = payer ? Math.max(0, payer.thebe - amount) : 0;
        if (refund > 0) {
          await post(q, payer!.account_id, {
            kind: "refund",
            amountThebe: refund,
            passageId: passage.id,
            description: `Dispute upheld: re-rated class ${passage.charged_class} to ${input.corrected_class}`,
          });
        }
      }
      await q.query("UPDATE passages SET charged_class = $2, amount_thebe = $3 WHERE id = $1", [
        passage.id,
        input.corrected_class,
        amount,
      ]);
      outcome = `The passage has been re-rated as class ${input.corrected_class} (${pula(amount)})` + (refund ? `, and ${pula(refund)} has been refunded to your account.` : ".");
    } else if (vOpen) {
      await q.query(
        "UPDATE violations SET status = 'waived', resolved_at = now(), resolution_note = $2 WHERE id = $1",
        [violation.id, `dispute ${id} upheld`],
      );
      await q.query("UPDATE passages SET status = 'waived' WHERE id = $1", [passage.id]);
      outcome = "The charge has been cancelled, along with any fees.";
    } else if (passage.status === "charged") {
      const payer = await paidFor(q, passage.id, ["toll", "penalty"]);
      refund = payer?.thebe ?? 0;
      if (refund > 0) {
        await post(q, payer!.account_id, {
          kind: "refund",
          amountThebe: refund,
          passageId: passage.id,
          description: `Dispute upheld: passage ${passage.gantry_id} refunded`,
        });
      }
      await q.query("UPDATE passages SET status = 'refunded' WHERE id = $1", [passage.id]);
      outcome = `The charge has been cancelled and ${pula(refund)} refunded to your account.`;
    } else {
      throw conflict("nothing_to_refund", `passage is ${passage.status}`);
    }

    const { rows: updated } = await q.query(
      `UPDATE disputes SET status = $2, resolution_note = $3, corrected_class = $4, refund_thebe = $5,
                           resolved_by = $6, resolved_at = now()
       WHERE id = $1 RETURNING *`,
      [id, input.decision, input.note, input.decision === "upheld" ? (input.corrected_class ?? null) : null, refund, actor],
    );
    await audit(q, actor, "dispute.resolved", "dispute", id, {
      decision: input.decision,
      note: input.note,
      corrected_class: input.corrected_class ?? null,
      refund_thebe: refund,
      violation_id: violation?.id ?? null,
    });
    if (dispute.account_id) {
      await notify(q, { accountId: dispute.account_id }, {
        kind: "dispute_resolved",
        subject: `Dispute ${input.decision}, ref ${ref(id)}`,
        body: `Your dispute about the passage through ${passage.gantry_id} on ${bwDate(passage.passed_at)} was ${input.decision}. ${outcome} Reason: ${input.note} Ref ${ref(id)}.`,
        relatedType: "dispute",
        relatedId: id,
      });
    }
    const after = (await q.query("SELECT id, status, charged_class, amount_thebe FROM passages WHERE id = $1", [passage.id])).rows[0];
    return { dispute: updated[0], passage: after, refund_thebe: refund };
  });
}

/** Who paid how much for a passage (normally a single account). */
async function paidFor(q: Queryable, passageId: string, kinds: string[]) {
  const { rows } = await q.query<{ account_id: string; thebe: number }>(
    `SELECT account_id, -sum(amount_thebe)::int AS thebe FROM ledger_entries
     WHERE passage_id = $1 AND kind = ANY($2) GROUP BY account_id ORDER BY thebe DESC`,
    [passageId, kinds],
  );
  if (rows.length > 1) throw new AppError(409, "split_payment", "passage was paid from more than one account; refund manually");
  return rows[0];
}

const ref = (id: string) => id.slice(0, 8).toUpperCase();
