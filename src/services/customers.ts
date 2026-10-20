import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Db, Queryable } from "../db/index.js";
import { AppError, badRequest, notFound } from "../errors.js";
import { maskMsisdn, normalizeBotswanaMsisdn } from "../identifiers.js";
import { createAccount, deactivateVehicle, getAccount, registerVehicle, setAccountStatus } from "./accounts.js";
import { audit } from "./audit.js";
import { enqueue } from "./outbox.js";

const CODE_TTL_SECONDS = 300;
const MAX_CODES_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

export const startLoginInput = z.object({ phone: z.string().min(7).max(20) });
export const verifyLoginInput = z.object({
  phone: z.string().min(7).max(20),
  code: z.string().regex(/^\d{6}$/),
  /** Needed only the first time, when no account has this phone yet. */
  holder_name: z.string().trim().min(2).max(200).optional(),
});
export const updateProfileInput = z.object({
  holder_name: z.string().trim().min(2).max(200).optional(),
  email: z.email().nullable().optional(),
});

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function phoneOrThrow(raw: string) {
  const phone = normalizeBotswanaMsisdn(raw);
  if (!phone) throw badRequest("invalid_phone", "enter a Botswana mobile number, e.g. 71 234 567");
  return phone;
}

/**
 * Text a 6-digit sign-in code. The same response whether or not the number has
 * an account, so the endpoint can't be used to find out who drives the A1.
 */
export async function startLogin(db: Db, rawPhone: string, exposeCode: boolean) {
  const phone = phoneOrThrow(rawPhone);
  return db.tx(async (q) => {
    const recent = await q.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM login_codes WHERE phone = $1 AND created_at > now() - interval '1 hour'",
      [phone],
    );
    if (recent.rows[0].n >= MAX_CODES_PER_HOUR) {
      throw new AppError(429, "too_many_codes", "too many codes requested; try again later");
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO login_codes (phone, code_hash, expires_at)
       VALUES ($1, '', now() + make_interval(secs => $2)) RETURNING id`,
      [phone, CODE_TTL_SECONDS],
    );
    // Salted with the row id, so equal codes never share a hash.
    await q.query("UPDATE login_codes SET code_hash = $2 WHERE id = $1", [rows[0].id, sha256(`${rows[0].id}:${code}`)]);
    await enqueue(q, {
      channel: "sms",
      recipient: phone,
      kind: "login_code",
      body: `${code} is your A1 Toll sign-in code. It expires in 5 minutes. Never share it; we will never ask for it.`,
    });
    return { sent: true, phone: maskMsisdn(phone), expires_in: CODE_TTL_SECONDS, ...(exposeCode ? { dev_code: code } : {}) };
  });
}

/**
 * Check a code and open a session. The first sign-in for a new number also
 * creates the account; without a holder_name it answers needs_signup and keeps
 * the code valid, so the app can ask for a name and send the same code again.
 */
export async function verifyLogin(db: Db, input: z.infer<typeof verifyLoginInput>, sessionDays: number) {
  const phone = phoneOrThrow(input.phone);
  const result = await db.tx(async (q) => {
    const { rows } = await q.query(
      `SELECT * FROM login_codes WHERE phone = $1 AND used_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [phone],
    );
    const login = rows[0];
    if (!login) return { error: new AppError(401, "code_expired", "that code has expired; ask for a new one") };
    if (login.attempts >= MAX_ATTEMPTS) return { error: new AppError(429, "too_many_attempts", "too many wrong codes; ask for a new one") };
    const expected = Buffer.from(login.code_hash, "hex");
    const given = Buffer.from(sha256(`${login.id}:${input.code}`), "hex");
    if (!timingSafeEqual(expected, given)) {
      // Count the failure even though the request fails: the attempt limit must survive.
      await q.query("UPDATE login_codes SET attempts = attempts + 1 WHERE id = $1", [login.id]);
      return { error: new AppError(401, "invalid_code", "that code is not right") };
    }
    const existing = await q.query(
      "SELECT id FROM accounts WHERE phone = $1 AND status <> 'closed' ORDER BY created_at LIMIT 1",
      [phone],
    );
    let accountId: string | undefined = existing.rows[0]?.id;
    if (!accountId && !input.holder_name) return { needs_signup: true as const };
    await q.query("UPDATE login_codes SET used_at = now() WHERE id = $1", [login.id]);
    return { accountId, login };
  });
  if ("error" in result) throw result.error;
  if ("needs_signup" in result) return { needs_signup: true };

  let accountId = result.accountId;
  let created = false;
  if (!accountId) {
    const account = await createAccount(db, { holder_name: input.holder_name!, phone }, `customer:${maskMsisdn(phone)}`);
    accountId = account.id;
    created = true;
  }
  const token = await issueSession(db, accountId!, sessionDays * 24, "customer.signed_in", { phone: maskMsisdn(phone), created });
  return { token, account: await getAccount(db, accountId!), created };
}

async function issueSession(db: Db, accountId: string, sessionHours: number, action: string, data: Record<string, unknown>) {
  const token = randomBytes(32).toString("base64url");
  await db.tx(async (q) => {
    await q.query(
      `INSERT INTO customer_sessions (token_hash, account_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))`,
      [sha256(token), accountId, Math.max(1, Math.round(sessionHours))],
    );
    await audit(q, `customer:${accountId}`, action, "account", accountId, data);
  });
  return token;
}

/** A vehicle the simulation has on the road right now. */
export interface DrivingVehicle {
  plate: string;
  vehicle_class: string;
}

/**
 * Public demo sign-in: a fresh sandbox account with no phone number, so nobody
 * types a real one into a site anyone can use. It is given, in order of preference:
 *   1. an unregistered vehicle that is driving in the live simulation right now,
 *      so the visitor can watch their own car reach the next gantry;
 *   2. a plate the simulation has recently caught driving unregistered, so the
 *      visitor lands on real trips and a fine to pay;
 *   3. a new plate with no history.
 * The account and its session last `hours` (see expireDemoAccounts).
 */
export async function demoSignIn(db: Db, hours: number, driving: DrivingVehicle[] = []) {
  const account = await createAccount(db, { holder_name: "Demo motorist" }, "demo");
  const tryPlates = async (candidates: DrivingVehicle[], limit: number) => {
    // Shuffle so two visitors arriving together don't race for the same plate.
    const list = [...candidates];
    for (let i = list.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [list[i], list[j]] = [list[j], list[i]];
    }
    for (const c of list.slice(0, limit)) {
      try {
        await registerVehicle(db, account.id, { plate: c.plate, vehicle_class: c.vehicle_class }, "demo");
        return c.plate;
      } catch (err: any) {
        if (!["plate_registered", "invalid_plate", "invalid_vehicle_class", "23505"].includes(err?.code)) throw err;
      }
    }
    return null;
  };

  let source: "live" | "violation" | "new" = "live";
  let plate = await tryPlates(driving, 8);
  if (!plate) {
    source = "violation";
    const { rows } = await db.query<DrivingVehicle>(
      `SELECT v.plate, p.charged_class AS vehicle_class
         FROM violations v JOIN passages p ON p.id = v.passage_id
        WHERE v.status = 'open' AND v.reason = 'unregistered_vehicle' AND v.plate IS NOT NULL
          AND p.charged_class IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM vehicles x WHERE x.active AND x.plate = v.plate)
        ORDER BY v.created_at DESC LIMIT 25`,
    );
    plate = await tryPlates(rows, 5);
  }
  while (!plate) {
    source = "new";
    const p = `B${randomInt(100, 1000)}${String.fromCharCode(...[0, 0, 0].map(() => 65 + randomInt(26)))}`;
    plate = await tryPlates([{ plate: p, vehicle_class: "1" }], 1);
  }
  const token = await issueSession(db, account.id, hours, "customer.demo_signed_in", { plate, source });
  return { token, account: await getAccount(db, account.id), created: true, demo: true, plate, plate_source: source, expires_in_hours: hours };
}

/**
 * Closes sandbox accounts older than `hours`. Nothing is deleted (the audit log
 * is append-only and hash-chained): sessions are revoked, vehicles deactivated so
 * their plates go back to the simulation, and the account is closed, each change
 * audited like any other.
 */
export async function expireDemoAccounts(db: Db, hours: number, actor = "system:demo-cleaner") {
  const { rows } = await db.query<{ id: string }>(
    `SELECT a.id FROM accounts a
      WHERE a.status <> 'closed' AND a.created_at < now() - make_interval(hours => $1)
        AND EXISTS (SELECT 1 FROM audit_log l
                     WHERE l.entity_type = 'account' AND l.entity_id = a.id::text
                       AND l.action = 'account.created' AND l.actor = 'demo')
      ORDER BY a.created_at LIMIT 500`,
    [Math.max(1, Math.round(hours))],
  );
  for (const { id } of rows) {
    await db.query("UPDATE customer_sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL", [id]);
    const { rows: vehicles } = await db.query<{ id: string }>("SELECT id FROM vehicles WHERE account_id = $1 AND active", [id]);
    for (const v of vehicles) await deactivateVehicle(db, v.id, actor);
    await setAccountStatus(db, id, { status: "closed", reason: `demo sandbox expired after ${hours} h` }, actor);
  }
  return { closed: rows.length };
}

/** The account behind a session token, or null. */
export async function sessionAccount(q: Queryable, token: string): Promise<string | null> {
  if (!token) return null;
  const { rows } = await q.query<{ account_id: string }>(
    `SELECT s.account_id FROM customer_sessions s JOIN accounts a ON a.id = s.account_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND a.status <> 'closed'`,
    [sha256(token)],
  );
  return rows[0]?.account_id ?? null;
}

export async function logout(q: Queryable, token: string) {
  await q.query("UPDATE customer_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [sha256(token)]);
}

export async function updateProfile(db: Db, accountId: string, input: z.infer<typeof updateProfileInput>) {
  return db.tx(async (q) => {
    const before = await getAccount(q, accountId);
    const { rows } = await q.query(
      `UPDATE accounts SET holder_name = coalesce($2, holder_name), email = CASE WHEN $4 THEN $3 ELSE email END
       WHERE id = $1 RETURNING *`,
      [accountId, input.holder_name ?? null, input.email ?? null, input.email !== undefined],
    );
    await audit(q, `customer:${accountId}`, "account.profile_updated", "account", accountId, {
      holder_name: input.holder_name !== undefined && input.holder_name !== before.holder_name ? input.holder_name : undefined,
      email_changed: input.email !== undefined && input.email !== before.email,
    });
    return rows[0];
  });
}

/** Home screen in one call: the account, its vehicles and what needs attention. */
export async function overview(q: Queryable, accountId: string) {
  const [account, vehicles, owed, disputes, month] = await Promise.all([
    getAccount(q, accountId),
    q.query("SELECT * FROM vehicles WHERE account_id = $1 AND active ORDER BY created_at", [accountId]),
    q.query<{ n: number; thebe: number }>(
      `SELECT count(*)::int AS n, coalesce(sum(amount_due_thebe + penalty_thebe), 0)::int AS thebe
       FROM violations v WHERE status = 'open' AND ${mine("v")}`,
      [accountId],
    ),
    q.query<{ n: number }>("SELECT count(*)::int AS n FROM disputes WHERE account_id = $1 AND status = 'open'", [accountId]),
    q.query<{ n: number; thebe: number }>(
      `SELECT count(*)::int AS n, coalesce(-sum(amount_thebe), 0)::int AS thebe FROM ledger_entries
       WHERE account_id = $1 AND kind = 'toll' AND created_at > date_trunc('month', now())`,
      [accountId],
    ),
  ]);
  return {
    account,
    vehicles: vehicles.rows,
    outstanding: { violations: owed.rows[0].n, owed_thebe: owed.rows[0].thebe },
    open_disputes: disputes.rows[0].n,
    this_month: { tolls: month.rows[0].n, spent_thebe: month.rows[0].thebe },
  };
}

/** Violations that are this account's to pay: billed to it, or on an unregistered plate it now owns. */
const mine = (v: string) =>
  `(${v}.account_id = $1 OR (${v}.account_id IS NULL AND ${v}.plate IN (SELECT plate FROM vehicles WHERE account_id = $1 AND active)))`;

export const myPassagesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.date().optional(),
});

export async function myPassages(q: Queryable, accountId: string, f: z.infer<typeof myPassagesQuery>) {
  const { rows } = await q.query(
    `SELECT p.id, p.passed_at, p.gantry_id, g.name AS gantry_name, p.plate_read, p.charged_class, p.detected_class,
            p.amount_thebe, p.status, p.match_method, p.class_mismatch,
            v.id AS violation_id, v.status AS violation_status, v.stage AS violation_stage,
            v.amount_due_thebe + v.penalty_thebe AS owed_thebe, v.due_by,
            d.id AS dispute_id, d.status AS dispute_status,
            EXISTS (SELECT 1 FROM plate_reviews r WHERE r.passage_id = p.id AND r.image IS NOT NULL) AS has_image
     FROM passages p
     JOIN gantries g ON g.id = p.gantry_id
     LEFT JOIN violations v ON v.passage_id = p.id
     LEFT JOIN LATERAL (SELECT id, status FROM disputes WHERE passage_id = p.id ORDER BY created_at DESC LIMIT 1) d ON true
     WHERE (p.account_id = $1 OR (v.id IS NOT NULL AND ${mine("v")}))
       AND ($2::timestamptz IS NULL OR p.passed_at < $2)
     ORDER BY p.passed_at DESC LIMIT $3`,
    [accountId, f.before ?? null, f.limit],
  );
  return rows;
}

export async function myViolations(q: Queryable, accountId: string) {
  const { rows } = await q.query(
    `SELECT v.*, v.amount_due_thebe + v.penalty_thebe AS owed_thebe, p.gantry_id, g.name AS gantry_name, p.passed_at,
            EXISTS (SELECT 1 FROM disputes d WHERE d.passage_id = v.passage_id AND d.status = 'open') AS disputed
     FROM violations v JOIN passages p ON p.id = v.passage_id JOIN gantries g ON g.id = p.gantry_id
     WHERE ${mine("v")}
     ORDER BY (v.status = 'open') DESC, v.created_at DESC LIMIT 200`,
    [accountId],
  );
  return rows;
}

export async function assertMyViolation(q: Queryable, accountId: string, violationId: string) {
  const { rows } = await q.query(`SELECT 1 FROM violations v WHERE v.id = $2 AND ${mine("v")}`, [accountId, violationId]);
  if (!rows[0]) throw notFound("violation");
}

export async function myNotices(q: Queryable, accountId: string) {
  // A notice goes out by SMS and by email; show it once.
  const { rows } = await q.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (kind, related_id, body) id, channel, kind, subject, body, related_type, related_id, created_at
       FROM outbox WHERE account_id = $1 AND kind <> 'login_code'
       ORDER BY kind, related_id, body, (channel = 'sms') DESC
     ) n ORDER BY created_at DESC LIMIT 100`,
    [accountId],
  );
  return rows;
}
