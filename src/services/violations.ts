import { z } from "zod";
import type { Db, Queryable } from "../db/index.js";
import { AppError, conflict, notFound } from "../errors.js";
import { normalizePlate } from "../identifiers.js";
import { audit } from "./audit.js";
import { getAccount } from "./accounts.js";
import { lockedBalance, post } from "./ledger.js";

export const violationQuery = z.object({
  status: z.enum(["open", "settled", "waived"]).optional(),
  stage: z.enum(["grace", "notice", "final_notice", "referred"]).optional(),
  account_id: z.uuid().optional(),
  plate: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const settleInput = z.object({ account_id: z.uuid() });
export const waiveInput = z.object({ reason: z.string().trim().min(5).max(500) });

export async function listViolations(q: Queryable, f: z.infer<typeof violationQuery>) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (column: string, value: unknown) => {
    params.push(value);
    where.push(`v.${column} = $${params.length}`);
  };
  if (f.status) add("status", f.status);
  if (f.stage) add("stage", f.stage);
  if (f.account_id) add("account_id", f.account_id);
  if (f.plate) add("plate", normalizePlate(f.plate));
  params.push(f.limit);
  const { rows } = await q.query(
    `SELECT v.*, v.amount_due_thebe + v.penalty_thebe AS owed_thebe, p.gantry_id, p.passed_at
     FROM violations v JOIN passages p ON p.id = v.passage_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY v.created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

async function lockOpenViolation(q: Queryable, id: string) {
  const { rows } = await q.query("SELECT * FROM violations WHERE id = $1 FOR UPDATE", [id]);
  const v = rows[0];
  if (!v) throw notFound("violation");
  if (v.status !== "open") throw conflict("violation_closed", `violation is already ${v.status}`);
  return v;
}

/** What it takes to clear a violation: the toll plus any enforcement penalties. */
export const owed = (v: { amount_due_thebe: number; penalty_thebe: number }) => v.amount_due_thebe + v.penalty_thebe;

/** Debit the account for an open violation and mark it and its passage paid. */
async function settleInTx(q: Queryable, v: any, accountId: string, actor: string, how: string) {
  const { balance_thebe } = await lockedBalance(q, accountId);
  if (balance_thebe < owed(v)) throw new AppError(409, "insufficient_funds", "balance too low");
  await post(q, accountId, {
    kind: "toll",
    amountThebe: -v.amount_due_thebe,
    passageId: v.passage_id,
    description: `Late toll settlement (${v.reason})`,
  });
  if (v.penalty_thebe > 0) {
    await post(q, accountId, {
      kind: "penalty",
      amountThebe: -v.penalty_thebe,
      passageId: v.passage_id,
      description: `Enforcement fees (${v.stage.replace("_", " ")})`,
    });
  }
  const { rows } = await q.query(
    `UPDATE violations SET status = 'settled', account_id = $2, resolved_at = now(), resolution_note = $3
     WHERE id = $1 RETURNING *`,
    [v.id, accountId, how],
  );
  await q.query("UPDATE passages SET status = 'charged', account_id = coalesce(account_id, $2) WHERE id = $1", [
    v.passage_id,
    accountId,
  ]);
  await audit(q, actor, "violation.settled", "violation", v.id, {
    account_id: accountId,
    amount_thebe: v.amount_due_thebe,
    penalty_thebe: v.penalty_thebe,
    how,
  });
  return rows[0];
}

/**
 * Pay a violation from an account. This is also how the owner of an
 * unregistered vehicle clears a passage once they open an account.
 */
export async function settleViolation(db: Db, id: string, accountId: string, actor: string) {
  return db.tx(async (q) => {
    const v = await lockOpenViolation(q, id);
    await getAccount(q, accountId);
    return settleInTx(q, v, accountId, actor, "manual");
  });
}

export async function waiveViolation(db: Db, id: string, reason: string, actor: string) {
  return db.tx(async (q) => {
    const v = await lockOpenViolation(q, id);
    const { rows } = await q.query(
      `UPDATE violations SET status = 'waived', resolved_at = now(), resolution_note = $2 WHERE id = $1 RETURNING *`,
      [id, reason],
    );
    await q.query("UPDATE passages SET status = 'waived' WHERE id = $1", [v.passage_id]);
    await audit(q, actor, "violation.waived", "violation", id, {
      reason,
      amount_thebe: v.amount_due_thebe,
      penalty_thebe: v.penalty_thebe,
    });
    return rows[0];
  });
}

/**
 * After money arrives, clear the account's open violations oldest first, for as
 * long as the balance covers the next one. Stops at the first it cannot pay so
 * an older debt is never skipped in favour of a newer, smaller one.
 */
export async function settleOpenViolations(q: Queryable, accountId: string, actor: string) {
  const { rows } = await q.query(
    "SELECT * FROM violations WHERE account_id = $1 AND status = 'open' ORDER BY created_at, id FOR UPDATE",
    [accountId],
  );
  const settled = [];
  for (const v of rows) {
    const { balance_thebe } = await lockedBalance(q, accountId);
    if (balance_thebe < owed(v)) break;
    settled.push(await settleInTx(q, v, accountId, actor, "auto_after_topup"));
  }
  return settled;
}
