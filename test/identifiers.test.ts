import { describe, expect, it } from "vitest";
import { isStandardBotswanaPlate, maskMsisdn, normalizeBotswanaMsisdn, normalizePlate } from "../src/identifiers.js";
import { signCallback, verifyCallbackSignature } from "../src/payments/gateway.js";

describe("plates", () => {
  it("normalizes spacing, case and punctuation", () => {
    expect(normalizePlate(" b 123 abc ")).toBe("B123ABC");
    expect(normalizePlate("B-123-ABC")).toBe("B123ABC");
  });
  it("recognizes the standard private format", () => {
    expect(isStandardBotswanaPlate("B 123 ABC")).toBe(true);
    expect(isStandardBotswanaPlate("BX 123")).toBe(false);
  });
});

describe("msisdn", () => {
  it.each(["71234567", "+26771234567", "26771234567", "+267 71 234 567", "0026771234567"])("accepts %s", (raw) => {
    expect(normalizeBotswanaMsisdn(raw)).toBe("+26771234567");
  });
  it.each(["3912345", "61234567", "7123456", "+27712345678"])("rejects %s", (raw) => {
    expect(normalizeBotswanaMsisdn(raw)).toBeNull();
  });
  it("masks for storage", () => {
    expect(maskMsisdn("+26771234567")).toBe("+267 71***567");
  });
});

describe("callback signatures", () => {
  const body = '{"a":1}';
  const now = Date.now();
  const ts = String(Math.floor(now / 1000));
  it("accepts a fresh, correct signature", () => {
    expect(verifyCallbackSignature("s", ts, signCallback("s", ts, body), body, now)).toBe(true);
  });
  it("rejects a wrong secret, a changed body or a stale timestamp", () => {
    expect(verifyCallbackSignature("s", ts, signCallback("other", ts, body), body, now)).toBe(false);
    expect(verifyCallbackSignature("s", ts, signCallback("s", ts, body), '{"a":2}', now)).toBe(false);
    const old = String(Math.floor(now / 1000) - 3600);
    expect(verifyCallbackSignature("s", old, signCallback("s", old, body), body, now)).toBe(false);
  });
});
