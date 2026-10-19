import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { z } from "zod";
import { normalizeBotswanaMsisdn } from "../identifiers.js";
import { PROVIDERS, signCallback, type Provider, type ProviderStatus } from "../payments/gateway.js";

/**
 * A stand-in for Orange Money, MyZaka, Smega and a card acquirer. It behaves
 * like the real thing in the ways that matter to a back office: it accepts a
 * collection request, answers "pending" at once, and reports the outcome later
 * through a signed callback that can be late, repeated or lost.
 *
 * Outcomes are driven by the payer, so tests and demos are deterministic:
 *   wallet ending 0000      -> failed, insufficient_wallet_balance
 *   wallet ending 1111      -> failed, customer_cancelled (PIN prompt rejected)
 *   wallet ending 9999      -> succeeds, but the callback is never sent
 *   card_token tok_declined -> failed, card_declined
 *   card_token tok_lost     -> succeeds, but the callback is never sent
 *   anything else           -> succeeded
 */

const REF_PREFIX: Record<Provider, string> = { orange_money: "OM", myzaka: "MZ", smega: "SM", card: "CD" };

interface MockPayment {
  provider: Provider;
  provider_ref: string;
  reference: string;
  amount_thebe: number;
  status: ProviderStatus;
  failure_reason: string | null;
  callback_url: string;
  outcome: { status: "succeeded" | "failed"; failure_reason: string | null; sendCallback: boolean };
  callback_attempts: number;
}

export interface MomoOptions {
  secret: string;
  /** How long the customer "takes" to approve on their phone. */
  callbackDelayMs?: number;
  /** Callback delivery attempts before giving up. */
  maxAttempts?: number;
  retryBaseMs?: number;
  fetchImpl?: typeof fetch;
  logger?: boolean;
}

const requestBody = z.object({
  msisdn: z.string().optional(),
  card_token: z.string().optional(),
  amount_thebe: z.number().int().positive(),
  reference: z.string().min(1).max(64),
  callback_url: z.url(),
});

function decideOutcome(provider: Provider, payer: string): MockPayment["outcome"] {
  if (provider === "card") {
    if (payer === "tok_declined") return { status: "failed", failure_reason: "card_declined", sendCallback: true };
    if (payer === "tok_lost") return { status: "succeeded", failure_reason: null, sendCallback: false };
  } else {
    if (payer.endsWith("0000")) return { status: "failed", failure_reason: "insufficient_wallet_balance", sendCallback: true };
    if (payer.endsWith("1111")) return { status: "failed", failure_reason: "customer_cancelled", sendCallback: true };
    if (payer.endsWith("9999")) return { status: "succeeded", failure_reason: null, sendCallback: false };
  }
  return { status: "succeeded", failure_reason: null, sendCallback: true };
}

export function createMomoApp(opts: MomoOptions) {
  const delay = opts.callbackDelayMs ?? 1500;
  const maxAttempts = opts.maxAttempts ?? 4;
  const retryBase = opts.retryBaseMs ?? 500;
  const doFetch = opts.fetchImpl ?? fetch;
  const payments = new Map<string, MockPayment>();
  const timers = new Set<NodeJS.Timeout>();
  const app = Fastify({ logger: opts.logger ?? false });

  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  async function deliver(p: MockPayment) {
    p.callback_attempts++;
    const body = JSON.stringify({
      reference: p.reference,
      provider_ref: p.provider_ref,
      status: p.status,
      amount_thebe: p.amount_thebe,
      failure_reason: p.failure_reason,
    });
    const ts = String(Math.floor(Date.now() / 1000));
    try {
      const res = await doFetch(p.callback_url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-momo-timestamp": ts,
          "x-momo-signature": signCallback(opts.secret, ts, body),
        },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return;
      app.log.warn({ ref: p.provider_ref, status: res.status }, "callback rejected");
    } catch (err) {
      app.log.warn({ ref: p.provider_ref, err: String(err) }, "callback failed");
    }
    if (p.callback_attempts < maxAttempts) later(retryBase * 2 ** (p.callback_attempts - 1), () => void deliver(p));
  }

  app.post("/v1/:provider/payments", async (req, reply) => {
    const { provider } = z.object({ provider: z.enum(PROVIDERS) }).parse(req.params);
    const parsed = requestBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ message: "invalid request", issues: parsed.error.issues });
    const b = parsed.data;
    let payer: string;
    if (provider === "card") {
      if (!b.card_token) return reply.code(400).send({ message: "card_token required" });
      payer = b.card_token;
    } else {
      const msisdn = b.msisdn ? normalizeBotswanaMsisdn(b.msisdn) : null;
      if (!msisdn) return reply.code(400).send({ message: "valid Botswana msisdn required" });
      payer = msisdn;
    }
    const p: MockPayment = {
      provider,
      provider_ref: `${REF_PREFIX[provider]}${randomBytes(6).toString("hex").toUpperCase()}`,
      reference: b.reference,
      amount_thebe: b.amount_thebe,
      status: "pending",
      failure_reason: null,
      callback_url: b.callback_url,
      outcome: decideOutcome(provider, payer),
      callback_attempts: 0,
    };
    payments.set(p.provider_ref, p);
    later(delay, () => {
      p.status = p.outcome.status;
      p.failure_reason = p.outcome.failure_reason;
      if (p.outcome.sendCallback) void deliver(p);
    });
    return reply.code(202).send({ provider_ref: p.provider_ref, status: "pending" });
  });

  app.get("/v1/:provider/payments/:ref", async (req, reply) => {
    const { provider, ref } = z.object({ provider: z.enum(PROVIDERS), ref: z.string() }).parse(req.params);
    const p = payments.get(ref);
    if (!p || p.provider !== provider) return reply.code(404).send({ message: "payment not found" });
    return {
      provider_ref: p.provider_ref,
      reference: p.reference,
      status: p.status,
      amount_thebe: p.amount_thebe,
      failure_reason: p.failure_reason,
    };
  });

  app.get("/health", async () => ({ ok: true, payments: payments.size }));

  app.addHook("onClose", async () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  });

  return app;
}
