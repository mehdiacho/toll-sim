import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountWithVehicle, eventId, INGEST, plate, startHarness, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const DAY = 86_400_000;

const pass = (body: Record<string, unknown>) =>
  h.request(
    "POST",
    "/passages",
    { source_event_id: eventId(), gantry_id: "A1-G02", passed_at: new Date().toISOString(), vehicle_class: "1", ...body },
    { key: INGEST },
  );
const raise = (body: Record<string, unknown>) =>
  h.request("POST", "/disputes", { reason: "plate_misread", description: "The camera read someone else's plate.", ...body });
const resolve = (id: string, body: Record<string, unknown>) => h.request("POST", `/disputes/${id}/resolve`, body);
const balance = async (id: string) => (await h.request("GET", `/accounts/${id}`)).body.balance_thebe;

describe("disputes", () => {
  it("stores evidence, shows the operator the whole case, and serves the files back", async () => {
    const { account, plate: p } = await accountWithVehicle(h, { balance: 10000 });
    const r = await pass({ plate: p });
    const d = await raise({ passage_id: r.body.passage_id, evidence: [{ filename: "receipt.png", data_b64: PNG }] });
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ status: "open", account_id: account.id, evidence_count: 1 });

    const full = (await h.request("GET", `/disputes/${d.body.id}`)).body;
    expect(full.passage.id).toBe(r.body.passage_id);
    expect(full.paid).toEqual({ toll: 1500 });
    expect(full.evidence[0]).toMatchObject({ filename: "receipt.png", content_type: "image/png" });
    expect(full.history.map((a: any) => a.action)).toContain("dispute.raised");

    const file = await fetch(`${h.baseUrl}/disputes/${d.body.id}/evidence/${full.evidence[0].id}`, {
      headers: { authorization: "Bearer test-admin-key" },
    });
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await file.arrayBuffer()).toString("base64")).toBe(PNG);
    expect((await h.request("GET", "/disputes?status=open")).body.items.some((x: any) => x.id === d.body.id)).toBe(true);
    expect(await balance(account.id)).toBe(8500);
  });

  it("rejects files that are not images or PDFs, whatever they are called", async () => {
    const { plate: p } = await accountWithVehicle(h, { balance: 10000 });
    const r = await pass({ plate: p });
    const bad = await raise({
      passage_id: r.body.passage_id,
      evidence: [{ filename: "photo.png", data_b64: Buffer.from("#!/bin/sh\necho hi").toString("base64") }],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe("invalid_evidence");
  });

  it("allows one open dispute per passage, and none once one is upheld", async () => {
    const { plate: p } = await accountWithVehicle(h, { balance: 10000 });
    const r = await pass({ plate: p });
    const d = await raise({ passage_id: r.body.passage_id });
    expect((await raise({ passage_id: r.body.passage_id })).body.error).toBe("dispute_open");
    await resolve(d.body.id, { decision: "upheld", note: "Plate misread confirmed." });
    const again = await raise({ passage_id: r.body.passage_id });
    expect(again.status).toBe(409);
  });

  it("upholding a paid passage refunds the toll to the payer and marks the passage refunded", async () => {
    const { account, plate: p } = await accountWithVehicle(h, { balance: 10000 });
    const r = await pass({ plate: p });
    const d = await raise({ passage_id: r.body.passage_id });
    const res = await resolve(d.body.id, { decision: "upheld", note: "Image shows a different vehicle." });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ refund_thebe: 1500, passage: { status: "refunded" } });
    expect(await balance(account.id)).toBe(10000);
    expect((await resolve(d.body.id, { decision: "rejected", note: "second try" })).status).toBe(409);

    const st = (await h.request("GET", `/accounts/${account.id}/statement`)).body;
    expect(st.totals).toMatchObject({ tolls_thebe: 1500, refunds_thebe: 1500 });
    const mail = (await h.request("GET", `/admin/outbox?related_id=${d.body.id}`)).body.map((m: any) => m.kind);
    expect(mail.sort()).toEqual(["dispute_received", "dispute_resolved"]);
  });

  it("upholding an unpaid violation waives it, fees included", async () => {
    const r = await pass({ plate: plate() });
    await h.request("POST", "/admin/run-enforcement", { at: new Date(Date.now() + 10 * DAY).toISOString() });
    const d = await raise({ passage_id: r.body.passage_id, reason: "vehicle_stolen", description: "Car was stolen that week, case number attached." });
    await resolve(d.body.id, { decision: "upheld", note: "Police case verified." });
    const v = (await h.db.query("SELECT * FROM violations WHERE id = $1", [r.body.violation_id])).rows[0];
    expect(v).toMatchObject({ status: "waived", penalty_thebe: 5000 });
    expect((await h.db.query("SELECT status FROM passages WHERE id = $1", [r.body.passage_id])).rows[0].status).toBe("waived");
  });

  it("a wrong-class dispute re-rates the passage and refunds only the difference", async () => {
    const { account, plate: p } = await accountWithVehicle(h, { balance: 10000, vehicleClass: "2" });
    const r = await pass({ plate: p, vehicle_class: "2" });
    expect(r.body.amount_thebe).toBe(3500);
    const d = await raise({ passage_id: r.body.passage_id, reason: "wrong_class", description: "It is a sedan, class 1, not a light truck." });
    const res = await resolve(d.body.id, { decision: "upheld", note: "Registration says class 1.", corrected_class: "1" });
    expect(res.body).toMatchObject({ refund_thebe: 2000, passage: { charged_class: "1", amount_thebe: 1500 } });
    expect(await balance(account.id)).toBe(10000 - 1500);
  });

  it("a re-rating never makes a charge bigger", async () => {
    const { account, plate: p } = await accountWithVehicle(h, { balance: 10000 });
    const r = await pass({ plate: p });
    const d = await raise({ passage_id: r.body.passage_id, reason: "wrong_class", description: "Charged the wrong class, please check." });
    const res = await resolve(d.body.id, { decision: "upheld", note: "Checked.", corrected_class: "4" });
    expect(res.body).toMatchObject({ refund_thebe: 0, passage: { amount_thebe: 1500 } });
    expect(await balance(account.id)).toBe(8500);
  });

  it("rejecting gives back the time the dispute was open, so contesting costs no time to pay", async () => {
    const r = await pass({ plate: plate() });
    const before = (await h.db.query("SELECT due_by FROM violations WHERE id = $1", [r.body.violation_id])).rows[0].due_by;
    const d = await raise({ passage_id: r.body.passage_id });
    await h.db.query("UPDATE disputes SET created_at = created_at - interval '3 days' WHERE id = $1", [d.body.id]);
    await resolve(d.body.id, { decision: "rejected", note: "Plate clearly legible in the image." });
    const after = (await h.db.query("SELECT due_by, status FROM violations WHERE id = $1", [r.body.violation_id])).rows[0];
    expect(after.status).toBe("open");
    const gained = new Date(after.due_by).getTime() - new Date(before).getTime();
    expect(gained / DAY).toBeGreaterThan(2.99);
    expect(gained / DAY).toBeLessThan(3.01);
  });

  it("closes the dispute window after the configured number of days", async () => {
    const { plate: p } = await accountWithVehicle(h, { balance: 10000 });
    const r = await pass({ plate: p, passed_at: new Date(Date.now() - 91 * DAY).toISOString() });
    const res = await raise({ passage_id: r.body.passage_id });
    expect(res.body.error).toBe("dispute_window_closed");
  });

  it("records every step in the tamper-evident audit log", async () => {
    expect((await h.request("GET", "/audit/verify")).body.ok).toBe(true);
    const actions = (await h.request("GET", "/audit?entity_type=dispute&limit=1000")).body.map((a: any) => a.action);
    expect(actions).toContain("dispute.raised");
    expect(actions).toContain("dispute.resolved");
  });
});
