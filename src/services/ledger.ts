import type { Queryable } from "../db/index.js";
import { AppError, notFound } from "../errors.js";

export interface LedgerPosting {
  kind: "topup" | "toll" | "adjustment";
  /** Positive credits the account, negative debits it. */
  amountThebe: number;
  description: string;
  passageId?: string;
  topupId?: string;
}

/**
 * The only way a balance changes. Locks the account row, moves the balance and
 * writes the ledger entry in the caller's transaction. Throws insufficient_funds
 * rather than letting a balance go negative.
 */
export async function post(q: Queryable, accountId: string, p: LedgerPosting) {
  const { balance_thebe } = await lockedBalance(q, accountId);
  const balanceAfter = balance_thebe + p.amountThebe;
  if (balanceAfter < 0) throw new AppError(409, "insufficient_funds", "balance too low");
  await q.query("UPDATE accounts SET balance_thebe = $2 WHERE id = $1", [accountId, balanceAfter]);
  const entry = await q.query(
    `INSERT INTO ledger_entries (account_id, kind, amount_thebe, balance_after, passage_id, topup_id, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [accountId, p.kind, p.amountThebe, balanceAfter, p.passageId ?? null, p.topupId ?? null, p.description],
  );
  return entry.rows[0];
}

/** Current balance, read with a row lock so the caller can decide and post safely. */
export async function lockedBalance(q: Queryable, accountId: string) {
  const { rows } = await q.query<{ balance_thebe: number; status: string }>(
    "SELECT balance_thebe, status FROM accounts WHERE id = $1 FOR UPDATE",
    [accountId],
  );
  if (!rows[0]) throw notFound("account");
  return rows[0];
}
