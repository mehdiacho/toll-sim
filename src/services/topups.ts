import { z } from "zod";
import type { Db, Queryable } from "../db/index.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { maskMsisdn, normalizeBotswanaMsisdn } from "../identifiers.js";
import { PROVIDER_NAMES, PROVIDERS, type PaymentGateway, type Provider } from "../payments/gateway.js";
import { audit } from "./audit.js";
import { getAccount } from "./accounts.js";
import { post } from "./ledger.js";
import { settleOpenViolations } from "./violations.js";

export const topupInput = z.object({
  provider: z.enum(PROVIDERS),
  amount_thebe: z.number().int().positive(),
  msisdn: z.string().optional(),
  card_token: z.string().min(4).max(128).optional(),
});

export const callbackInput = z.object({
  reference: z.uuid(),
  provider_ref: z.string().min(1),
  status: z.enum(["succeeded", "failed"]),
  amount_thebe: z.number().int().nonnegative(),
  failure_reason: z.string().nullish(),
});

export interface TopupDeps {
  db: Db;
  gateway: PaymentGateway;
  callbackBaseUrl: string;
  minThebe: number;
  maxThebe: number;
}

export async function getTopup(q: Queryable, id: string) {
  const { rows } = await q.query("SELECT * FROM topups WHERE id = $1", [id]);
  if (!rows[0]) throw notFound("top-up");
  return rows[0];
}

/**
 * Open a top-up and ask the provider to collect it. The money arrives later,
 * through the provider's callback (or reconciliation if the callback is lost),
 * so this only ever returns a pending or failed top-up.
 */
export async function startTopup(
  deps: TopupDeps,
  accountId: string,
  input: z.infer<typeof topupInput>,
  actor: string,
  idempotencyKey?: string,
) {
  const { db, gateway } = deps;
  if (idempotencyKey) {
    const { rows } = await db.query("SELECT * FROM topups WHERE idempotency_key = $1", [idempotencyKey]);
    if (rows[0]) {
      if (rows[0].account_id !== accountId) throw conflict("idempotency_key_reused", "key belongs to another top-up");
      return { topup: rows[0], replayed: true };
    }
  }
  if (input.amount_thebe < deps.minThebe || input.amount_thebe > deps.maxThebe) {
    throw badRequest("amount_out_of_range", `top-ups must be between ${deps.minThebe} and ${deps.maxThebe} thebe`);
  }

  let msisdn: string | undefined;
  let payer: string;
  if (input.provider === "card") {
    if (!input.card_token) throw badRequest("card_token_required", "card top-ups need a card_token");
    payer = `card:${input.card_token.slice(-4)}`;
  } else {
    msisdn = input.msisdn ? (normalizeBotswanaMsisdn(input.msisdn) ?? undefined) : undefined;
    if (!msisdn) throw badRequest("invalid_msisdn", "mobile money top-ups need a Botswana mobile number");
    payer = maskMsisdn(msisdn);
  }

  const topup = await db.tx(async (q) => {
    const account = await getAccount(q, accountId);
    if (account.status === "closed") throw conflict("account_closed", "cannot top up a closed account");
    const { rows } = await q.query(
      `INSERT INTO topups (account_id, provider, amount_thebe, payer, idempotency_key)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [accountId, input.provider, input.amount_thebe, payer, idempotencyKey ?? null],
    );
    await audit(q, actor, "topup.requested", "topup", rows[0].id, {
      account_id: accountId,
      provider: input.provider,
      amount_thebe: input.amount_thebe,
      payer,
    });
    return rows[0];
  });

  try {
    const { providerRef } = await gateway.requestPayment({
      provider: input.provider,
      msisdn,
      cardToken: input.card_token,
      amountThebe: input.amount_thebe,
      reference: topup.id,
      callbackUrl: new URL(`/payments/callbacks/${input.provider}`, deps.callbackBaseUrl).toString(),
    });
    // The callback may already have landed and recorded the ref; never overwrite it.
    await db.query("UPDATE topups SET provider_ref = $2 WHERE id = $1 AND provider_ref IS NULL", [topup.id, providerRef]);
  } catch (err) {
    await db.tx(async (q) => {
      const { rows } = await q.query(
        `UPDATE topups SET status = 'failed', failure_reason = 'gateway_unreachable', completed_at = now()
         WHERE id = $1 AND status = 'pending' RETURNING id`,
        [topup.id],
      );
      if (rows[0]) {
        await audit(q, "system", "topup.failed", "topup", topup.id, {
          reason: "gateway_unreachable",
          error: String((err as Error).message ?? err),
        });
      }
    });
  }
  return { topup: await getTopup(db, topup.id), replayed: false };
}

export interface PaymentResult {
  provider: Provider;
  reference: string;
  providerRef: string;
  status: "succeeded" | "failed";
  amountThebe: number;
  failureReason?: string | null;
}

/**
 * Apply a provider's final word on a payment. Safe to call any number of times
 * for the same payment: only the first call on a pending top-up has an effect.
 */
export async function applyPaymentResult(db: Db, r: PaymentResult, actor: string) {
  return db.tx(async (q) => {
    const { rows } = await q.query("SELECT * FROM topups WHERE id = $1 FOR UPDATE", [r.reference]);
    const topup = rows[0];
    if (!topup) throw notFound("top-up");
    if (topup.provider !== r.provider) throw badRequest("provider_mismatch", "callback came from the wrong provider");
    if (topup.provider_ref && topup.provider_ref !== r.providerRef) {
      throw badRequest("provider_ref_mismatch", "provider reference does not match this top-up");
    }
    if (topup.status !== "pending") return { topup, applied: false, settled: [] };

    let status = r.status;
    let failureReason = r.failureReason ?? null;
    if (status === "succeeded" && r.amountThebe !== topup.amount_thebe) {
      // Never credit a different amount from the one requested; flag it instead.
      status = "failed";
      failureReason = `amount_mismatch: requested ${topup.amount_thebe}, provider reported ${r.amountThebe}`;
    }

    const { rows: updated } = await q.query(
      `UPDATE topups SET status = $2, provider_ref = $3, failure_reason = $4, completed_at = now()
       WHERE id = $1 RETURNING *`,
      [topup.id, status, r.providerRef, failureReason],
    );
    let settled: unknown[] = [];
    if (status === "succeeded") {
      await post(q, topup.account_id, {
        kind: "topup",
        amountThebe: topup.amount_thebe,
        topupId: topup.id,
        description: `Top-up via ${PROVIDER_NAMES[r.provider]} (${r.providerRef})`,
      });
      await audit(q, actor, "topup.succeeded", "topup", topup.id, {
        account_id: topup.account_id,
        amount_thebe: topup.amount_thebe,
        provider_ref: r.providerRef,
      });
      settled = await settleOpenViolations(q, topup.account_id, actor);
    } else {
      await audit(q, actor, "topup.failed", "topup", topup.id, { reason: failureReason, provider_ref: r.providerRef });
    }
    return { topup: updated[0], applied: true, settled };
  });
}

/**
 * Ask the provider about top-ups still pending after olderThanSeconds. Covers
 * callbacks that never arrived. Top-ups that never reached the provider (no
 * provider_ref) are failed outright.
 */
export async function reconcilePendingTopups(deps: TopupDeps, olderThanSeconds: number) {
  const { rows } = await deps.db.query(
    `SELECT * FROM topups WHERE status = 'pending' AND created_at < now() - make_interval(secs => $1)
     ORDER BY created_at LIMIT 200`,
    [olderThanSeconds],
  );
  const outcome = { checked: rows.length, succeeded: 0, failed: 0, still_pending: 0, errors: 0 };
  for (const t of rows) {
    try {
      if (!t.provider_ref) {
        await applyPaymentResult(
          deps.db,
          {
            provider: t.provider,
            reference: t.id,
            providerRef: "none",
            status: "failed",
            amountThebe: t.amount_thebe,
            failureReason: "never_reached_provider",
          },
          "reconciler",
        );
        outcome.failed++;
        continue;
      }
      const p = await deps.gateway.getPayment(t.provider, t.provider_ref);
      if (p.status === "pending") {
        outcome.still_pending++;
        continue;
      }
      await applyPaymentResult(
        deps.db,
        {
          provider: t.provider,
          reference: t.id,
          providerRef: p.providerRef,
          status: p.status,
          amountThebe: p.amountThebe,
          failureReason: p.failureReason,
        },
        "reconciler",
      );
      outcome[p.status]++;
    } catch {
      outcome.errors++;
    }
  }
  return outcome;
}
