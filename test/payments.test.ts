import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signCallback } from "../src/payments/gateway.js";
import {
  accountWithVehicle,
  eventId,
  INGEST,
  plate,
  SECRET,
  sleep,
  startHarness,
  waitForTopup,
  type Harness,
} from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());

async function newAccount() {
  return (await h.request("POST", "/accounts", { holder_name: "Neo Sebego" })).body;
}

const balance = async (id: string) => (await h.request("GET", `/accounts/${id}`)).body.balance_thebe;

describe("top-ups", () => {
  it.each([
    ["orange_money", { msisdn: "72000001" }, /^OM/],
    ["myzaka", { msisdn: "+267 75 123 456" }, /^MZ/],
    ["smega", { msisdn: "26773123456" }, /^SM/],
    ["card", { card_token: "tok_visa_4242" }, /^CD/],
  ])("%s: pending at once, credited when the callback lands", async (provider, payer, refPattern) => {
    const acc = await newAccount();
    const r = await h.request("POST", `/accounts/${acc.id}/topups`, { provider, amount_thebe: 20000, ...payer });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe("pending");
    expect(r.body.payer).not.toMatch(/\d{8}/); // never store the full wallet number
    const done = await waitForTopup(h, r.body.id);
    expect(done.status).toBe("succeeded");
    expect(done.provider_ref).toMatch(refPattern);
    expect(await balance(acc.id)).toBe(20000);
  });

  it.each([
    ["orange_money", { msisdn: "71230000" }, "insufficient_wallet_balance"],
    ["myzaka", { msisdn: "71231111" }, "customer_cancelled"],
    ["card", { card_token: "tok_declined" }, "card_declined"],
  ])("%s: a failed payment credits nothing", async (provider, payer, reason) => {
    const acc = await newAccount();
    const r = await h.request("POST", `/accounts/${acc.id}/topups`, { provider, amount_thebe: 5000, ...payer });
    const done = await waitForTopup(h, r.body.id);
    expect(done.status).toBe("failed");
    expect(done.failure_reason).toBe(reason);
    expect(await balance(acc.id)).toBe(0);
  });

  it("validates amount and payer", async () => {
    const acc = await newAccount();
    const post = (body: object) => h.request("POST", `/accounts/${acc.id}/topups`, body);
    expect((await post({ provider: "orange_money", amount_thebe: 500, msisdn: "72000001" })).body.error).toBe("amount_out_of_range");
    expect((await post({ provider: "smega", amount_thebe: 5000, msisdn: "3912345" })).body.error).toBe("invalid_msisdn");
    expect((await post({ provider: "card", amount_thebe: 5000 })).body.error).toBe("card_token_required");
    expect((await post({ provider: "paypal", amount_thebe: 5000 })).status).toBe(400);
  });

  it("replays a request with the same Idempotency-Key instead of charging twice", async () => {
    const acc = await newAccount();
    const body = { provider: "orange_money", amount_thebe: 5000, msisdn: "72000002" };
    const headers = { "idempotency-key": `idem-${Date.now()}` };
    const a = await h.request("POST", `/accounts/${acc.id}/topups`, body, { headers });
    const b = await h.request("POST", `/accounts/${acc.id}/topups`, body, { headers });
    expect(a.status).toBe(202);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    await waitForTopup(h, a.body.id);
    expect(await balance(acc.id)).toBe(5000);
  });

  it("rejects callbacks with a bad signature and ignores repeats of a good one", async () => {
    const acc = await newAccount();
    const t = await h.request("POST", `/accounts/${acc.id}/topups`, {
      provider: "orange_money",
      amount_thebe: 7000,
      msisdn: "72000003",
    });
    const done = await waitForTopup(h, t.body.id);
    expect(done.status).toBe("succeeded");

    const body = JSON.stringify({
      reference: t.body.id,
      provider_ref: done.provider_ref,
      status: "succeeded",
      amount_thebe: 7000,
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const forged = await h.request("POST", "/payments/callbacks/orange_money", body, {
      key: null,
      headers: { "x-momo-timestamp": ts, "x-momo-signature": signCallback("wrong-secret", ts, body) },
    });
    expect(forged.status).toBe(401);

    const replay = await h.request("POST", "/payments/callbacks/orange_money", body, {
      key: null,
      headers: { "x-momo-timestamp": ts, "x-momo-signature": signCallback(SECRET, ts, body) },
    });
    expect(replay.status).toBe(200);
    expect(replay.body.applied).toBe(false);
    expect(await balance(acc.id)).toBe(7000);
  });

  it("refuses to credit an amount different from the one requested", async () => {
    const acc = await newAccount();
    // A wallet ending 9999 never gets a callback, so we can send our own.
    const t = await h.request("POST", `/accounts/${acc.id}/topups`, {
      provider: "smega",
      amount_thebe: 5000,
      msisdn: "71239999",
    });
    await sleep(100);
    const ref = (await h.request("GET", `/topups/${t.body.id}`)).body.provider_ref;
    const body = JSON.stringify({ reference: t.body.id, provider_ref: ref, status: "succeeded", amount_thebe: 500000 });
    const ts = String(Math.floor(Date.now() / 1000));
    await h.request("POST", "/payments/callbacks/smega", body, {
      key: null,
      headers: { "x-momo-timestamp": ts, "x-momo-signature": signCallback(SECRET, ts, body) },
    });
    const after = (await h.request("GET", `/topups/${t.body.id}`)).body;
    expect(after.status).toBe("failed");
    expect(after.failure_reason).toMatch(/^amount_mismatch/);
    expect(await balance(acc.id)).toBe(0);
  });

  it("reconciliation recovers a payment whose callback was lost", async () => {
    const acc = await newAccount();
    const t = await h.request("POST", `/accounts/${acc.id}/topups`, {
      provider: "myzaka",
      amount_thebe: 12000,
      msisdn: "75559999",
    });
    await sleep(300);
    expect((await h.request("GET", `/topups/${t.body.id}`)).body.status).toBe("pending");
    const rec = await h.request("POST", "/admin/reconcile-topups", { older_than_seconds: 0 });
    expect(rec.body.succeeded).toBeGreaterThanOrEqual(1);
    expect((await h.request("GET", `/topups/${t.body.id}`)).body.status).toBe("succeeded");
    expect(await balance(acc.id)).toBe(12000);
  });
});

describe("violations", () => {
  it("a top-up settles open violations oldest first", async () => {
    const { account, plate: p } = await accountWithVehicle(h, { vehicleClass: "2" });
    for (const g of ["A1-G01", "A1-G02", "A1-G03"]) {
      const r = await h.request(
        "POST",
        "/passages",
        { source_event_id: eventId(), gantry_id: g, passed_at: new Date().toISOString(), plate: p },
        { key: INGEST },
      );
      expect(r.body.violation_reason).toBe("insufficient_funds");
    }
    // P80 covers two P35 passages but not the third.
    const t = await h.request("POST", `/accounts/${account.id}/topups`, {
      provider: "orange_money",
      amount_thebe: 8000,
      msisdn: "72000004",
    });
    await waitForTopup(h, t.body.id);
    const open = await h.request("GET", `/violations?account_id=${account.id}&status=open`);
    const settled = await h.request("GET", `/violations?account_id=${account.id}&status=settled`);
    expect(settled.body).toHaveLength(2);
    expect(open.body).toHaveLength(1);
    expect(open.body[0].gantry_id).toBe("A1-G03");
    expect(await balance(account.id)).toBe(1000);
  });

  it("an unregistered vehicle's violation can be paid from a new account", async () => {
    const p = plate();
    const r = await h.request(
      "POST",
      "/passages",
      { source_event_id: eventId(), gantry_id: "A1-G01", passed_at: new Date().toISOString(), plate: p },
      { key: INGEST },
    );
    const acc = await newAccount();
    const unfunded = await h.request("POST", `/violations/${r.body.violation_id}/settle`, { account_id: acc.id });
    expect(unfunded.status).toBe(409);
    expect(unfunded.body.error).toBe("insufficient_funds");

    const t = await h.request("POST", `/accounts/${acc.id}/topups`, {
      provider: "card",
      amount_thebe: 5000,
      card_token: "tok_mc_5454",
    });
    await waitForTopup(h, t.body.id);
    const ok = await h.request("POST", `/violations/${r.body.violation_id}/settle`, { account_id: acc.id });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("settled");
    expect(await balance(acc.id)).toBe(3500);
    const again = await h.request("POST", `/violations/${r.body.violation_id}/settle`, { account_id: acc.id });
    expect(again.status).toBe(409);
  });

  it("a waiver closes the violation and the passage without moving money", async () => {
    const r = await h.request(
      "POST",
      "/passages",
      { source_event_id: eventId(), gantry_id: "A1-G02", passed_at: new Date().toISOString(), plate: plate() },
      { key: INGEST },
    );
    const w = await h.request("POST", `/violations/${r.body.violation_id}/waive`, { reason: "ambulance on call" });
    expect(w.body.status).toBe("waived");
    const p = await h.request("GET", `/passages?status=waived`);
    expect(p.body.map((x: any) => x.id)).toContain(r.body.passage_id);
  });
});
