import { randomBytes } from "node:crypto";
import type { Db } from "../db/index.js";
import { migrate, seed } from "../db/migrate.js";
import { expireDemoAccounts } from "./customers.js";

/**
 * Housekeeping for the always-on public demo, so it runs for months unattended:
 *  - sandbox accounts are closed once they are a day old (expireDemoAccounts);
 *  - once a night the whole demo database is wiped and re-seeded, so the
 *    simulation's passages, plate images and audit rows never fill the disk.
 *    The audit log forbids UPDATE, DELETE and TRUNCATE on its rows, so the reset
 *    drops the schema and starts a fresh chain rather than editing history.
 */

/** Changes whenever the data is reset (or the process restarts); the simulation bridge watches it. */
let currentEpoch = randomBytes(6).toString("hex");
export const epoch = () => currentEpoch;

export async function resetDemoData(db: Db) {
  await db.exec("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  const applied = await migrate(db);
  await seed(db);
  currentEpoch = randomBytes(6).toString("hex");
  return { applied: applied.length, epoch: currentEpoch };
}

/** Milliseconds until the next hh:00 in Botswana (UTC+2, no daylight saving). */
export function msUntilBotswanaHour(hour: number, now = Date.now()): number {
  const local = new Date(now + 2 * 3600_000);
  const next = new Date(local);
  next.setUTCHours(hour, 0, 0, 0);
  if (next.getTime() <= local.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - local.getTime();
}

export interface MaintenanceOptions {
  /** Close sandbox accounts older than this; 0 disables. */
  demoAccountHours: number;
  /** Botswana hour (0-23) of the nightly reset; null disables. */
  resetHour: number | null;
  log: (msg: string, data?: Record<string, unknown>) => void;
}

export function scheduleMaintenance(db: Db, opts: MaintenanceOptions) {
  const timers: NodeJS.Timeout[] = [];
  let busy = false;
  const guarded = (name: string, fn: () => Promise<Record<string, unknown>>) => async () => {
    if (busy) return;
    busy = true;
    try {
      opts.log(name, await fn());
    } catch (err) {
      opts.log(`${name} failed`, { error: String(err) });
    } finally {
      busy = false;
    }
  };

  if (opts.demoAccountHours > 0) {
    const expire = guarded("demo accounts expired", async () => expireDemoAccounts(db, opts.demoAccountHours));
    const t = setInterval(expire, 15 * 60_000);
    t.unref();
    timers.push(t);
    const first = setTimeout(expire, 30_000);
    first.unref();
    timers.push(first);
  }

  if (opts.resetHour !== null) {
    const reset = guarded("nightly demo reset", async () => resetDemoData(db));
    const arm = () => {
      const t = setTimeout(async () => {
        await reset();
        arm();
      }, msUntilBotswanaHour(opts.resetHour!));
      t.unref();
      timers.push(t);
    };
    arm();
  }

  return () => timers.forEach((t) => clearTimeout(t));
}
