import { z } from "zod";
import type { Db, Queryable } from "../db/index.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { normalizeBotswanaMsisdn, normalizePlate } from "../identifiers.js";
import { audit } from "./audit.js";

export const createAccountInput = z.object({
  holder_name: z.string().trim().min(2).max(200),
  phone: z.string().optional(),
  email: z.email().optional(),
});

export const accountStatusInput = z.object({
  status: z.enum(["active", "suspended", "closed"]),
  reason: z.string().trim().min(3).max(500),
});

export const registerVehicleInput = z.object({
  plate: z.string().min(2).max(20),
  vehicle_class: z.string(),
  tag_id: z.string().trim().min(4).max(64).optional(),
});

export interface Account {
  id: string;
  holder_name: string;
  phone: string | null;
  email: string | null;
  balance_thebe: number;
  status: "active" | "suspended" | "closed";
  created_at: Date;
}

export async function createAccount(db: Db, input: z.infer<typeof createAccountInput>, actor: string) {
  const phone = input.phone === undefined ? null : normalizeBotswanaMsisdn(input.phone);
  if (input.phone !== undefined && !phone) throw badRequest("invalid_phone", "phone must be a Botswana mobile number");
  return db.tx(async (q) => {
    const { rows } = await q.query<Account>(
      "INSERT INTO accounts (holder_name, phone, email) VALUES ($1, $2, $3) RETURNING *",
      [input.holder_name, phone, input.email ?? null],
    );
    const account = rows[0];
    await audit(q, actor, "account.created", "account", account.id, { holder_name: account.holder_name });
    return account;
  });
}

export async function getAccount(q: Queryable, id: string): Promise<Account> {
  const { rows } = await q.query<Account>("SELECT * FROM accounts WHERE id = $1", [id]);
  if (!rows[0]) throw notFound("account");
  return rows[0];
}

export async function setAccountStatus(db: Db, id: string, input: z.infer<typeof accountStatusInput>, actor: string) {
  return db.tx(async (q) => {
    const { rows } = await q.query<Account>("SELECT * FROM accounts WHERE id = $1 FOR UPDATE", [id]);
    const before = rows[0];
    if (!before) throw notFound("account");
    if (before.status === "closed") throw conflict("account_closed", "a closed account cannot be reopened");
    const { rows: after } = await q.query<Account>("UPDATE accounts SET status = $2 WHERE id = $1 RETURNING *", [
      id,
      input.status,
    ]);
    await audit(q, actor, "account.status_changed", "account", id, {
      from: before.status,
      to: input.status,
      reason: input.reason,
    });
    return after[0];
  });
}

export async function registerVehicle(
  db: Db,
  accountId: string,
  input: z.infer<typeof registerVehicleInput>,
  actor: string,
) {
  const plate = normalizePlate(input.plate);
  if (!/^[A-Z0-9]{2,10}$/.test(plate)) throw badRequest("invalid_plate", "plate must be 2-10 letters or digits");
  return db.tx(async (q) => {
    const account = await getAccount(q, accountId);
    if (account.status === "closed") throw conflict("account_closed", "cannot add vehicles to a closed account");
    const cls = await q.query("SELECT 1 FROM vehicle_classes WHERE code = $1", [input.vehicle_class]);
    if (!cls.rows[0]) throw badRequest("invalid_vehicle_class", `unknown vehicle class ${input.vehicle_class}`);
    const taken = await q.query<{ plate: string; tag_id: string | null }>(
      "SELECT plate, tag_id FROM vehicles WHERE active AND (plate = $1 OR tag_id = $2)",
      [plate, input.tag_id ?? null],
    );
    if (taken.rows.some((r) => r.plate === plate)) throw conflict("plate_registered", "plate is already registered");
    if (taken.rows[0]) throw conflict("tag_registered", "tag is already registered");
    const { rows } = await q.query(
      "INSERT INTO vehicles (account_id, plate, vehicle_class, tag_id) VALUES ($1, $2, $3, $4) RETURNING *",
      [accountId, plate, input.vehicle_class, input.tag_id ?? null],
    );
    await audit(q, actor, "vehicle.registered", "vehicle", rows[0].id, {
      account_id: accountId,
      plate,
      vehicle_class: input.vehicle_class,
      tag_id: input.tag_id ?? null,
    });
    return rows[0];
  });
}

/** ownerId, when given, limits it to that account's vehicles (the customer app). */
export async function deactivateVehicle(db: Db, vehicleId: string, actor: string, ownerId?: string) {
  return db.tx(async (q) => {
    const { rows } = await q.query(
      "UPDATE vehicles SET active = false WHERE id = $1 AND active AND ($2::uuid IS NULL OR account_id = $2) RETURNING *",
      [vehicleId, ownerId ?? null],
    );
    if (!rows[0]) throw notFound("active vehicle");
    await audit(q, actor, "vehicle.deactivated", "vehicle", vehicleId, { plate: rows[0].plate });
    return rows[0];
  });
}

export async function listVehicles(q: Queryable, accountId: string) {
  await getAccount(q, accountId);
  const { rows } = await q.query("SELECT * FROM vehicles WHERE account_id = $1 ORDER BY created_at", [accountId]);
  return rows;
}
