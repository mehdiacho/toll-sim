import { z } from "zod";
import type { Queryable } from "../db/index.js";

export interface Message {
  channel: "sms" | "email" | "post";
  recipient: string;
  accountId?: string | null;
  kind: string;
  subject?: string;
  body: string;
  relatedType?: string;
  relatedId?: string;
}

/**
 * Record a message for delivery. Nothing is actually sent in this simulation;
 * a real deployment would have a worker drain this table to the SMS gateway,
 * the mail service and the print house. Writing it in the caller's
 * transaction means a notice exists if and only if the change behind it does.
 */
export async function enqueue(q: Queryable, m: Message) {
  const { rows } = await q.query(
    `INSERT INTO outbox (channel, recipient, account_id, kind, subject, body, related_type, related_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [m.channel, m.recipient, m.accountId ?? null, m.kind, m.subject ?? null, m.body, m.relatedType ?? null, m.relatedId ?? null],
  );
  return rows[0];
}

/**
 * Send the same message to everything we know about an account (SMS to the
 * phone, plus email if there is one). With no account, the only route is a
 * letter to the registered keeper, found through the vehicle registry.
 */
export async function notify(
  q: Queryable,
  to: { accountId: string | null; plate?: string | null },
  m: Omit<Message, "channel" | "recipient" | "accountId">,
) {
  if (!to.accountId) {
    return [await enqueue(q, { ...m, channel: "post", recipient: `Registered keeper of ${to.plate ?? "unknown plate"}` })];
  }
  const { rows } = await q.query<{ phone: string | null; email: string | null }>(
    "SELECT phone, email FROM accounts WHERE id = $1",
    [to.accountId],
  );
  const a = rows[0];
  const sent = [];
  if (a?.phone) sent.push(await enqueue(q, { ...m, channel: "sms", recipient: a.phone, accountId: to.accountId }));
  if (a?.email) sent.push(await enqueue(q, { ...m, channel: "email", recipient: a.email, accountId: to.accountId }));
  if (!sent.length) sent.push(await enqueue(q, { ...m, channel: "post", recipient: "Account holder (postal address on file)", accountId: to.accountId }));
  return sent;
}

export const outboxQuery = z.object({
  account_id: z.uuid().optional(),
  kind: z.string().optional(),
  related_id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export async function listOutbox(q: Queryable, f: z.infer<typeof outboxQuery>) {
  const { rows } = await q.query(
    `SELECT * FROM outbox
     WHERE ($1::uuid IS NULL OR account_id = $1) AND ($2::text IS NULL OR kind = $2) AND ($3::text IS NULL OR related_id = $3)
     ORDER BY created_at DESC LIMIT $4`,
    [f.account_id ?? null, f.kind ?? null, f.related_id ?? null, f.limit],
  );
  return rows;
}

/** P 1,234.50 */
export function pula(thebe: number): string {
  return `P ${(thebe / 100).toLocaleString("en-BW", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 19 Oct 2026, in Botswana time. */
export function bwDate(d: Date | string): string {
  return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Gaborone" });
}
