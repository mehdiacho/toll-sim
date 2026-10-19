import type { AddressInfo } from "node:net";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPgDb, createPgliteDb, type Db } from "../src/db/index.js";
import { migrate, seed } from "../src/db/migrate.js";
import { createMomoApp } from "../src/momo/app.js";
import { httpGateway } from "../src/payments/gateway.js";

export const ADMIN = "test-admin-key";
export const INGEST = "test-ingest-key";
export const SECRET = "test-webhook-secret";

export interface Harness {
  db: Db;
  baseUrl: string;
  momoUrl: string;
  request(method: string, path: string, body?: unknown, opts?: { key?: string | null; headers?: Record<string, string> }): Promise<{ status: number; body: any }>;
  close(): Promise<void>;
}

/**
 * PGlite by default. Set TEST_DATABASE_URL to run the same suite against a real
 * Postgres server; each test file then starts from an empty schema (files run
 * one at a time in that mode, see vitest.config.ts).
 */
async function testDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return createPgliteDb();
  const db = createPgDb(url);
  await db.exec("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  return db;
}

/**
 * A full stack per test file: in-memory Postgres (PGlite), the back office and
 * the mock payment service, both listening on real ports so callbacks travel
 * over HTTP exactly as they would in Docker.
 */
export async function startHarness(overrides: Record<string, string> = {}): Promise<Harness> {
  const db = await testDb();
  await migrate(db);
  await seed(db);

  const momo = createMomoApp({ secret: SECRET, callbackDelayMs: 50, retryBaseMs: 50 });
  await momo.listen({ port: 0, host: "127.0.0.1" });
  const momoUrl = `http://127.0.0.1:${(momo.server.address() as AddressInfo).port}`;

  // The back office must know its own URL before it starts, for callback URLs,
  // so reserve a port first.
  const probe = (await import("node:net")).createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const baseUrl = `http://127.0.0.1:${port}`;

  const config = loadConfig({
    ADMIN_API_KEY: ADMIN,
    INGEST_API_KEY: INGEST,
    MOMO_WEBHOOK_SECRET: SECRET,
    MOMO_BASE_URL: momoUrl,
    PUBLIC_BASE_URL: baseUrl,
    PORT: String(port),
    ...overrides,
  });
  const app = buildApp({ db, gateway: httpGateway(momoUrl), config });
  await app.listen({ port, host: "127.0.0.1" });

  return {
    db,
    baseUrl,
    momoUrl,
    async request(method, path, body, opts = {}) {
      const key = opts.key === undefined ? ADMIN : opts.key;
      const res = await fetch(baseUrl + path, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          ...opts.headers,
        },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    async close() {
      await app.close();
      await momo.close();
      await db.close();
    },
  };
}

let seq = 0;
/** Unique plate per call: B 123 ABC style. */
export function plate(): string {
  seq++;
  const letters = String.fromCharCode(65 + (seq % 26), 65 + ((seq / 26) % 26 | 0), 65 + ((Date.now() / 1000) % 26 | 0));
  return `B${String(100 + (seq % 900)).padStart(3, "0")}${letters}`;
}

export function eventId(): string {
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Account with one vehicle, optionally funded directly through the ledger. */
export async function accountWithVehicle(
  h: Harness,
  opts: { vehicleClass?: string; tagId?: string; balance?: number } = {},
) {
  const acc = await h.request("POST", "/accounts", { holder_name: "Kagiso Molefe", phone: "71234567" });
  const p = plate();
  const veh = await h.request("POST", `/accounts/${acc.body.id}/vehicles`, {
    plate: p,
    vehicle_class: opts.vehicleClass ?? "1",
    tag_id: opts.tagId,
  });
  if (opts.balance) await fund(h, acc.body.id, opts.balance);
  return { account: acc.body, vehicle: veh.body, plate: p };
}

/** Top up through the real flow (mock provider + signed callback) and wait for it. */
export async function fund(h: Harness, accountId: string, amount: number) {
  const t = await h.request("POST", `/accounts/${accountId}/topups`, {
    provider: "orange_money",
    amount_thebe: amount,
    msisdn: "72345678",
  });
  return waitForTopup(h, t.body.id);
}

export async function waitForTopup(h: Harness, id: string, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await h.request("GET", `/topups/${id}`);
    if (r.body.status !== "pending" || Date.now() > until) return r.body;
    await new Promise((res) => setTimeout(res, 25));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
