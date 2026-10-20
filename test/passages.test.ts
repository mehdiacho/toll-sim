import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountWithVehicle, eventId, INGEST, plate, startHarness, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());

const now = () => new Date().toISOString();
const passage = (extra: Record<string, unknown>) =>
  h.request("POST", "/passages", { source_event_id: eventId(), gantry_id: "A1-G01", passed_at: now(), ...extra }, { key: INGEST });

describe("passage ingest", () => {
  it("rates a registered car and charges its account", async () => {
    const { account, plate: p } = await accountWithVehicle(h, { balance: 10000 });
    const r = await passage({ plate: p, read_confidence: 0.97 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "charged", amount_thebe: 1500, charged_class: "1", match_method: "plate" });
    const acc = await h.request("GET", `/accounts/${account.id}`);
    expect(acc.body.balance_thebe).toBe(8500);
  });

  it("matches camera reads regardless of spacing and case", async () => {
    const { plate: p } = await accountWithVehicle(h, { balance: 5000 });
    const spaced = `${p.slice(0, 1)} ${p.slice(1, 4)} ${p.slice(4)}`.toLowerCase();
    const r = await passage({ plate: spaced });
    expect(r.body.match_method).toBe("plate");
    expect(r.body.status).toBe("charged");
  });

  it("is idempotent on (gantry, source_event_id)", async () => {
    const { account, plate: p } = await accountWithVehicle(h, { balance: 10000 });
    const event = { source_event_id: eventId(), gantry_id: "A1-G02", passed_at: now(), plate: p };
    const first = await h.request("POST", "/passages", event, { key: INGEST });
    const second = await h.request("POST", "/passages", event, { key: INGEST });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.passage_id).toBe(first.body.passage_id);
    const acc = await h.request("GET", `/accounts/${account.id}`);
    expect(acc.body.balance_thebe).toBe(8500);
  });

  it("prefers the tag over the plate and bills the registered class", async () => {
    const tag = `TAG-${Date.now()}`;
    const { account } = await accountWithVehicle(h, { vehicleClass: "3", tagId: tag, balance: 20000 });
    // Camera misread the plate and the classifier thinks it's a light vehicle.
    const r = await passage({ tag_id: tag, plate: "B000XXX", detected_class: "1" });
    expect(r.body).toMatchObject({ match_method: "tag", charged_class: "3", amount_thebe: 6000, class_mismatch: true });
    const acc = await h.request("GET", `/accounts/${account.id}`);
    expect(acc.body.balance_thebe).toBe(14000);
  });

  it("records an unpaid passage and a violation when the balance is too low", async () => {
    const { account, plate: p } = await accountWithVehicle(h, { vehicleClass: "4", balance: 5000 });
    const r = await passage({ plate: p, gantry_id: "A1-G03" });
    expect(r.body).toMatchObject({ status: "unpaid", amount_thebe: 9000, violation_reason: "insufficient_funds" });
    const acc = await h.request("GET", `/accounts/${account.id}`);
    expect(acc.body.balance_thebe).toBe(5000);
    const v = await h.request("GET", `/violations?account_id=${account.id}&status=open`);
    expect(v.body).toHaveLength(1);
    // Grace period is 7 days from the passage.
    const due = new Date(v.body[0].due_by).getTime() - new Date(v.body[0].passed_at).getTime();
    expect(due).toBe(7 * 86_400_000);
  });

  it("flags an unregistered vehicle at its detected class", async () => {
    const p = plate();
    const r = await passage({ plate: p, detected_class: "2" });
    expect(r.body).toMatchObject({
      status: "unpaid",
      match_method: "none",
      charged_class: "2",
      amount_thebe: 3500,
      violation_reason: "unregistered_vehicle",
    });
  });

  it("treats a suspended account's passages as violations", async () => {
    const { account, plate: p } = await accountWithVehicle(h, { balance: 10000 });
    await h.request("PATCH", `/accounts/${account.id}/status`, { status: "suspended", reason: "card fraud review" });
    const r = await passage({ plate: p });
    expect(r.body.violation_reason).toBe("account_inactive");
  });

  it("rejects unknown gantries and reads with no identifier", async () => {
    expect((await passage({ plate: plate(), gantry_id: "NOPE" })).status).toBe(422);
    expect((await passage({})).status).toBe(400);
  });

  it("ingests a batch and reports each event", async () => {
    const { plate: p } = await accountWithVehicle(h, { balance: 3000 });
    const dup = eventId();
    const r = await h.request(
      "POST",
      "/passages",
      {
        events: [
          { source_event_id: dup, gantry_id: "A1-G01", passed_at: now(), plate: p },
          { source_event_id: dup, gantry_id: "A1-G01", passed_at: now(), plate: p },
          { source_event_id: eventId(), gantry_id: "A1-G02", passed_at: now(), plate: p },
          { source_event_id: eventId(), gantry_id: "A1-G03", passed_at: now(), plate: p },
          { source_event_id: eventId(), gantry_id: "BAD", passed_at: now(), plate: p },
          { source_event_id: eventId(), gantry_id: "A1-G01" },
        ],
      },
      { key: INGEST },
    );
    expect(r.status).toBe(200);
    const statuses = r.body.results.map((x: any) => (x.ok ? (x.duplicate ? "dup" : x.status) : x.error));
    expect(statuses).toEqual(["charged", "dup", "charged", "unpaid", "unknown_gantry", "validation_failed"]);
  });
});

describe("concurrency", () => {
  it("never overdraws an account when its passages arrive at once", async () => {
    const { account, plate: p } = await accountWithVehicle(h, { balance: 15000 });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        passage({ plate: p, gantry_id: ["A1-G01", "A1-G02", "A1-G03"][i % 3] }),
      ),
    );
    const statuses = results.map((r) => r.body.status);
    expect(statuses.filter((s) => s === "charged")).toHaveLength(10);
    expect(statuses.filter((s) => s === "unpaid")).toHaveLength(10);
    expect((await h.request("GET", `/accounts/${account.id}`)).body.balance_thebe).toBe(0);
  });
});

describe("tariff versioning", () => {
  it("rates each passage at the price in force when it happened", async () => {
    const { plate: p } = await accountWithVehicle(h, { vehicleClass: "M", balance: 10000 });
    const change = new Date(Date.now() + 60_000);
    const t = await h.request("POST", "/tariffs", {
      gantry_id: "A1-G02",
      vehicle_class: "M",
      amount_thebe: 1000,
      valid_from: change.toISOString(),
    });
    expect(t.status).toBe(201);
    const before = await passage({ plate: p, gantry_id: "A1-G02", passed_at: new Date(change.getTime() - 1000).toISOString() });
    const after = await passage({ plate: p, gantry_id: "A1-G02", passed_at: new Date(change.getTime() + 1000).toISOString() });
    expect(before.body.amount_thebe).toBe(1500); // motorcycles pay the Class 1 toll
    expect(after.body.amount_thebe).toBe(1000);
  });

  it("refuses a price that would rewrite history", async () => {
    const r = await h.request("POST", "/tariffs", {
      gantry_id: "A1-G01",
      vehicle_class: "1",
      amount_thebe: 1,
      valid_from: "2025-01-01T00:00:00Z",
    });
    expect(r.status).toBe(409);
  });
});

describe("auth", () => {
  it("requires a key, and the gantry key can only ingest", async () => {
    expect((await h.request("GET", "/gantries", undefined, { key: null })).status).toBe(401);
    expect((await h.request("GET", "/gantries", undefined, { key: "wrong" })).status).toBe(401);
    expect((await h.request("POST", "/accounts", { holder_name: "Nope" }, { key: INGEST })).status).toBe(403);
    expect((await h.request("GET", "/gantries")).body).toHaveLength(3);
  });
});
