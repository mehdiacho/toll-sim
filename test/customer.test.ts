import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventId, INGEST, plate, startHarness, waitForTopup, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ EXPOSE_LOGIN_CODES: "1" });
});
afterAll(() => h.close());

let n = 0;
/** A fresh Botswana mobile number per call. */
const phone = () => `7${1 + (n++ % 6)}${String(Date.now() + n).slice(-6)}`;

const pub = (method: string, path: string, body?: unknown) => h.request(method, path, body, { key: null });
const as = (token: string) => (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
  h.request(method, path, body, { key: token, headers });

async function signUp(name = "Neo Kgosi") {
  const ph = phone();
  const code = (await pub("POST", "/auth/code", { phone: ph })).body.dev_code;
  const v = await pub("POST", "/auth/verify", { phone: ph, code, holder_name: name });
  return { phone: ph, token: v.body.token as string, account: v.body.account, me: as(v.body.token) };
}

const pass = (p: string, extra: Record<string, unknown> = {}) =>
  h.request(
    "POST",
    "/passages",
    { source_event_id: eventId(), gantry_id: "A1-G01", passed_at: new Date().toISOString(), vehicle_class: "1", plate: p, ...extra },
    { key: INGEST },
  );

describe("customer sign-in", () => {
  it("signs a new number up in two steps and keeps the code valid between them", async () => {
    const ph = phone();
    const sent = await pub("POST", "/auth/code", { phone: ph });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ sent: true, expires_in: 300 });
    expect(sent.body.dev_code).toMatch(/^\d{6}$/);

    const first = await pub("POST", "/auth/verify", { phone: ph, code: sent.body.dev_code });
    expect(first.body).toEqual({ needs_signup: true });
    const second = await pub("POST", "/auth/verify", { phone: ph, code: sent.body.dev_code, holder_name: "Lesego Dube" });
    expect(second.body).toMatchObject({ created: true, account: { holder_name: "Lesego Dube" } });
    expect(second.body.token).toBeTruthy();

    // The code is spent; signing in again needs a new one and finds the same account.
    expect((await pub("POST", "/auth/verify", { phone: ph, code: sent.body.dev_code })).body.error).toBe("code_expired");
    const code = (await pub("POST", "/auth/code", { phone: ph })).body.dev_code;
    const again = await pub("POST", "/auth/verify", { phone: ph, code });
    expect(again.body).toMatchObject({ created: false, account: { id: second.body.account.id } });

    const sms = (await h.request("GET", `/admin/outbox?kind=login_code`)).body;
    expect(sms.some((m: any) => m.recipient.endsWith(ph) && m.body.includes(code))).toBe(true);
  });

  it("locks a code after five wrong guesses", async () => {
    const ph = phone();
    const code = (await pub("POST", "/auth/code", { phone: ph })).body.dev_code;
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await pub("POST", "/auth/verify", { phone: ph, code: wrong })).status).toBe(401);
    expect((await pub("POST", "/auth/verify", { phone: ph, code })).body.error).toBe("too_many_attempts");
  });

  it("limits how many codes a number can ask for", async () => {
    const ph = phone();
    for (let i = 0; i < 5; i++) expect((await pub("POST", "/auth/code", { phone: ph })).status).toBe(200);
    expect((await pub("POST", "/auth/code", { phone: ph })).status).toBe(429);
  });

  it("rejects missing, made-up and signed-out sessions; an admin key is not a session", async () => {
    expect((await pub("GET", "/me")).status).toBe(401);
    expect((await h.request("GET", "/me", undefined, { key: "not-a-session" })).status).toBe(401);
    expect((await h.request("GET", "/me")).status).toBe(401); // admin key
    const { me } = await signUp();
    expect((await me("GET", "/me")).status).toBe(200);
    await me("POST", "/auth/logout");
    expect((await me("GET", "/me")).status).toBe(401);
  });

  it("does not hand out codes in the response unless configured to", async () => {
    const plain = await startHarness();
    try {
      const r = await plain.request("POST", "/auth/code", { phone: phone() }, { key: null });
      expect(r.status).toBe(200);
      expect(r.body.dev_code).toBeUndefined();
    } finally {
      await plain.close();
    }
  });
});

describe("customer app", () => {
  it("registers vehicles, tops up by mobile money and sees the trip and statement", async () => {
    const { me, account } = await signUp();
    const p = plate();
    const v = await me("POST", "/me/vehicles", { plate: p, vehicle_class: "1", tag_id: "SNEAKY-TAG" });
    expect(v.status).toBe(201);
    expect(v.body.tag_id).toBeNull();

    const t = await me("POST", "/me/topups", { provider: "orange_money", amount_thebe: 5000, msisdn: "72345678" }, { "idempotency-key": "k1" });
    expect(t.status).toBe(202);
    expect((await me("POST", "/me/topups", { provider: "orange_money", amount_thebe: 5000, msisdn: "72345678" }, { "idempotency-key": "k1" })).status).toBe(200);
    expect((await waitForTopup(h, t.body.id)).status).toBe("succeeded");
    expect((await me("GET", `/me/topups/${t.body.id}`)).body.status).toBe("succeeded");

    await pass(p);
    const home = (await me("GET", "/me")).body;
    expect(home.account).toMatchObject({ id: account.id, balance_thebe: 3500 });
    expect(home.vehicles).toHaveLength(1);
    expect(home.this_month).toMatchObject({ tolls: 1, spent_thebe: 1500 });

    const trips = (await me("GET", "/me/passages")).body;
    expect(trips[0]).toMatchObject({ plate_read: p, status: "charged", amount_thebe: 1500, gantry_name: expect.any(String) });
    const st = (await me("GET", "/me/statement")).body;
    expect(st.totals).toMatchObject({ topups_thebe: 5000, tolls_thebe: 1500 });
    expect(st.closing_balance_thebe).toBe(3500);
  });

  it("pays a violation, including one from before the plate was registered", async () => {
    const p = plate();
    const r = await pass(p); // nobody owns the plate yet: an unregistered-vehicle violation
    const { me } = await signUp();
    await me("POST", "/me/vehicles", { plate: p, vehicle_class: "1" });
    const mine = (await me("GET", "/me/violations")).body;
    expect(mine.map((x: any) => x.id)).toContain(r.body.violation_id);
    expect((await me("GET", "/me")).body.outstanding).toEqual({ violations: 1, owed_thebe: 1500 });

    expect((await me("POST", `/me/violations/${r.body.violation_id}/pay`)).body.error).toBe("insufficient_funds");
    const t = await me("POST", "/me/topups", { provider: "myzaka", amount_thebe: 2000, msisdn: "71234123" });
    await waitForTopup(h, t.body.id);
    // A top-up settles what it can on its own account; the unregistered one is paid by hand.
    const paid = await me("POST", `/me/violations/${r.body.violation_id}/pay`);
    expect(paid.body).toMatchObject({ status: "settled" });
    expect((await me("GET", "/me")).body).toMatchObject({ account: { balance_thebe: 500 }, outstanding: { violations: 0 } });
  });

  it("raises a dispute with evidence and follows it to a decision", async () => {
    const { me } = await signUp();
    const p = plate();
    await me("POST", "/me/vehicles", { plate: p, vehicle_class: "1" });
    const r = await pass(p); // no balance: insufficient-funds violation against this account
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const d = await me("POST", "/me/disputes", {
      passage_id: r.body.passage_id,
      reason: "not_my_vehicle",
      description: "My car was parked at home in Francistown all day.",
      evidence: [{ filename: "parked.png", data_b64: `data:image/png;base64,${PNG}` }],
    });
    expect(d.status).toBe(201);
    expect((await me("GET", "/me")).body.open_disputes).toBe(1);
    expect((await me("GET", "/me/passages")).body[0]).toMatchObject({ dispute_status: "open" });

    await h.request("POST", `/disputes/${d.body.id}/resolve`, { decision: "upheld", note: "Camera image shows a different car." });
    const mineNow = (await me("GET", `/me/disputes/${d.body.id}`)).body;
    expect(mineNow).toMatchObject({ status: "upheld", resolution_note: "Camera image shows a different car." });
    expect(mineNow.history).toBeUndefined();
    const notices = (await me("GET", "/me/notices")).body.map((x: any) => x.kind);
    expect(notices).toEqual(expect.arrayContaining(["dispute_received", "dispute_resolved"]));
    expect(notices).not.toContain("login_code");
  });

  it("keeps each motorist to their own data", async () => {
    const alice = await signUp("Alice");
    const bob = await signUp("Bob");
    const p = plate();
    const car = (await alice.me("POST", "/me/vehicles", { plate: p, vehicle_class: "1" })).body;
    const r = await pass(p);
    const d = (await alice.me("POST", "/me/disputes", { passage_id: r.body.passage_id, reason: "other", description: "Testing who can see this." })).body;
    const t = (await alice.me("POST", "/me/topups", { provider: "orange_money", amount_thebe: 1000, msisdn: "72345678" })).body;

    expect((await bob.me("GET", "/me/passages")).body).toEqual([]);
    expect((await bob.me("GET", "/me/violations")).body).toEqual([]);
    expect((await bob.me("GET", `/me/disputes/${d.id}`)).status).toBe(404);
    expect((await bob.me("GET", `/me/topups/${t.id}`)).status).toBe(404);
    expect((await bob.me("POST", `/me/violations/${r.body.violation_id}/pay`)).status).toBe(404);
    expect((await bob.me("GET", `/me/passages/${r.body.passage_id}/image`)).status).toBe(404);
    expect((await bob.me("POST", "/me/disputes", { passage_id: r.body.passage_id, reason: "other", description: "Not my passage at all." })).status).toBe(404);
    expect((await bob.me("DELETE", `/me/vehicles/${car.id}`)).status).toBe(404);
    expect((await alice.me("GET", "/me")).body.vehicles).toHaveLength(1);
  });
});
