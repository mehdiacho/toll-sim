import type { Queryable } from "../db/index.js";
import type { PlazaStats } from "../live.js";
import { plazaSummary } from "./plazas.js";

export interface DashboardOptions {
  /** Start of "today" for the plaza takings. */
  since?: Date;
  /** What the simulation reports right now: lanes open, queues, waits. */
  live?: { stats: Record<string, PlazaStats>; lanes_open: Record<string, { N: number[]; S: number[] }>; live: boolean };
}

/**
 * One snapshot for the operations dashboard. The time series is keyed on
 * passed_at (the gantry's clock), not received_at, so a simulation running on
 * its own clock still draws a sensible chart; the window ends at the newest
 * passage rather than at now().
 */
export async function dashboardSnapshot(q: Queryable, windowMinutes = 60, opts: DashboardOptions = {}) {
  const [totals, gantries, classes, series, recent, topups, violations, audit, reviews, disputes, enforcement] = await Promise.all([
    q.query(`
      SELECT count(*)::int                                                    AS passages,
             count(*) FILTER (WHERE status = 'charged')::int                  AS charged,
             count(*) FILTER (WHERE status = 'unpaid')::int                   AS unpaid,
             count(*) FILTER (WHERE status = 'review')::int                   AS in_review,
             count(*) FILTER (WHERE status = 'declined')::int                 AS declined,
             count(*) FILTER (WHERE match_method = 'manual')::int             AS by_review,
             count(*) FILTER (WHERE match_method = 'tag')::int                AS by_tag,
             count(*) FILTER (WHERE match_method = 'plate')::int              AS by_plate,
             count(*) FILTER (WHERE class_mismatch)::int                      AS class_mismatch,
             coalesce(sum(amount_thebe) FILTER (WHERE status = 'charged'), 0)::bigint AS revenue_thebe,
             coalesce(sum(amount_thebe) FILTER (WHERE status = 'unpaid'), 0)::bigint  AS unpaid_thebe,
             max(passed_at)                                                   AS last_passed_at
      FROM passages`),
    q.query(`
      SELECT g.id, g.name, g.km,
             count(p.id)::int                                                 AS passages,
             count(p.id) FILTER (WHERE p.status = 'unpaid')::int              AS unpaid,
             coalesce(sum(p.amount_thebe) FILTER (WHERE p.status = 'charged'), 0)::bigint AS revenue_thebe
      FROM gantries g LEFT JOIN passages p ON p.gantry_id = g.id
      GROUP BY g.id ORDER BY g.km`),
    q.query(`
      SELECT c.code, c.name, count(p.id)::int AS passages
      FROM vehicle_classes c LEFT JOIN passages p ON p.charged_class = c.code
      GROUP BY c.code, c.name ORDER BY c.code`),
    q.query(
      `WITH last AS (SELECT max(passed_at) AS t FROM passages)
       SELECT date_trunc('minute', p.passed_at)                               AS minute,
              count(*)::int                                                   AS passages,
              count(*) FILTER (WHERE p.status = 'unpaid')::int                AS unpaid,
              coalesce(sum(p.amount_thebe) FILTER (WHERE p.status = 'charged'), 0)::bigint AS revenue_thebe
       FROM passages p, last
       WHERE p.passed_at > last.t - make_interval(mins => $1::int)
       GROUP BY 1 ORDER BY 1`,
      [windowMinutes],
    ),
    q.query(`
      SELECT p.passed_at, p.gantry_id, p.plate_read, p.match_method, p.charged_class,
             p.amount_thebe, p.status, p.class_mismatch, v.reason AS violation_reason
      FROM passages p LEFT JOIN violations v ON v.passage_id = p.id
      ORDER BY p.passed_at DESC, p.received_at DESC LIMIT 25`),
    q.query(`
      SELECT provider,
             count(*)::int                                                    AS count,
             count(*) FILTER (WHERE status = 'succeeded')::int                AS succeeded,
             count(*) FILTER (WHERE status = 'failed')::int                   AS failed,
             count(*) FILTER (WHERE status = 'pending')::int                  AS pending,
             coalesce(sum(amount_thebe) FILTER (WHERE status = 'succeeded'), 0)::bigint AS amount_thebe
      FROM topups GROUP BY provider ORDER BY provider`),
    q.query(`
      SELECT status, reason, count(*)::int AS count, coalesce(sum(amount_due_thebe), 0)::bigint AS amount_thebe
      FROM violations GROUP BY status, reason ORDER BY status, reason`),
    q.query(`SELECT count(*)::int AS entries, max(at) AS last_at FROM audit_log`),
    q.query(`
      SELECT count(*) FILTER (WHERE status = 'open')::int                     AS open,
             count(*) FILTER (WHERE decision = 'confirmed')::int              AS confirmed,
             count(*) FILTER (WHERE decision = 'corrected')::int              AS corrected,
             count(*) FILTER (WHERE decision = 'unreadable')::int             AS unreadable
      FROM plate_reviews`),
    q.query(`
      SELECT count(*) FILTER (WHERE status = 'open')::int                     AS open,
             count(*) FILTER (WHERE status = 'upheld')::int                   AS upheld,
             count(*) FILTER (WHERE status = 'rejected')::int                 AS rejected,
             coalesce(sum(refund_thebe), 0)::bigint                           AS refunded_thebe,
             min(created_at) FILTER (WHERE status = 'open')                   AS oldest_open
      FROM disputes`),
    q.query(`
      SELECT count(*) FILTER (WHERE stage = 'grace')::int                     AS grace,
             count(*) FILTER (WHERE stage = 'notice')::int                    AS notice,
             count(*) FILTER (WHERE stage = 'final_notice')::int              AS final_notice,
             count(*) FILTER (WHERE stage = 'referred')::int                  AS referred,
             count(DISTINCT plate) FILTER (WHERE stage = 'referred')::int     AS hotlist_plates,
             coalesce(sum(amount_due_thebe + penalty_thebe), 0)::bigint       AS owed_thebe,
             coalesce(sum(penalty_thebe), 0)::bigint                          AS penalties_thebe
      FROM violations WHERE status = 'open'`),
  ]);

  // Plazas: today's takings from the database, the live picture from the simulation.
  const plazas = (await plazaSummary(q, opts.since ?? new Date(Date.now() - 24 * 3600_000))).map((p) => {
    const st = opts.live?.live ? opts.live.stats[p.id] : undefined;
    const open = opts.live?.live ? opts.live.lanes_open[p.id] : undefined;
    return {
      ...p,
      lanes_open: open ?? null,
      open: st?.open ?? (open ? { N: open.N.length, S: open.S.length } : null),
      queue: st?.queue ?? null,
      wait_s: st?.wait_s ?? null,
    };
  });

  // pg returns bigint as string; the dashboard wants numbers (all well inside 2^53).
  const num = (rows: Record<string, any>[]) =>
    rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k.endsWith("_thebe") ? Number(v) : v])));

  return {
    generated_at: new Date().toISOString(),
    totals: num(totals.rows)[0],
    gantries: num(gantries.rows).map((g) => ({ ...g, km: Number(g.km) })),
    classes: classes.rows,
    series: num(series.rows),
    recent: recent.rows,
    topups: num(topups.rows),
    violations: num(violations.rows),
    audit: audit.rows[0],
    reviews: reviews.rows[0],
    disputes: num(disputes.rows)[0],
    enforcement: num(enforcement.rows)[0],
    plazas,
  };
}
