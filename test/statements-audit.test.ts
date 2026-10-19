import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountWithVehicle, eventId, fund, INGEST, startHarness, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());

describe("statements", () => {
  it("opening balance plus entries equals closing balance, which equals the account balance", async () => {
    const { account, plate } = await accountWithVehicle(h, { balance: 10000 });
    const mid = new Date();
    await new Promise((r) => setTimeout(r, 20));
    await fund(h, account.id, 5000);
    for (const g of ["A1-G01", "A1-G02"]) {
      await h.request(
        "POST",
        "/passages",
        { source_event_id: eventId(), gantry_id: g, passed_at: new Date().toISOString(), plate },
        { key: INGEST },
      );
    }

    const full = (await h.request("GET", `/accounts/${account.id}/statement`)).body;
    expect(full.opening_balance_thebe).toBe(0);
    expect(full.totals).toEqual({ topups_thebe: 15000, tolls_thebe: 3000, penalties_thebe: 0, refunds_thebe: 0, adjustments_thebe: 0 });
    expect(full.closing_balance_thebe).toBe(12000);
    expect(full.entries.map((e: any) => e.kind)).toEqual(["topup", "topup", "toll", "toll"]);
    expect(full.entries[2]).toMatchObject({ gantry_id: "A1-G01", charged_class: "1", plate_read: plate });

    const partial = (await h.request("GET", `/accounts/${account.id}/statement?from=${mid.toISOString()}`)).body;
    expect(partial.opening_balance_thebe).toBe(10000);
    expect(partial.entries).toHaveLength(3);
    const sum = partial.entries.reduce((s: number, e: any) => s + e.amount_thebe, 0);
    expect(partial.opening_balance_thebe + sum).toBe(partial.closing_balance_thebe);

    expect((await h.request("GET", `/accounts/${account.id}`)).body.balance_thebe).toBe(12000);
  });

  it("lists outstanding violations", async () => {
    const { account, plate } = await accountWithVehicle(h, { vehicleClass: "4" });
    await h.request(
      "POST",
      "/passages",
      { source_event_id: eventId(), gantry_id: "A1-G03", passed_at: new Date().toISOString(), plate },
      { key: INGEST },
    );
    const s = (await h.request("GET", `/accounts/${account.id}/statement`)).body;
    expect(s.outstanding_thebe).toBe(9000);
    expect(s.open_violations[0].reason).toBe("insufficient_funds");
  });
});

describe("audit log", () => {
  it("records who did what to which entity", async () => {
    const { account, vehicle } = await accountWithVehicle(h);
    const rows = (await h.request("GET", `/audit?entity_type=account&entity_id=${account.id}`)).body;
    expect(rows.map((r: any) => r.action)).toEqual(["account.created"]);
    expect(rows[0].actor).toBe("admin");
    const v = (await h.request("GET", `/audit?entity_type=vehicle&entity_id=${vehicle.id}`)).body;
    expect(v[0].data.plate).toBe(vehicle.plate);
  });

  it("the hash chain verifies", async () => {
    const r = await h.request("GET", "/audit/verify");
    expect(r.body.ok).toBe(true);
    expect(r.body.rows).toBeGreaterThan(5);
  });

  it("rows cannot be updated, deleted or truncated, and nor can ledger entries", async () => {
    await expect(h.db.query("UPDATE audit_log SET actor = 'mallory'")).rejects.toThrow(/append-only/);
    await expect(h.db.query("DELETE FROM audit_log")).rejects.toThrow(/append-only/);
    await expect(h.db.query("TRUNCATE audit_log")).rejects.toThrow(/append-only/);
    await expect(h.db.query("UPDATE ledger_entries SET amount_thebe = 0")).rejects.toThrow(/append-only/);
    await expect(h.db.query("DELETE FROM ledger_entries")).rejects.toThrow(/append-only/);
  });

  it("detects tampering even by someone who can disable the triggers", async () => {
    const before = (await h.request("GET", "/audit/verify")).body;
    await h.db.exec(`
      ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only;
      UPDATE audit_log SET data = '{"amount_thebe": 1}'::jsonb WHERE seq = 3;
      ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only;`);
    const after = (await h.request("GET", "/audit/verify")).body;
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(false);
    expect(after.brokenAt).toBe(3);
  });
});
