import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { AppError } from "./errors.js";
import { PROVIDERS, verifyCallbackSignature, type PaymentGateway } from "./payments/gateway.js";
import {
  accountStatusInput,
  createAccount,
  createAccountInput,
  deactivateVehicle,
  getAccount,
  listVehicles,
  registerVehicle,
  registerVehicleInput,
  setAccountStatus,
} from "./services/accounts.js";
import { verifyAuditChain } from "./services/audit.js";
import { ingestPassage, listPassages, passageBatchInput, passageInput, passageQuery } from "./services/passages.js";
import { buildStatement, statementQuery } from "./services/statements.js";
import { newTariffInput, scheduleTariff } from "./services/tariffs.js";
import {
  applyPaymentResult,
  callbackInput,
  getTopup,
  reconcilePendingTopups,
  startTopup,
  topupInput,
  type TopupDeps,
} from "./services/topups.js";
import { listViolations, settleInput, settleViolation, violationQuery, waiveInput, waiveViolation } from "./services/violations.js";

export interface AppDeps {
  db: Db;
  gateway: PaymentGateway;
  config: Config;
  logger?: boolean;
}

type Role = "admin" | "ingest";

declare module "fastify" {
  interface FastifyRequest {
    actor: string;
    rawBody?: string;
  }
}

const idParam = z.object({ id: z.uuid() });

export function buildApp({ db, gateway, config, logger = false }: AppDeps) {
  const app = Fastify({ logger, bodyLimit: 2 * 1024 * 1024 });

  // Keep the raw body: provider callbacks are signed over the exact bytes sent.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    req.rawBody = body as string;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new AppError(400, "invalid_json", "request body is not valid JSON"), undefined);
    }
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "validation_failed", message: "invalid request", issues: err.issues });
    }
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    }
    if (err?.code === "23505") return reply.code(409).send({ error: "conflict", message: err.detail ?? err.message });
    if (err?.code === "42501") return reply.code(403).send({ error: "forbidden", message: err.message });
    if (err?.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: "bad_request", message: err.message });
    }
    req.log.error(err);
    return reply.code(500).send({ error: "internal", message: "internal error" });
  });

  /** Bearer API keys. Gantries get a key that can only ingest passages. */
  const requireRole = (...roles: Role[]) => async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? "";
    const key = header.startsWith("Bearer ") ? header.slice(7) : "";
    const role: Role | null = key === config.adminApiKey ? "admin" : key === config.ingestApiKey ? "ingest" : null;
    if (!role) return reply.code(401).send({ error: "unauthorized", message: "missing or invalid API key" });
    if (!roles.includes(role)) return reply.code(403).send({ error: "forbidden", message: `requires ${roles.join(" or ")}` });
    req.actor = role === "admin" ? "admin" : "gantry";
  };
  const admin = { preHandler: requireRole("admin") };

  const topupDeps: TopupDeps = {
    db,
    gateway,
    callbackBaseUrl: config.publicBaseUrl,
    minThebe: config.topupMinThebe,
    maxThebe: config.topupMaxThebe,
  };

  app.get("/health", async () => {
    await db.query("SELECT 1");
    return { ok: true };
  });

  // --- reference data -------------------------------------------------------
  app.get("/vehicle-classes", admin, async () => (await db.query("SELECT * FROM vehicle_classes ORDER BY code")).rows);
  app.get("/gantries", admin, async () => (await db.query("SELECT * FROM gantries ORDER BY km")).rows);
  app.get("/tariffs", admin, async (req) => {
    const { at } = z.object({ at: z.coerce.date().optional() }).parse(req.query);
    const { rows } = await db.query(
      `SELECT * FROM tariffs WHERE valid_from <= $1 AND (valid_to IS NULL OR valid_to > $1)
       ORDER BY gantry_id, vehicle_class`,
      [at ?? new Date()],
    );
    return rows;
  });
  app.post("/tariffs", admin, async (req, reply) => {
    const tariff = await scheduleTariff(db, newTariffInput.parse(req.body), req.actor);
    return reply.code(201).send(tariff);
  });

  // --- accounts and vehicles -----------------------------------------------
  app.post("/accounts", admin, async (req, reply) => {
    return reply.code(201).send(await createAccount(db, createAccountInput.parse(req.body), req.actor));
  });
  app.get("/accounts/:id", admin, async (req) => getAccount(db, idParam.parse(req.params).id));
  app.patch("/accounts/:id/status", admin, async (req) =>
    setAccountStatus(db, idParam.parse(req.params).id, accountStatusInput.parse(req.body), req.actor),
  );
  app.post("/accounts/:id/vehicles", admin, async (req, reply) => {
    const vehicle = await registerVehicle(db, idParam.parse(req.params).id, registerVehicleInput.parse(req.body), req.actor);
    return reply.code(201).send(vehicle);
  });
  app.get("/accounts/:id/vehicles", admin, async (req) => listVehicles(db, idParam.parse(req.params).id));
  app.delete("/vehicles/:id", admin, async (req) => deactivateVehicle(db, idParam.parse(req.params).id, req.actor));
  app.get("/accounts/:id/statement", admin, async (req) =>
    buildStatement(db, idParam.parse(req.params).id, statementQuery.parse(req.query)),
  );

  // --- passages -------------------------------------------------------------
  const ingestOpts = (actor: string) => ({ actor, graceDays: config.violationGraceDays });

  app.post("/passages", { preHandler: requireRole("ingest", "admin") }, async (req, reply) => {
    const body = req.body as any;
    if (body && Array.isArray(body.events)) {
      const { events } = passageBatchInput.parse(body);
      const results = [];
      for (const raw of events) {
        const parsed = passageInput.safeParse(raw);
        const id = (raw as any)?.source_event_id ?? null;
        if (!parsed.success) {
          results.push({ source_event_id: id, ok: false, error: "validation_failed", issues: parsed.error.issues });
          continue;
        }
        try {
          const r = await ingestPassage(db, parsed.data, ingestOpts(req.actor));
          results.push({ source_event_id: id, ok: true, ...summarize(r) });
        } catch (err: any) {
          if (!(err instanceof AppError)) throw err;
          results.push({ source_event_id: id, ok: false, error: err.code, message: err.message });
        }
      }
      return reply.code(200).send({ results });
    }
    const r = await ingestPassage(db, passageInput.parse(body), ingestOpts(req.actor));
    return reply.code(r.duplicate ? 200 : 201).send(summarize(r));
  });
  app.get("/passages", admin, async (req) => listPassages(db, passageQuery.parse(req.query)));

  // --- top-ups and provider callbacks ---------------------------------------
  app.post("/accounts/:id/topups", admin, async (req, reply) => {
    const key = req.headers["idempotency-key"];
    const { topup, replayed } = await startTopup(
      topupDeps,
      idParam.parse(req.params).id,
      topupInput.parse(req.body),
      req.actor,
      typeof key === "string" && key ? key : undefined,
    );
    return reply.code(replayed ? 200 : 202).send(topup);
  });
  app.get("/topups/:id", admin, async (req) => getTopup(db, idParam.parse(req.params).id));

  app.post("/payments/callbacks/:provider", async (req, reply) => {
    const { provider } = z.object({ provider: z.enum(PROVIDERS) }).parse(req.params);
    const ok = verifyCallbackSignature(
      config.momoWebhookSecret,
      header(req, "x-momo-timestamp"),
      header(req, "x-momo-signature"),
      req.rawBody ?? "",
    );
    if (!ok) return reply.code(401).send({ error: "bad_signature", message: "callback signature invalid or expired" });
    const body = callbackInput.parse(req.body);
    const result = await applyPaymentResult(
      db,
      {
        provider,
        reference: body.reference,
        providerRef: body.provider_ref,
        status: body.status,
        amountThebe: body.amount_thebe,
        failureReason: body.failure_reason,
      },
      `provider:${provider}`,
    );
    return { received: true, applied: result.applied, topup_status: result.topup.status };
  });

  app.post("/admin/reconcile-topups", admin, async (req) => {
    const { older_than_seconds } = z
      .object({ older_than_seconds: z.number().int().min(0).default(300) })
      .parse(req.body ?? {});
    return reconcilePendingTopups(topupDeps, older_than_seconds);
  });

  // --- violations -----------------------------------------------------------
  app.get("/violations", admin, async (req) => listViolations(db, violationQuery.parse(req.query)));
  app.post("/violations/:id/settle", admin, async (req) =>
    settleViolation(db, idParam.parse(req.params).id, settleInput.parse(req.body).account_id, req.actor),
  );
  app.post("/violations/:id/waive", admin, async (req) =>
    waiveViolation(db, idParam.parse(req.params).id, waiveInput.parse(req.body).reason, req.actor),
  );

  // --- audit ----------------------------------------------------------------
  app.get("/audit", admin, async (req) => {
    const f = z
      .object({
        entity_type: z.string().optional(),
        entity_id: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(200),
      })
      .parse(req.query);
    const { rows } = await db.query(
      `SELECT * FROM audit_log
       WHERE ($1::text IS NULL OR entity_type = $1) AND ($2::text IS NULL OR entity_id = $2)
       ORDER BY seq DESC LIMIT $3`,
      [f.entity_type ?? null, f.entity_id ?? null, f.limit],
    );
    return rows;
  });
  app.get("/audit/verify", admin, async () => verifyAuditChain(db));

  return app;
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function summarize(r: Awaited<ReturnType<typeof ingestPassage>>) {
  return {
    duplicate: r.duplicate,
    passage_id: r.passage.id,
    status: r.passage.status,
    amount_thebe: r.passage.amount_thebe,
    charged_class: r.passage.charged_class,
    match_method: r.passage.match_method,
    class_mismatch: r.passage.class_mismatch,
    violation_id: r.violation?.id ?? null,
    violation_reason: r.violation?.reason ?? null,
  };
}
