import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountWithVehicle, eventId, INGEST, plate, startHarness, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());

const now = () => new Date().toISOString();
const tagRead = (extra: Record<string, unknown>) =>
  h.request(
    "POST",
    "/passages",
    { source_event_id: eventId(), gantry_id: "A1-G01", passed_at: now(), payment: "tag", lane: 4, direction: "N", ...extra },
    { key: INGEST },
  );
const booth = (extra: Record<string, unknown>) =>
  h.request(
    "POST",
    "/plaza/transactions",
    {
      plaza_id: "A1-G02",
      source_event_id: eventId(),
      lane: 2,
      direction: "S",
      method: "cash",
      vehicle_class: "1",
      transacted_at: now(),
      ...extra,
    },
    { key: INGEST },
  );

describe("toll plazas", () => {
  it("lists the three plazas with five lanes each", async () => {
    const g = await h.request("GET", "/gantries");
    expect(g.body).toHaveLength(3);
    for (const p of g.body) expect(p).toMatchObject({ kind: "plaza", lanes: 5 });
  });

  it("records a cash payment at the booth with no account, priced by the tariff", async () => {
    const r = await booth({ vehicle_class: "2", plate: "b 123 abc", read_confidence: 0.9 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ plaza_id: "A1-G02", lane: 2, direction: "S", method: "cash", vehicle_class: "2", amount_thebe: 3500, plate_read: "B123ABC" });
    const list = await h.request("GET", "/plaza/transactions?plaza_id=A1-G02");
    expect(list.body.some((t: any) => t.id === r.body.id)).toBe(true);
  });

  it("charges motorcycles the Class 1 toll", async () => {
    const r = await booth({ vehicle_class: "M", method: "card" });
    expect(r.body.amount_thebe).toBe(1500);
  });

  it("records a booth payment once, however often the booth retries", async () => {
    const id = eventId();
    const first = await booth({ source_event_id: id });
    const again = await booth({ source_event_id: id });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.id).toBe(first.body.id);
  });

  it("takes a batch and reports each row", async () => {
    const r = await h.request(
      "POST",
      "/plaza/transactions",
      {
        transactions: [
          { plaza_id: "A1-G03", source_event_id: eventId(), lane: 0, direction: "N", method: "card", vehicle_class: "4", transacted_at: now() },
          { plaza_id: "A1-G03", source_event_id: eventId(), lane: 0, direction: "N", method: "cheque", vehicle_class: "4", transacted_at: now() },
        ],
      },
      { key: INGEST },
    );
    expect(r.status).toBe(200);
    expect(r.body.results[0]).toMatchObject({ ok: true, amount_thebe: 9000 });
    expect(r.body.results[1]).toMatchObject({ ok: false, error: "validation_failed" });
  });

  it("refuses unknown plazas and classes", async () => {
    expect((await booth({ plaza_id: "A1-G99" })).status).toBe(422);
    expect((await booth({ vehicle_class: "9" })).status).toBe(422);
  });

  it("keeps booth payments append-only", async () => {
    await booth({});
    await expect(h.db.query("UPDATE plaza_transactions SET amount_thebe = 0")).rejects.toThrow();
    await expect(h.db.query("DELETE FROM plaza_transactions")).rejects.toThrow();
  });

  it("debits the account for a tag at the e-tag lane", async () => {
    const tag = `TAG-${Date.now()}-a`;
    const { account, plate: p } = await accountWithVehicle(h, { tagId: tag, balance: 5000 });
    const r = await tagRead({ tag_id: tag, plate: p, read_confidence: 0.95 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "charged", amount_thebe: 1500, match_method: "tag", decline_reason: null, tag_plate_mismatch: false });
    expect((await h.request("GET", `/accounts/${account.id}`)).body.balance_thebe).toBe(3500);
  });

  it("keeps the boom down on a tag the account can't pay for: no violation, the driver pays by card", async () => {
    const tag = `TAG-${Date.now()}-b`;
    const { account, plate: p } = await accountWithVehicle(h, { tagId: tag, vehicleClass: "4" });
    const r = await tagRead({ tag_id: tag, plate: p, lane: 0 });
    expect(r.body).toMatchObject({ status: "declined", decline_reason: "insufficient_funds", violation_id: null });
    expect((await h.request("GET", `/accounts/${account.id}`)).body.balance_thebe).toBe(0);

    const paid = await booth({ plaza_id: "A1-G01", lane: 0, direction: "N", method: "card", vehicle_class: "4", declined_passage_id: r.body.passage_id });
    expect(paid.status).toBe(201);
    expect(paid.body.amount_thebe).toBe(9000);
    // and only once
    const twice = await booth({ plaza_id: "A1-G01", lane: 0, direction: "N", method: "card", vehicle_class: "4", declined_passage_id: r.body.passage_id });
    expect(twice.status).toBe(409);
  });

  it("refuses to link a booth payment to a passage that was not declined", async () => {
    const tag = `TAG-${Date.now()}-c`;
    const { plate: p } = await accountWithVehicle(h, { tagId: tag, balance: 5000 });
    const r = await tagRead({ tag_id: tag, plate: p });
    const paid = await booth({ plaza_id: "A1-G01", declined_passage_id: r.body.passage_id });
    expect(paid.status).toBe(422);
  });

  it("declines an unknown tag instead of billing the plate", async () => {
    const { account, plate: p } = await accountWithVehicle(h, { balance: 5000 });
    const r = await tagRead({ tag_id: `TAG-nobody-${Date.now()}`, plate: p, read_confidence: 0.99 });
    expect(r.body).toMatchObject({ status: "declined", decline_reason: "tag_not_found" });
    expect((await h.request("GET", `/accounts/${account.id}`)).body.balance_thebe).toBe(5000);
  });

  it("flags a tag read on a different plate (cloned or moved tag)", async () => {
    const tag = `TAG-${Date.now()}-d`;
    await accountWithVehicle(h, { tagId: tag, balance: 5000 });
    const r = await tagRead({ tag_id: tag, plate: plate(), read_confidence: 0.97 });
    expect(r.body).toMatchObject({ status: "charged", tag_plate_mismatch: true });
  });

  it("flags a tag on the wrong class", async () => {
    const tag = `TAG-${Date.now()}-e`;
    const { plate: p } = await accountWithVehicle(h, { tagId: tag, balance: 20000 });
    const r = await tagRead({ tag_id: tag, plate: p, detected_class: "3", lane: 0 });
    expect(r.body).toMatchObject({ status: "charged", charged_class: "1", class_mismatch: true });
  });

  it("turns a boom runner into a violation even when the account could pay", async () => {
    const { account, plate: p } = await accountWithVehicle(h, { balance: 5000 });
    const r = await h.request(
      "POST",
      "/passages",
      { source_event_id: eventId(), gantry_id: "A1-G03", passed_at: now(), payment: "runner", lane: 2, direction: "S", plate: p, read_confidence: 0.96 },
      { key: INGEST },
    );
    expect(r.body).toMatchObject({ status: "unpaid", violation_reason: "boom_runner" });
    expect((await h.request("GET", `/accounts/${account.id}`)).body.balance_thebe).toBe(5000);
  });

  it("sends a low-confidence boom runner read to the review queue", async () => {
    const r = await h.request(
      "POST",
      "/passages",
      { source_event_id: eventId(), gantry_id: "A1-G03", passed_at: now(), payment: "runner", lane: 3, direction: "N", plate: plate(), read_confidence: 0.4 },
      { key: INGEST },
    );
    expect(r.body.status).toBe("review");
    const review = await h.request("POST", `/reviews/${r.body.review_id}/resolve`, { decision: "confirmed" });
    expect(review.status).toBe(200);
    expect(review.body.violation_reason).toBe("boom_runner");
  });

  it("summarises today's plaza takings by method", async () => {
    const r = await h.request("GET", "/plazas", undefined, { key: INGEST });
    expect(r.status).toBe(200);
    const g01 = r.body.find((p: any) => p.id === "A1-G01");
    expect(g01.by_method.tag).toBeGreaterThan(0);
    expect(g01.by_method.card).toBeGreaterThan(0);
    expect(g01.declined).toBeGreaterThan(0);
    const g03 = r.body.find((p: any) => p.id === "A1-G03");
    expect(g03.runners).toBeGreaterThan(0);
    const dash = await h.request("GET", "/dashboard/data");
    expect(dash.body.plazas).toHaveLength(3);
  });
});

describe("live feed plaza fields", () => {
  const base = {
    t: 10,
    clock: "2026-10-20T08:00:00+02:00",
    vehicles: [[1, 10, 20, 0, 0]],
    spawn: [[1, "B111AAA", "1", 3]],
    events: [
      { vid: 1, gantry: "A1-G01", dir: "N", plate: "B111AAA", status: "charged", amount_thebe: 1500, reason: null, match: "tag", plaza: "A1-G01", lane: 4, method: "tag" },
      { vid: 2, gantry: "A1-G01", dir: "S", plate: null, status: "paid", amount_thebe: 1500, reason: null, match: null, plaza: "A1-G01", lane: 2, method: "cash" },
    ],
    stats: {
      vehicles: 1,
      plazas: { "A1-G01": { open: { N: 5, S: 5 }, queue: { N: 3, S: 0 }, wait_s: 12.5, by_method: { tag: 1, cash: 1, card: 0 } } },
    },
    booms: [["A1-G01", "N", 4, 1]],
    lanes_open: { "A1-G01": { N: [0, 1, 2, 3, 4], S: [0, 1, 2, 3, 4] } },
  };

  it("accepts plaza stats, booms and open lanes and keeps them for late joiners", async () => {
    const r = await h.request("POST", "/live/frame", base, { key: INGEST });
    expect(r.status).toBe(200);
    // a later frame without lanes_open still leaves the last known state in the snapshot
    await h.request("POST", "/live/frame", { ...base, t: 12, booms: [["A1-G01", "N", 4, 0]], lanes_open: undefined }, { key: INGEST });
    const snap = await h.request("GET", "/live/snapshot", undefined, { key: null });
    expect(snap.body.lanes_open["A1-G01"].N).toEqual([0, 1, 2, 3, 4]);
    expect(snap.body.booms).toContainEqual(["A1-G01", "N", 4, 0]);
    expect(snap.body.frame.stats.plazas["A1-G01"].queue.N).toBe(3);
    expect(snap.body.recent.some((e: any) => e.method === "cash" && e.lane === 2)).toBe(true);
    const dash = await h.request("GET", "/dashboard/data");
    expect(dash.body.plazas.find((p: any) => p.id === "A1-G01")).toMatchObject({ open: { N: 5, S: 5 }, wait_s: 12.5 });
  });

  it("still accepts an old-style frame", async () => {
    const r = await h.request(
      "POST",
      "/live/frame",
      { t: 1, clock: "x", vehicles: [], events: [{ vid: 1, gantry: "A1-G01", dir: "N", plate: null, status: "charged", amount_thebe: 1, reason: null, match: null }], stats: { vehicles: 0 } },
      { key: INGEST },
    );
    expect(r.status).toBe(200);
  });

  it("rejects a bad payment method", async () => {
    const bad = { ...base, events: [{ ...base.events[0], method: "barter" }] };
    expect((await h.request("POST", "/live/frame", bad, { key: INGEST })).status).toBe(400);
  });
});
