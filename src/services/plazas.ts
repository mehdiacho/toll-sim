import { z } from "zod";
import type { Db, Queryable } from "../db/index.js";
import { AppError, unprocessable } from "../errors.js";
import { normalizePlate } from "../identifiers.js";
import { audit } from "./audit.js";
import { findTariff } from "./tariffs.js";

/**
 * Cash and card taken at a plaza booth. There is no account behind these: the
 * booth classifies the vehicle, the tariff in force prices it and the money is
 * the plaza's. The plate camera's read is kept for audit only.
 */
export const plazaTransactionInput = z.object({
  plaza_id: z.string().min(1).max(20),
  source_event_id: z.string().min(1).max(100),
  lane: z.number().int().min(0).max(15),
  direction: z.enum(["N", "S"]),
  method: z.enum(["cash", "card"]),
  vehicle_class: z.string().min(1).max(2),
  transacted_at: z.coerce.date(),
  plate: z.string().max(20).nullish(),
  read_confidence: z.number().min(0).max(1).nullish(),
  /** The tag passage that was declined at this boom, when the driver then paid here. */
  declined_passage_id: z.string().uuid().nullish(),
});
export type PlazaTransactionInput = z.infer<typeof plazaTransactionInput>;
export const plazaTransactionBatch = z.object({ transactions: z.array(z.unknown()).min(1).max(500) });

export interface PlazaTransactionResult {
  duplicate: boolean;
  transaction: Record<string, any>;
}

/** Record one booth payment. Idempotent on (plaza_id, source_event_id). */
export async function recordPlazaTransaction(db: Db, input: PlazaTransactionInput, actor: string): Promise<PlazaTransactionResult> {
  try {
    return await db.tx((q) => recordInTx(q, input, actor));
  } catch (err: any) {
    if (err?.code === "23505") {
      const existing = await findBySource(db, input.plaza_id, input.source_event_id);
      if (existing) return { duplicate: true, transaction: existing };
      throw new AppError(409, "already_paid", "that declined tag passage has already been paid at the booth");
    }
    throw err;
  }
}

async function findBySource(q: Queryable, plazaId: string, sourceEventId: string) {
  const { rows } = await q.query("SELECT * FROM plaza_transactions WHERE plaza_id = $1 AND source_event_id = $2", [
    plazaId,
    sourceEventId,
  ]);
  return rows[0] ?? null;
}

async function recordInTx(q: Queryable, input: PlazaTransactionInput, actor: string): Promise<PlazaTransactionResult> {
  const existing = await findBySource(q, input.plaza_id, input.source_event_id);
  if (existing) return { duplicate: true, transaction: existing };

  const plaza = (await q.query("SELECT id, kind FROM gantries WHERE id = $1", [input.plaza_id])).rows[0];
  if (!plaza) throw unprocessable("unknown_plaza", `no plaza ${input.plaza_id}`);
  if (plaza.kind !== "plaza") throw unprocessable("not_a_plaza", `${input.plaza_id} has no booths`);
  const cls = (await q.query("SELECT code FROM vehicle_classes WHERE code = $1", [input.vehicle_class])).rows[0];
  if (!cls) throw unprocessable("unknown_class", `no vehicle class ${input.vehicle_class}`);

  if (input.declined_passage_id) {
    const p = (
      await q.query("SELECT id, gantry_id, status FROM passages WHERE id = $1", [input.declined_passage_id])
    ).rows[0];
    if (!p || p.gantry_id !== input.plaza_id || p.status !== "declined") {
      throw unprocessable("not_declined", "declined_passage_id must be a declined tag passage at this plaza");
    }
  }

  const tariff = await findTariff(q, input.plaza_id, input.vehicle_class, input.transacted_at);
  if (!tariff) throw unprocessable("no_tariff", `no tariff for class ${input.vehicle_class} at ${input.plaza_id}`);

  const { rows } = await q.query(
    `INSERT INTO plaza_transactions (plaza_id, source_event_id, lane, direction, method, vehicle_class, amount_thebe,
                                     tariff_id, transacted_at, plate_read, read_confidence, declined_passage_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [
      input.plaza_id,
      input.source_event_id,
      input.lane,
      input.direction,
      input.method,
      input.vehicle_class,
      tariff.amount_thebe,
      tariff.id,
      input.transacted_at,
      input.plate ? normalizePlate(input.plate) : null,
      input.read_confidence ?? null,
      input.declined_passage_id ?? null,
    ],
  );
  const t = rows[0];
  await audit(q, actor, "plaza.transaction", "plaza_transaction", t.id, {
    plaza_id: t.plaza_id,
    lane: t.lane,
    direction: t.direction,
    method: t.method,
    vehicle_class: t.vehicle_class,
    amount_thebe: t.amount_thebe,
    declined_passage_id: t.declined_passage_id,
  });
  return { duplicate: false, transaction: t };
}

export const plazaTransactionQuery = z.object({
  plaza_id: z.string().optional(),
  method: z.enum(["cash", "card"]).optional(),
  since: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export async function listPlazaTransactions(q: Queryable, f: z.infer<typeof plazaTransactionQuery>) {
  const { rows } = await q.query(
    `SELECT * FROM plaza_transactions
     WHERE ($1::text IS NULL OR plaza_id = $1) AND ($2::text IS NULL OR method = $2)
       AND ($3::timestamptz IS NULL OR transacted_at >= $3)
     ORDER BY transacted_at DESC, received_at DESC LIMIT $4`,
    [f.plaza_id ?? null, f.method ?? null, f.since ?? null, f.limit],
  );
  return rows;
}

/**
 * Per plaza since `since`: how many vehicles paid by tag, cash and card, the
 * money taken each way, declined tags and boom runners.
 */
export async function plazaSummary(q: Queryable, since: Date) {
  const [plazas, booth, tags] = await Promise.all([
    q.query("SELECT id, name, km, lanes FROM gantries WHERE kind = 'plaza' ORDER BY km"),
    q.query(
      `SELECT plaza_id, method, count(*)::int AS n, coalesce(sum(amount_thebe), 0)::bigint AS amount_thebe
       FROM plaza_transactions WHERE transacted_at >= $1 GROUP BY plaza_id, method`,
      [since],
    ),
    q.query(
      `SELECT gantry_id,
              count(*) FILTER (WHERE payment_method = 'tag' AND status = 'charged')::int AS tag,
              coalesce(sum(amount_thebe) FILTER (WHERE payment_method = 'tag' AND status = 'charged'), 0)::bigint AS tag_thebe,
              count(*) FILTER (WHERE status = 'declined')::int AS declined,
              count(*) FILTER (WHERE payment_method = 'runner')::int AS runners,
              count(*) FILTER (WHERE tag_plate_mismatch)::int AS tag_plate_mismatch,
              count(*) FILTER (WHERE payment_method = 'tag' AND class_mismatch)::int AS class_mismatch
       FROM passages WHERE passed_at >= $1 AND payment_method IS NOT NULL GROUP BY gantry_id`,
      [since],
    ),
  ]);
  return plazas.rows.map((p) => {
    const t = tags.rows.find((r) => r.gantry_id === p.id);
    const by = (m: string) => booth.rows.find((r) => r.plaza_id === p.id && r.method === m);
    const cash = by("cash");
    const card = by("card");
    return {
      id: p.id,
      name: p.name,
      km: Number(p.km),
      lanes: p.lanes,
      by_method: { tag: t?.tag ?? 0, cash: cash?.n ?? 0, card: card?.n ?? 0 },
      revenue_thebe: {
        tag: Number(t?.tag_thebe ?? 0),
        cash: Number(cash?.amount_thebe ?? 0),
        card: Number(card?.amount_thebe ?? 0),
      },
      declined: t?.declined ?? 0,
      runners: t?.runners ?? 0,
      tag_plate_mismatch: t?.tag_plate_mismatch ?? 0,
      class_mismatch: t?.class_mismatch ?? 0,
    };
  });
}
