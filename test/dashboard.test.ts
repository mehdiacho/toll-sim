import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountWithVehicle, eventId, INGEST, plate, startHarness, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());

describe("dashboard", () => {
  it("serves the page and the corridor map without a key", async () => {
    const page = await fetch(h.baseUrl + "/dashboard");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("A1 Toll Operations");

    const map = await h.request("GET", "/dashboard/corridor.json", undefined, { key: null });
    expect(map.status).toBe(200);
    expect(map.body.gantries.map((g: any) => g.id)).toEqual(["A1-G01", "A1-G02", "A1-G03"]);
    expect(map.body.polyline.length).toBeGreaterThan(10);
  });

  it("keeps the numbers behind the admin key", async () => {
    expect((await h.request("GET", "/dashboard/data", undefined, { key: null })).status).toBe(401);
    expect((await h.request("GET", "/dashboard/data", undefined, { key: INGEST })).status).toBe(403);
  });

  it("summarises passages, revenue, violations and the per-minute series on the gantry clock", async () => {
    const { plate: known } = await accountWithVehicle(h, { balance: 10000 });
    // A simulated clock well away from now: the series must follow passed_at.
    const t0 = Date.parse("2026-03-02T06:00:00+02:00");
    const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
    const send = (body: object) => h.request("POST", "/passages", body, { key: INGEST });

    await send({ source_event_id: eventId(), gantry_id: "A1-G01", passed_at: at(0), plate: known });
    await send({ source_event_id: eventId(), gantry_id: "A1-G02", passed_at: at(1), plate: known, detected_class: "3" });
    await send({ source_event_id: eventId(), gantry_id: "A1-G02", passed_at: at(1), plate: plate() });

    const { status, body: d } = await h.request("GET", "/dashboard/data");
    expect(status).toBe(200);
    expect(d.totals).toMatchObject({ passages: 3, charged: 2, unpaid: 1, by_plate: 2, class_mismatch: 1, revenue_thebe: 3000 });
    expect(new Date(d.totals.last_passed_at).toISOString()).toBe(at(1));
    expect(d.gantries.find((g: any) => g.id === "A1-G02")).toMatchObject({ passages: 2, unpaid: 1, revenue_thebe: 1500 });
    expect(d.series.map((s: any) => s.passages)).toEqual([1, 2]);
    expect(d.series[1]).toMatchObject({ unpaid: 1, revenue_thebe: 1500 });
    expect(d.violations).toEqual([{ status: "open", reason: "unregistered_vehicle", count: 1, amount_thebe: 1500 }]);
    expect(d.classes.find((c: any) => c.code === "1").passages).toBe(3);
    expect(d.recent[0].passed_at).toBeDefined();
    expect(d.topups[0]).toMatchObject({ succeeded: 1 });
    expect(d.audit.entries).toBeGreaterThan(0);
  });
});
