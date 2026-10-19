import type { Queryable } from "../db/index.js";

/**
 * Append a row to the audit log. Call it inside the same transaction as the
 * change it records, so a rolled-back change leaves no audit row and a
 * committed one always has one.
 */
export async function audit(
  q: Queryable,
  actor: string,
  action: string,
  entityType: string,
  entityId: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  await q.query(
    "INSERT INTO audit_log (actor, action, entity_type, entity_id, data) VALUES ($1, $2, $3, $4, $5)",
    [actor, action, entityType, entityId, JSON.stringify(data)],
  );
}

export interface ChainVerification {
  ok: boolean;
  rows: number;
  /** First seq whose hash or link does not match, when ok is false. */
  brokenAt?: number;
  headHash?: string;
}

/** Recompute every hash in the chain and check each row links to the one before. */
export async function verifyAuditChain(q: Queryable): Promise<ChainVerification> {
  const { rows } = await q.query<{ seq: number; hash: string; ok: boolean }>(`
    SELECT seq, hash,
           hash = audit_row_digest(prev_hash, at, actor, action, entity_type, entity_id, data)
           AND prev_hash = coalesce(lag(hash) OVER (ORDER BY seq), repeat('0', 64))
           AND seq = row_number() OVER (ORDER BY seq) AS ok
    FROM audit_log
    ORDER BY seq`);
  const broken = rows.find((r) => !r.ok);
  return {
    ok: !broken,
    rows: rows.length,
    brokenAt: broken?.seq,
    headHash: rows.at(-1)?.hash,
  };
}
