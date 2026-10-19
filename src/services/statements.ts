import { z } from "zod";
import type { Queryable } from "../db/index.js";
import { getAccount } from "./accounts.js";

export const statementQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/**
 * Account statement for [from, to). Built from the ledger alone, so the
 * opening balance plus the entries always equals the closing balance.
 */
export async function buildStatement(q: Queryable, accountId: string, range: z.infer<typeof statementQuery>) {
  const account = await getAccount(q, accountId);
  const to = range.to ?? new Date();
  const from = range.from ?? new Date(to.getTime() - 30 * 86_400_000);

  const opening = await q.query<{ balance_after: number }>(
    `SELECT balance_after FROM ledger_entries WHERE account_id = $1 AND created_at < $2 ORDER BY id DESC LIMIT 1`,
    [accountId, from],
  );
  const openingBalance = opening.rows[0]?.balance_after ?? 0;

  const { rows: entries } = await q.query(
    `SELECT l.id, l.created_at, l.kind, l.amount_thebe, l.balance_after, l.description,
            l.passage_id, p.gantry_id, p.passed_at, p.plate_read, p.charged_class,
            l.topup_id, t.provider
     FROM ledger_entries l
     LEFT JOIN passages p ON p.id = l.passage_id
     LEFT JOIN topups t ON t.id = l.topup_id
     WHERE l.account_id = $1 AND l.created_at >= $2 AND l.created_at < $3
     ORDER BY l.id`,
    [accountId, from, to],
  );

  const sum = (kind: string) =>
    entries.filter((e: any) => e.kind === kind).reduce((s: number, e: any) => s + e.amount_thebe, 0);

  const { rows: openViolations } = await q.query(
    `SELECT v.id, v.reason, v.stage, v.amount_due_thebe, v.penalty_thebe,
            v.amount_due_thebe + v.penalty_thebe AS owed_thebe, v.due_by, p.gantry_id, p.passed_at, p.plate_read
     FROM violations v JOIN passages p ON p.id = v.passage_id
     WHERE v.account_id = $1 AND v.status = 'open' ORDER BY v.created_at`,
    [accountId],
  );

  return {
    account: { id: account.id, holder_name: account.holder_name, status: account.status },
    period: { from: from.toISOString(), to: to.toISOString() },
    opening_balance_thebe: openingBalance,
    closing_balance_thebe: entries.length ? (entries.at(-1) as any).balance_after : openingBalance,
    totals: {
      topups_thebe: sum("topup"),
      tolls_thebe: -sum("toll"),
      penalties_thebe: -sum("penalty"),
      refunds_thebe: sum("refund"),
      adjustments_thebe: sum("adjustment"),
    },
    entries,
    open_violations: openViolations,
    outstanding_thebe: openViolations.reduce((s: number, v: any) => s + v.owed_thebe, 0),
  };
}
