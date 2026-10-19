import { createHmac, timingSafeEqual } from "node:crypto";

export const PROVIDERS = ["orange_money", "myzaka", "smega", "card"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_NAMES: Record<Provider, string> = {
  orange_money: "Orange Money",
  myzaka: "MyZaka",
  smega: "Smega",
  card: "Card",
};

export interface PaymentRequest {
  provider: Provider;
  /** E.164 wallet number for mobile money. */
  msisdn?: string;
  /** Tokenised card from the provider's hosted form; we never see a card number. */
  cardToken?: string;
  amountThebe: number;
  /** Our top-up id; the provider echoes it back in the callback. */
  reference: string;
  callbackUrl: string;
}

export type ProviderStatus = "pending" | "succeeded" | "failed";

export interface ProviderPayment {
  providerRef: string;
  reference: string;
  status: ProviderStatus;
  amountThebe: number;
  failureReason?: string;
}

/** What the back office needs from a mobile-money or card aggregator. */
export interface PaymentGateway {
  requestPayment(req: PaymentRequest): Promise<{ providerRef: string }>;
  getPayment(provider: Provider, providerRef: string): Promise<ProviderPayment>;
}

export function httpGateway(baseUrl: string, fetchImpl: typeof fetch = fetch): PaymentGateway {
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetchImpl(new URL(path, baseUrl), {
      ...init,
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`payment gateway ${res.status}: ${body?.message ?? res.statusText}`);
    return body;
  };
  return {
    async requestPayment(req) {
      const body = await call(`/v1/${req.provider}/payments`, {
        method: "POST",
        body: JSON.stringify({
          msisdn: req.msisdn,
          card_token: req.cardToken,
          amount_thebe: req.amountThebe,
          reference: req.reference,
          callback_url: req.callbackUrl,
        }),
      });
      return { providerRef: body.provider_ref };
    },
    async getPayment(provider, providerRef) {
      const body = await call(`/v1/${provider}/payments/${encodeURIComponent(providerRef)}`);
      return {
        providerRef: body.provider_ref,
        reference: body.reference,
        status: body.status,
        amountThebe: body.amount_thebe,
        failureReason: body.failure_reason ?? undefined,
      };
    },
  };
}

/** Callbacks are signed over "<timestamp>.<raw body>" with a shared secret. */
export function signCallback(secret: string, timestamp: string, rawBody: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export const CALLBACK_MAX_SKEW_SECONDS = 300;

export function verifyCallbackSignature(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: string,
  now = Date.now(),
): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > CALLBACK_MAX_SKEW_SECONDS) return false;
  const expected = Buffer.from(signCallback(secret, timestamp, rawBody));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
