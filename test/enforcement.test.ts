import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountWithVehicle, eventId, fund, INGEST, plate, startHarness, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());

const DAY = 86_400_000;
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString();

const pass = (body: Record<string, unknown>) =>
  h.request(
    "POST",
    "/passages",
    { source_event_id: eventId(), gantry_id: "A1-G02", passed_at: new Date().toISOString(), vehicle_class: "1", ...body },
    { key: INGEST },
  );
const enforce = (days: number) => h.request("POST", "/admin/run-enforcement", { at: inDays(days) });
const violation = async (id: string) => (await h.db.query("SELECT * FROM violations WHERE id = $1", [id])).rows[0];
const notices = async (id: string) =>
  (await h.request("GET", `/admin/outbox?related_id=${id}`)).body.map((m: any) => `${m.kind}:${m.channel}`).sort();

describe("enforcement ladder", () => {
  it("leaves a violation alone during its grace period", async () => {
    const r = await pass({ plate: plate() });
    expect(r.body.violation_reason).toBe("unregistered_vehicle");
    await enforce(6);
    expect(await violation(r.body.violation_id)).toMatchObject({ stage: "grace", penalty_thebe: 0 });
    expect(await notices(r.body.violation_id)).toEqual([]);
  });

  it("walks notice -> final notice -> referral, adding fees and writing a notice at each step", async () => {
    const { plate: p } = await accountWithVehicle(h); // no balance, so the passage becomes a violation
    const r = await pass({ plate: p });
    const id = r.body.violation_id;
    expect(r.body.violation_reason).toBe("insufficient_funds");

    const first = await enforce(8);
    expect(first.status).toBe(200);
    expect(await violation(id)).toMatchObject({ stage: "notice", penalty_thebe: 5000 });

    await enforce(8); // re-running at the same clock does nothing more
    expect(await violation(id)).toMatchObject({ stage: "notice", penalty_thebe: 5000 });

    await enforce(22);
    expect(await violation(id)).toMatchObject({ stage: "final_notice", penalty_thebe: 20000 });
    await enforce(36);
    expect(await violation(id)).toMatchObject({ stage: "referred", penalty_thebe: 20000 });

    // An account with a phone gets each notice by SMS.
    expect(await notices(id)).toEqual(["violation_final_notice:sms", "violation_notice:sms", "violation_referred:sms"]);
    const trail = (await h.request("GET", `/audit?entity_type=violation&entity_id=${id}`)).body;
    expect(trail.filter((a: any) => a.action === "violation.escalated").map((a: any) => a.data.to)).toEqual([
      "referred",
      "final_notice",
      "notice",
    ]);
    expect((await h.request("GET", "/audit/verify")).body.ok).toBe(true);
  });

  it("catches up several missed stages in one run, and writes to the registered keeper when there is no account", async () => {
    const p = plate();
    const r = await pass({ plate: p });
    const run = (await enforce(60)).body;
    expect(run.escalated.referred).toBeGreaterThanOrEqual(1);
    expect(await violation(r.body.violation_id)).toMatchObject({ stage: "referred", penalty_thebe: 20000 });
    const mail = (await h.request("GET", `/admin/outbox?related_id=${r.body.violation_id}`)).body;
    expect(mail).toHaveLength(3);
    expect(mail.every((m: any) => m.channel === "post" && m.recipient === `Registered keeper of ${p}`)).toBe(true);
  });

  it("puts referred plates on the hotlist and flags them at the next gantry", async () => {
    const p = plate();
    await pass({ plate: p });
    await enforce(60);
    const list = (await h.request("GET", "/enforcement/hotlist")).body;
    expect(list.find((x: any) => x.plate === p)).toMatchObject({ violations: 1, owed_thebe: 21500, unregistered: true });

    const again = await pass({ plate: p });
    expect(again.body.hotlist).toEqual({ violations: 1, owed_thebe: 21500 });
    const trail = (await h.request("GET", `/audit?entity_type=passage&entity_id=${again.body.passage_id}`)).body;
    expect(trail.map((a: any) => a.action)).toContain("enforcement.hotlist_hit");
  });

  it("collects toll and fees when the motorist tops up, as separate ledger lines", async () => {
    const { account, plate: p } = await accountWithVehicle(h);
    const r = await pass({ plate: p });
    await enforce(8);
    await fund(h, account.id, 10000);
    expect(await violation(r.body.violation_id)).toMatchObject({ status: "settled" });
    expect((await h.request("GET", `/accounts/${account.id}`)).body.balance_thebe).toBe(10000 - 1500 - 5000);

    const st = (await h.request("GET", `/accounts/${account.id}/statement`)).body;
    expect(st.totals).toMatchObject({ topups_thebe: 10000, tolls_thebe: 1500, penalties_thebe: 5000 });
    expect(st.outstanding_thebe).toBe(0);
  });

  it("does not move a violation that is under dispute", async () => {
    const r = await pass({ plate: plate() });
    const d = await h.request("POST", "/disputes", {
      passage_id: r.body.passage_id,
      reason: "plate_misread",
      description: "That is not my car, the camera misread the plate.",
    });
    expect(d.status).toBe(201);
    const run = (await enforce(60)).body;
    expect(run.skipped_disputed).toBeGreaterThanOrEqual(1);
    expect(await violation(r.body.violation_id)).toMatchObject({ stage: "grace", penalty_thebe: 0 });
  });
});
