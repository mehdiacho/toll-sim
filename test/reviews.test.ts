import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountWithVehicle, eventId, INGEST, plate, startHarness, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ REVIEW_CONFIDENCE_THRESHOLD: "0.9" });
});
afterAll(() => h.close());

// 1x1 PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const read = (body: Record<string, unknown>) =>
  h.request(
    "POST",
    "/passages",
    { source_event_id: eventId(), gantry_id: "A1-G02", passed_at: new Date().toISOString(), ...body },
    { key: INGEST },
  );

describe("manual plate review", () => {
  it("holds a low-confidence plate read without charging anyone or opening a violation", async () => {
    const { account, plate: p } = await accountWithVehicle(h, { balance: 10000 });
    const r = await read({
      plate: p,
      read_confidence: 0.62,
      read_candidates: [{ plate: p, confidence: 0.62 }, { plate: "B000AAA", confidence: 0.2 }],
      image_b64: PNG,
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "review", match_method: "none", violation_id: null });
    expect(r.body.review_id).toBeTruthy();
    expect((await h.request("GET", `/accounts/${account.id}`)).body.balance_thebe).toBe(10000);

    const queue = (await h.request("GET", "/reviews")).body;
    const item = queue.items.find((i: any) => i.id === r.body.review_id);
    expect(item).toMatchObject({ plate_read: p, has_image: true, gantry_id: "A1-G02", status: "open" });
    expect(item.candidates[1].plate).toBe("B000AAA");

    const img = await fetch(`${h.baseUrl}/reviews/${item.id}/image`, { headers: { authorization: "Bearer test-admin-key" } });
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await img.arrayBuffer()).toString("base64")).toBe(PNG);
  });

  it("does not hold reads that are confident, or that a tag already identifies", async () => {
    const tag = `TAG${Date.now()}`;
    const { plate: p } = await accountWithVehicle(h, { balance: 10000, tagId: tag });
    expect((await read({ plate: p, read_confidence: 0.97 })).body.status).toBe("charged");
    const tagged = await read({ plate: p, tag_id: tag, read_confidence: 0.3 });
    expect(tagged.body).toMatchObject({ status: "charged", match_method: "tag" });
  });

  it("confirming a read rates it as normal and records who decided", async () => {
    const { account, plate: p } = await accountWithVehicle(h, { balance: 10000 });
    const { body } = await read({ plate: p, read_confidence: 0.7 });
    const res = await h.request("POST", `/reviews/${body.review_id}/resolve`, { decision: "confirmed", reviewer: "neo" });
    expect(res.status).toBe(200);
    expect(res.body.passage).toMatchObject({ status: "charged", match_method: "manual", amount_thebe: 1500 });
    expect((await h.request("GET", `/accounts/${account.id}`)).body.balance_thebe).toBe(8500);

    const again = await h.request("POST", `/reviews/${body.review_id}/resolve`, { decision: "confirmed" });
    expect(again.status).toBe(409);

    const trail = (await h.request("GET", `/audit?entity_type=passage&entity_id=${body.passage_id}`)).body;
    expect(trail.map((a: any) => a.action)).toEqual(["review.resolved", "passage.queued_for_review"]);
    expect(trail[0].data).toMatchObject({ reviewer: "neo", decision: "confirmed" });
  });

  it("a correction bills the right owner, never the plate the camera guessed", async () => {
    const owner = await accountWithVehicle(h, { balance: 10000 });
    const bystander = await accountWithVehicle(h, { balance: 10000 });
    const { body } = await read({ plate: bystander.plate, read_confidence: 0.55 });
    const res = await h.request("POST", `/reviews/${body.review_id}/resolve`, {
      decision: "corrected",
      plate: owner.plate.replace(/^B/, "b "),
    });
    expect(res.body.review.resolved_plate).toBe(owner.plate);
    expect(res.body.passage.status).toBe("charged");
    expect((await h.request("GET", `/accounts/${owner.account.id}`)).body.balance_thebe).toBe(8500);
    expect((await h.request("GET", `/accounts/${bystander.account.id}`)).body.balance_thebe).toBe(10000);

    expect((await h.request("POST", `/reviews/${body.review_id}/resolve`, { decision: "corrected" })).status).toBe(400);
  });

  it("a corrected plate nobody registered becomes an unregistered-vehicle violation", async () => {
    const { body } = await read({ plate: plate(), read_confidence: 0.5 });
    const res = await h.request("POST", `/reviews/${body.review_id}/resolve`, { decision: "corrected", plate: plate() });
    expect(res.body).toMatchObject({ passage: { status: "unpaid" }, violation_reason: "unregistered_vehicle" });
  });

  it("an unreadable plate is waived: no charge, no violation", async () => {
    const { body } = await read({ plate: plate(), read_confidence: 0.4 });
    const res = await h.request("POST", `/reviews/${body.review_id}/resolve`, { decision: "unreadable" });
    expect(res.body).toMatchObject({ passage: { status: "waived" }, violation_reason: null });
    const resolved = (await h.request("GET", "/reviews?status=resolved")).body.items;
    expect(resolved.find((i: any) => i.id === body.review_id)).toMatchObject({ decision: "unreadable", passage_status: "waived" });
  });

  it("rejects an image that is not a JPEG, PNG or WebP", async () => {
    const r = await read({ plate: plate(), read_confidence: 0.5, image_b64: Buffer.from("hello").toString("base64") });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("invalid_image");
  });
});
