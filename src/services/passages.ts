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
}

export interface IngestOptions {
  actor: string;
  graceDays: number;
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

  // A tag is a stronger identifier than a camera read, so it wins when present.
  type Match = { id: string; account_id: string; vehicle_class: string };
  let vehicle: Match | undefined;
  let matchMethod: "tag" | "plate" | "none" = "none";
  if (tagId) {
    const r = await q.query<Match>("SELECT id, account_id, vehicle_class FROM vehicles WHERE active AND tag_id = $1", [
      tagId,
    ]);
    if (r.rows[0]) [vehicle, matchMethod] = [r.rows[0], "tag"];
  }
  if (!vehicle && plate) {
    const r = await q.query<Match>("SELECT id, account_id, vehicle_class FROM vehicles WHERE active AND plate = $1", [
      plate,
    ]);
    if (r.rows[0]) [vehicle, matchMethod] = [r.rows[0], "plate"];
  }

  // Bill the registered class. A detector that disagrees is flagged for review,
  // not used to silently re-price the passage.
  const chargedClass = vehicle?.vehicle_class ?? input.detected_class ?? DEFAULT_CLASS;
  const classMismatch = Boolean(vehicle && input.detected_class && input.detected_class !== vehicle.vehicle_class);

  const tariff = await findTariff(q, input.gantry_id, chargedClass, input.passed_at);
  if (!tariff) {
    throw unprocessable(
      "no_tariff",
      `no tariff for class ${chargedClass} at ${input.gantry_id} on ${input.passed_at.toISOString()}`,
    );
  }
  const amount = tariff.amount_thebe;

  let status: "charged" | "unpaid" = "unpaid";
  let violationReason: "insufficient_funds" | "unregistered_vehicle" | "account_inactive" | null = null;
  if (!vehicle) {
    violationReason = "unregistered_vehicle";
  } else {
    const account = await lockedBalance(q, vehicle.account_id);
    if (account.status !== "active") violationReason = "account_inactive";
    else if (account.balance_thebe < amount) violationReason = "insufficient_funds";
    else status = "charged";
  }

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
      vehicle?.id ?? null,
      vehicle?.account_id ?? null,
      chargedClass,
      amount,
      status,
      matchMethod,
      classMismatch,
    ],
  );
  const passage = rows[0];

  if (status === "charged" && amount > 0) {
    await post(q, vehicle!.account_id, {
      kind: "toll",
      amountThebe: -amount,
      passageId: passage.id,
      description: `Toll ${input.gantry_id} class ${chargedClass}`,
    });
  }

  let violation: Record<string, any> | undefined;
  if (violationReason) {
    const dueBy = new Date(input.passed_at.getTime() + opts.graceDays * 86_400_000);
    const v = await q.query(
      `INSERT INTO violations (passage_id, plate, account_id, reason, amount_due_thebe, due_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [passage.id, plate, vehicle?.account_id ?? null, violationReason, amount, dueBy],
    );
    violation = v.rows[0];
  }

  await audit(q, opts.actor, "passage.rated", "passage", passage.id, {
    gantry_id: input.gantry_id,
    source_event_id: input.source_event_id,
    match_method: matchMethod,
    charged_class: chargedClass,
    amount_thebe: amount,
    tariff_id: tariff.id,
    status,
    violation_id: violation?.id ?? null,
    violation_reason: violationReason,
  });

  return { duplicate: false, passage, violation };
}

export const passageQuery = z.object({
  plate: z.string().optional(),
  gantry_id: z.string().optional(),
  account_id: z.uuid().optional(),
  status: z.enum(["charged", "unpaid", "waived"]).optional(),
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
