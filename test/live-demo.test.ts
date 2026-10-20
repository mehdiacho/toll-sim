import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expireDemoAccounts } from "../src/services/customers.js";
import { epoch, msUntilBotswanaHour, resetDemoData } from "../src/services/maintenance.js";
import { ADMIN, INGEST, startHarness, type Harness } from "./harness.js";

const BASE = "/projects/toll-sim/live";

const frame = (over: Record<string, unknown> = {}) => ({
  t: 100,
  clock: "2026-10-20T08:00:00+02:00",
  vehicles: [
    [1, 1000, 2000, 90, 250],
    [2, 1500, 2500, 270, 300],
  ],
  // vehicle 1 is a registered fleet car, vehicle 2 is driving unregistered
  spawn: [
    [1, "B111AAA", "1", 1],
    [2, "B222LIV", "2", 0],
  ],
  events: [
    { vid: 1, gantry: "A1-G01", dir: "N", plate: "B111AAA", status: "charged", amount_thebe: 1500, reason: null, match: "plate" },
  ],
  ...over,
});

describe("live feed", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(() => h.close());

  it("refuses frames without the ingest or admin key", async () => {
    expect((await h.request("POST", "/live/frame", frame(), { key: null })).status).toBe(401);
    expect((await h.request("POST", "/live/frame", frame(), { key: "wrong" })).status).toBe(401);
  });

  it("is not live before the first frame", async () => {
    const r = await h.request("GET", "/live/snapshot", undefined, { key: null });
    expect(r.status).toBe(200);
    expect(r.body.live).toBe(false);
    expect(r.body.frame).toBeNull();
  });

  it("rejects a malformed frame", async () => {
    const r = await h.request("POST", "/live/frame", { t: 1, vehicles: [[1, 2]] }, { key: INGEST });
    expect(r.status).toBe(400);
  });

  it("accepts a frame from the ingest key and serves it in the snapshot", async () => {
    const r = await h.request("POST", "/live/frame", frame(), { key: INGEST });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect((await h.request("POST", "/live/frame", frame({ t: 102 }), { key: ADMIN })).status).toBe(200);

    const res = await fetch(h.baseUrl + "/live/snapshot");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const snap = await res.json();
    expect(snap.live).toBe(true);
    expect(snap.frame.vehicles).toHaveLength(2);
    expect(snap.registry).toContainEqual([2, "B222LIV", "2", 0]);
    expect(snap.recent.length).toBeGreaterThan(0);
  });

  it("sends security headers", async () => {
    const res = await fetch(h.baseUrl + "/health");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
  });

  it("keeps demo sign-in off unless enabled", async () => {
    expect((await h.request("POST", "/auth/demo", undefined, { key: null })).status).toBe(404);
  });

  it("refuses oversized bodies on public routes", async () => {
    const big = JSON.stringify({ phone: "71234567", pad: "x".repeat(1_100_000) });
    const r = await fetch(h.baseUrl + "/auth/code", { method: "POST", headers: { "content-type": "application/json" }, body: big });
    expect(r.status).toBe(413);
  });
});

describe("demo sign-in", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ DEMO_SIGNIN: "1", DEMO_ACCOUNT_HOURS: "24" });
  });
  afterAll(() => h.close());

  it("does not offer phone sign-in on the public demo", async () => {
    const opts = await h.request("GET", "/auth/options", undefined, { key: null });
    expect(opts.body).toMatchObject({ demo: true, sms: false, demo_hours: 24 });
    expect((await h.request("POST", "/auth/code", { phone: "71234567" }, { key: null })).status).toBe(404);
  });

  it("hands out a sandbox account with a new plate when the simulation is quiet", async () => {
    const r = await h.request("POST", "/auth/demo", undefined, { key: null });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(r.body.account.phone).toBeNull();
    expect(r.body.plate_source).not.toBe("live");
    const me = await h.request("GET", "/me", undefined, { key: r.body.token });
    expect(me.status).toBe(200);
    expect(me.body.vehicles.map((v: any) => v.plate)).toContain(r.body.plate);
  });

  it("prefers an unregistered vehicle driving in the live simulation", async () => {
    await h.request("POST", "/live/frame", frame(), { key: INGEST });
    const r = await h.request("POST", "/auth/demo", undefined, { key: null });
    expect(r.status).toBe(200);
    expect(r.body.plate_source).toBe("live");
    expect(r.body.plate).toBe("B222LIV");
    const me = await h.request("GET", "/me", undefined, { key: r.body.token });
    expect(me.body.vehicles[0]).toMatchObject({ plate: "B222LIV", vehicle_class: "2" });

    // That plate is taken now, so the next visitor gets another one.
    const next = await h.request("POST", "/auth/demo", undefined, { key: null });
    expect(next.body.plate).not.toBe("B222LIV");
  });

  it("closes sandbox accounts after the time limit without deleting anything", async () => {
    const r = await h.request("POST", "/auth/demo", undefined, { key: null });
    const id = r.body.account.id;
    const auditBefore = (await h.db.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log")).rows[0].n;

    expect((await expireDemoAccounts(h.db, 24)).closed).toBe(0);
    await h.db.query("UPDATE accounts SET created_at = now() - interval '25 hours' WHERE id = $1", [id]);
    const out = await expireDemoAccounts(h.db, 24);
    expect(out.closed).toBeGreaterThanOrEqual(1);

    expect((await h.request("GET", `/accounts/${id}`)).body.status).toBe("closed");
    expect((await h.request("GET", "/me", undefined, { key: r.body.token })).status).toBe(401);
    const vehicles = (await h.request("GET", `/accounts/${id}/vehicles`)).body;
    expect(vehicles.every((v: any) => !v.active)).toBe(true);

    const auditAfter = (await h.db.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log")).rows[0].n;
    expect(auditAfter).toBeGreaterThan(auditBefore);
    expect((await h.request("GET", "/audit/verify")).body.ok).toBe(true);

    // Accounts opened by an operator are never touched.
    const acc = await h.request("POST", "/accounts", { holder_name: "Real customer" });
    await h.db.query("UPDATE accounts SET created_at = now() - interval '25 hours' WHERE id = $1", [acc.body.id]);
    await expireDemoAccounts(h.db, 24);
    expect((await h.request("GET", `/accounts/${acc.body.id}`)).body.status).toBe("active");
  });

  it("serves the motorist app with the demo notice and simulated providers", async () => {
    const html = await (await fetch(h.baseUrl + "/app")).text();
    expect(html).toContain("Not affiliated with the Government of Botswana");
    expect(html).toContain("(simulated)");
  });
});

describe("BASE_PATH", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ BASE_PATH: BASE + "/", PUBLIC_DASHBOARD: "1" });
  });
  afterAll(() => h.close());

  it("answers health under the prefix and at the root", async () => {
    const a = await fetch(h.baseUrl + BASE + "/health");
    expect(a.status).toBe(200);
    expect((await a.json()).ok).toBe(true);
    expect((await fetch(h.baseUrl + "/health")).status).toBe(200);
  });

  it("routes API calls under the prefix", async () => {
    const r = await h.request("GET", BASE + "/gantries");
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThan(0);
    expect((await h.request("GET", BASE + "/gantries", undefined, { key: null })).status).toBe(401);
    expect((await h.request("POST", BASE + "/live/frame", frame(), { key: INGEST })).status).toBe(200);
    const snap = await h.request("GET", BASE + "/live/snapshot?x=1", undefined, { key: null });
    expect(snap.body.live).toBe(true);
    expect((await h.request("GET", BASE + "/dashboard/data", undefined, { key: null })).status).toBe(200);
  });

  it("redirects the bare prefix to the landing page", async () => {
    const r = await fetch(h.baseUrl + BASE, { redirect: "manual" });
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe(BASE + "/");
    const landing = await fetch(h.baseUrl + BASE + "/");
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain('href="dashboard"');
  });

  it("rewrites the pages' root-relative URLs onto the prefix", async () => {
    const disputes = await (await fetch(h.baseUrl + BASE + "/dashboard/disputes")).text();
    expect(disputes).toContain(`href="${BASE}/dashboard"`);
    expect(disputes).not.toContain('href="/dashboard"');
    expect(disputes).toContain(`var B=${JSON.stringify(BASE)};window.TOLL_BASE=B`);
    expect(disputes).toContain("Independent demo with synthetic data.");

    const app = await (await fetch(h.baseUrl + BASE + "/app")).text();
    expect(app).toContain(`href="${BASE}/app/manifest.webmanifest"`);
    const manifest = await (await fetch(h.baseUrl + BASE + "/app/manifest.webmanifest")).json();
    expect(manifest.start_url).toBe(BASE + "/app");

    const live = await (await fetch(h.baseUrl + BASE + "/live")).text();
    expect(live).toContain("Independent demo with synthetic data.");
  });
});

describe("nightly reset", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(() => h.close());

  it("wipes the demo data, keeps the schema and starts a fresh audit chain", async () => {
    await h.request("POST", "/accounts", { holder_name: "Gone tomorrow" });
    const before = epoch();
    const out = await resetDemoData(h.db);
    expect(out.epoch).not.toBe(before);
    expect((await h.request("GET", "/health")).body.epoch).toBe(out.epoch);
    const n = (await h.db.query<{ n: number }>("SELECT count(*)::int AS n FROM accounts")).rows[0].n;
    expect(n).toBe(0);
    expect((await h.request("GET", "/gantries")).body.length).toBeGreaterThan(0);
    expect((await h.request("POST", "/accounts", { holder_name: "Fresh" })).status).toBe(201);
    expect((await h.request("GET", "/audit/verify")).body.ok).toBe(true);
  });

  it("schedules the reset for the next Botswana hour", () => {
    // 2026-10-20 00:30 UTC is 02:30 in Gaborone: 03:00 is 30 minutes away.
    const now = Date.UTC(2026, 9, 20, 0, 30);
    expect(msUntilBotswanaHour(3, now)).toBe(30 * 60_000);
    // 01:30 UTC is 03:30 local: the next 03:00 is tomorrow.
    expect(msUntilBotswanaHour(3, Date.UTC(2026, 9, 20, 1, 30))).toBe(23.5 * 3600_000);
  });
});
