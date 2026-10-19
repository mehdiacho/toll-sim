import { z } from "zod";
import type { Db, Queryable } from "../db/index.js";
import { badRequest, conflict } from "../errors.js";
import { audit } from "./audit.js";

export const newTariffInput = z.object({
  gantry_id: z.string(),
  vehicle_class: z.string(),
  amount_thebe: z.number().int().min(0).max(10_000_00),
  valid_from: z.coerce.date(),
});

/** Price for one class at one gantry at a given instant, or null if none is in force. */
export async function findTariff(q: Queryable, gantryId: string, vehicleClass: string, at: Date) {
  const { rows } = await q.query<{ id: string; amount_thebe: number }>(
    `SELECT id, amount_thebe FROM tariffs
     WHERE gantry_id = $1 AND vehicle_class = $2
       AND valid_from <= $3 AND (valid_to IS NULL OR valid_to > $3)
     ORDER BY valid_from DESC LIMIT 1`,
    [gantryId, vehicleClass, at],
  );
  return rows[0] ?? null;
}

/**
 * Schedule a new price. The tariff currently open-ended is closed at
 * valid_from; history is never rewritten, so a new price cannot start before
 * the latest existing one.
 */
export async function scheduleTariff(db: Db, input: z.infer<typeof newTariffInput>, actor: string) {
  return db.tx(async (q) => {
    const g = await q.query("SELECT 1 FROM gantries WHERE id = $1", [input.gantry_id]);
    if (!g.rows[0]) throw badRequest("invalid_gantry", `unknown gantry ${input.gantry_id}`);
    const c = await q.query("SELECT 1 FROM vehicle_classes WHERE code = $1", [input.vehicle_class]);
    if (!c.rows[0]) throw badRequest("invalid_vehicle_class", `unknown vehicle class ${input.vehicle_class}`);
    const { rows: open } = await q.query<{ id: string; valid_from: Date }>(
      `SELECT id, valid_from FROM tariffs WHERE gantry_id = $1 AND vehicle_class = $2 AND valid_to IS NULL
       FOR UPDATE`,
      [input.gantry_id, input.vehicle_class],
    );
    const current = open[0];
    if (current && current.valid_from >= input.valid_from) {
      throw conflict("tariff_overlap", "a new tariff must start after the current one");
    }
    if (current) {
      await q.query("UPDATE tariffs SET valid_to = $2 WHERE id = $1", [current.id, input.valid_from]);
    }
    const { rows } = await q.query(
      `INSERT INTO tariffs (gantry_id, vehicle_class, amount_thebe, valid_from) VALUES ($1, $2, $3, $4) RETURNING *`,
      [input.gantry_id, input.vehicle_class, input.amount_thebe, input.valid_from],
    );
    await audit(q, actor, "tariff.scheduled", "tariff", rows[0].id, {
      gantry_id: input.gantry_id,
      vehicle_class: input.vehicle_class,
      amount_thebe: input.amount_thebe,
      valid_from: input.valid_from.toISOString(),
      supersedes: current?.id ?? null,
    });
    return rows[0];
  });
}
