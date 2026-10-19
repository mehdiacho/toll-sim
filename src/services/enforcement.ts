import type { EnforcementPolicy } from "../config.js";
import type { Db, Queryable } from "../db/index.js";
import { audit } from "./audit.js";
import { bwDate, notify, pula } from "./outbox.js";
import { owed } from "./violations.js";

type Stage = "grace" | "notice" | "final_notice" | "referred";
const NEXT: Record<Stage, Stage | null> = { grace: "notice", notice: "final_notice", final_notice: "referred", referred: null };
const DAY = 86_400_000;

/** When a violation becomes due for a stage, counted from the end of its grace period. */
export function stageDueAt(dueBy: Date, stage: Stage, p: EnforcementPolicy): Date {
  const t = new Date(dueBy).getTime();
  if (stage === "notice") return new Date(t);
  if (stage === "final_notice") return new Date(t + p.finalNoticeDays * DAY);
  if (stage === "referred") return new Date(t + (p.finalNoticeDays + p.referralDays) * DAY);
  return new Date(0);
}

export interface EnforcementRun {
  at: string;
  checked: number;
  escalated: Record<Exclude<Stage, "grace">, number>;
  notices: number;
  skipped_disputed: number;
}

/**
 * Walk every open violation whose grace period is over up the ladder:
 * a notice with an admin fee, then a final notice with a late fee, then
 * referral, which puts the plate on the roadside hotlist. A violation under
 * an open dispute does not move. Each step is its own transaction, notice
 * and audit row included, so a run can stop half way and simply be run again;
 * a violation that missed several steps catches up in one run, one notice per
 * step, in order.
 *
 * `at` is the clock to judge against. It defaults to now; the simulation and
 * the tests pass a future date to fast-forward.
 */
export async function runEnforcement(db: Db, p: EnforcementPolicy, at = new Date(), actor = "enforcement"): Promise<EnforcementRun> {
  const { rows } = await db.query<{ id: string; disputed: boolean }>(
    `SELECT v.id, EXISTS (SELECT 1 FROM disputes d WHERE d.passage_id = v.passage_id AND d.status = 'open') AS disputed
     FROM violations v
     WHERE v.status = 'open' AND v.stage <> 'referred' AND v.due_by <= $1
     ORDER BY v.due_by LIMIT 10000`,
    [at],
  );
  const run: EnforcementRun = {
    at: at.toISOString(),
    checked: rows.length,
    escalated: { notice: 0, final_notice: 0, referred: 0 },
    notices: 0,
    skipped_disputed: 0,
  };
  for (const { id, disputed } of rows) {
    if (disputed) {
      run.skipped_disputed++;
      continue;
    }
    for (;;) {
      const step = await db.tx((q) => escalateOnce(q, id, p, at, actor));
      if (!step) break;
      run.escalated[step.stage as Exclude<Stage, "grace">]++;
      run.notices += step.notices;
    }
  }
  return run;
}

async function escalateOnce(q: Queryable, id: string, p: EnforcementPolicy, at: Date, actor: string) {
  const { rows } = await q.query(
    `SELECT v.*, p.gantry_id, p.passed_at, g.name AS gantry_name,
            EXISTS (SELECT 1 FROM disputes d WHERE d.passage_id = v.passage_id AND d.status = 'open') AS disputed
     FROM violations v JOIN passages p ON p.id = v.passage_id JOIN gantries g ON g.id = p.gantry_id
     WHERE v.id = $1 FOR UPDATE OF v`,
    [id],
  );
  const v = rows[0];
  if (!v || v.status !== "open" || v.disputed) return null;
  const next = NEXT[v.stage as Stage];
  if (!next || stageDueAt(v.due_by, next, p) > at) return null;

  const fee = next === "notice" ? p.adminFeeThebe : next === "final_notice" ? p.lateFeeThebe : 0;
  const { rows: updated } = await q.query(
    `UPDATE violations SET stage = $2, penalty_thebe = penalty_thebe + $3, stage_changed_at = $4 WHERE id = $1 RETURNING *`,
    [id, next, fee, at],
  );
  const after = { ...v, ...updated[0] };
  const sent = await notify(q, { accountId: v.account_id, plate: v.plate }, noticeFor(after, next, fee, p));
  await audit(q, actor, "violation.escalated", "violation", id, {
    from: v.stage,
    to: next,
    fee_thebe: fee,
    penalty_thebe: after.penalty_thebe,
    owed_thebe: owed(after),
    notices: sent.map((m) => m.channel),
  });
  return { stage: next, notices: sent.length };
}

function noticeFor(v: any, stage: Stage, fee: number, p: EnforcementPolicy) {
  const ref = String(v.id).slice(0, 8).toUpperCase();
  const what = `the passage of ${v.plate ?? "your vehicle"} through ${v.gantry_name} (${v.gantry_id}) on ${bwDate(v.passed_at)}`;
  const total = pula(owed(v));
  const base = { relatedType: "violation", relatedId: v.id };
  if (stage === "notice") {
    const by = bwDate(stageDueAt(v.due_by, "final_notice", p));
    return {
      ...base,
      kind: "violation_notice",
      subject: `Unpaid A1 toll, ref ${ref}`,
      body:
        `The toll of ${pula(v.amount_due_thebe)} for ${what} is unpaid and the grace period has ended. ` +
        `An admin fee of ${pula(fee)} has been added: ${total} is now due. Pay by ${by} in the A1 Toll app, ` +
        `or top up and it is paid automatically. If you think this is wrong, dispute it in the app; ` +
        `nothing further happens while a dispute is open. Ref ${ref}.`,
    };
  }
  if (stage === "final_notice") {
    const by = bwDate(stageDueAt(v.due_by, "referred", p));
    return {
      ...base,
      kind: "violation_final_notice",
      subject: `FINAL NOTICE: unpaid A1 toll, ref ${ref}`,
      body:
        `Final notice for ${what}. A late fee of ${pula(fee)} has been added: ${total} is now due. ` +
        `If it is not paid or disputed by ${by}, the vehicle will be referred for roadside enforcement. Ref ${ref}.`,
    };
  }
  return {
    ...base,
    kind: "violation_referred",
    subject: `Referred for enforcement, ref ${ref}`,
    body:
      `${total} for ${what} remains unpaid and the vehicle has been referred for roadside enforcement. ` +
      `Paying in the A1 Toll app clears the referral immediately. Ref ${ref}.`,
  };
}

/** Plates with referred violations, for patrol units and gantry alerts. */
export async function hotlist(q: Queryable) {
  const { rows } = await q.query(
    `SELECT v.plate,
            count(*)::int                                          AS violations,
            sum(v.amount_due_thebe + v.penalty_thebe)::int         AS owed_thebe,
            min(p.passed_at)                                       AS oldest_passage,
            min(v.stage_changed_at)                                AS referred_since,
            bool_or(v.account_id IS NULL)                          AS unregistered,
            (SELECT max(p2.passed_at) FROM passages p2 WHERE p2.plate_read = v.plate) AS last_seen
     FROM violations v JOIN passages p ON p.id = v.passage_id
     WHERE v.status = 'open' AND v.stage = 'referred' AND v.plate IS NOT NULL
     GROUP BY v.plate ORDER BY owed_thebe DESC`,
  );
  return rows;
}

/** Is this plate on the hotlist? Called for every plate a gantry reads. */
export async function hotlistHit(q: Queryable, plate: string) {
  const { rows } = await q.query<{ violations: number; owed_thebe: number }>(
    `SELECT count(*)::int AS violations, coalesce(sum(amount_due_thebe + penalty_thebe), 0)::int AS owed_thebe
     FROM violations WHERE plate = $1 AND status = 'open' AND stage = 'referred'`,
    [plate],
  );
  return rows[0].violations ? rows[0] : null;
}

/** Run the ladder every `minutes` (0 = never; then it runs only via POST /admin/run-enforcement). Returns a stop function. */
export function scheduleEnforcement(db: Db, p: EnforcementPolicy, minutes: number, log: (run: EnforcementRun) => void) {
  if (minutes <= 0) return () => {};
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      log(await runEnforcement(db, p));
    } finally {
      running = false;
    }
  }, minutes * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
