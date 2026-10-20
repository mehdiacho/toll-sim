import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { AppError } from "./errors.js";
import { LiveHub, liveFrameInput, RateLimiter } from "./live.js";
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
import {
  assertMyViolation,
  demoSignIn,
  logout,
  myNotices,
  myPassages,
  myPassagesQuery,
  myViolations,
  overview,
  sessionAccount,
  startLogin,
  startLoginInput,
  updateProfile,
  updateProfileInput,
  verifyLogin,
  verifyLoginInput,
} from "./services/customers.js";
import {
  canActOnPassage,
  disputeQuery,
  getDispute,
  getEvidence,
  getPassageImage,
  listDisputes,
  raiseDispute,
  raiseDisputeInput,
  resolveDispute,
  resolveDisputeInput,
} from "./services/disputes.js";
import { hotlist, runEnforcement } from "./services/enforcement.js";
import { epoch } from "./services/maintenance.js";
import { listOutbox, outboxQuery } from "./services/outbox.js";
import { dashboardSnapshot } from "./services/dashboard.js";
import { getReview, getReviewImage, listReviews, resolveInput, resolveReview, reviewQuery } from "./services/reviews.js";
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
  /** Shared with the server so it can close the streams on shutdown. */
  live?: LiveHub;
}

type Role = "admin" | "ingest";

declare module "fastify" {
  interface FastifyRequest {
    actor: string;
    /** Set on customer-app requests: the signed-in motorist's account. */
    accountId: string;
    rawBody?: string;
  }
}

const idParam = z.object({ id: z.uuid() });
const evidenceParam = z.object({ id: z.uuid(), evidenceId: z.uuid() });
const bearer = (req: FastifyRequest) => {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
};

export function buildApp({ db, gateway, config, logger = false, live = new LiveHub(config.liveMaxClients) }: AppDeps) {
  const base = config.basePath;
  const app = Fastify({
    logger,
    // Public routes take small bodies; the few that carry images raise it per route.
    bodyLimit: 1024 * 1024,
    // Behind a proxy that mounts the app under BASE_PATH, strip the prefix so every
    // route is registered once and answers at both /x and BASE_PATH/x.
    rewriteUrl: (req) => {
      const url = req.url ?? "/";
      if (!base || !url.startsWith(base)) return url;
      const rest = url.slice(base.length);
      if (rest === "" || rest.startsWith("?")) return "/" + rest;
      return rest.startsWith("/") ? rest : url;
    },
  });
  app.addHook("onClose", async () => live.close());
  const bigBody = { bodyLimit: 8 * 1024 * 1024 };

  // BASE_PATH without the trailing slash: send the browser to BASE_PATH/ so the
  // pages' relative links resolve under the prefix.
  app.addHook("onRequest", async (req, reply) => {
    if (!base) return;
    const raw = req.originalUrl ?? req.raw.url ?? "";
    const q = raw.indexOf("?");
    const path = q < 0 ? raw : raw.slice(0, q);
    if (path === base) return reply.redirect(base + "/" + (q < 0 ? "" : raw.slice(q)), 301);
  });

  // Security headers on everything the app answers (the SSE stream sets its own).
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    reply.header("x-frame-options", "SAMEORIGIN");
    reply.header("cross-origin-opener-policy", "same-origin");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
    reply.header("content-security-policy", CSP);
    return payload;
  });

  // Rate limits for what a public visitor can reach. Behind the Cloudflare tunnel
  // (TRUST_PROXY=1) the client address is Cloudflare's CF-Connecting-IP; otherwise
  // that header is ignored, since anyone could send it.
  const clientIp = (req: FastifyRequest) => (config.trustProxy && header(req, "cf-connecting-ip")?.trim()) || req.ip;
  const limited = (limiter: RateLimiter) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!limiter.allow(clientIp(req))) {
      return reply.code(429).send({ error: "rate_limited", message: "too many requests; slow down and try again in a minute" });
    }
  };
  const demoLimit = limited(new RateLimiter(5, 60 * 60_000));
  const codeLimit = limited(new RateLimiter(20, 60 * 60_000));
  const writeLimiter = new RateLimiter(60, 60_000);
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "GET" || req.method === "HEAD") return;
    if (!req.url.startsWith("/me") && !req.url.startsWith("/auth")) return;
    if (!writeLimiter.allow(clientIp(req))) {
      return reply.code(429).send({ error: "rate_limited", message: "too many requests; slow down and try again in a minute" });
    }
  });

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

  /** Customer-app session tokens, issued by POST /auth/verify. */
  const customer = {
    preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
      const accountId = await sessionAccount(db, bearer(req));
      if (!accountId) return reply.code(401).send({ error: "unauthorized", message: "please sign in again" });
      req.accountId = accountId;
      req.actor = `customer:${accountId}`;
    },
  };

  const topupDeps: TopupDeps = {
    db,
    gateway,
    callbackBaseUrl: config.publicBaseUrl,
    minThebe: config.topupMinThebe,
    maxThebe: config.topupMaxThebe,
  };

  app.get("/health", async () => {
    await db.query("SELECT 1");
    return { ok: true, epoch: epoch() };
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
  const ingestOpts = (actor: string) => ({
    actor,
    graceDays: config.violationGraceDays,
    reviewThreshold: config.reviewConfidenceThreshold,
  });

  app.post("/passages", { ...bigBody, preHandler: requireRole("ingest", "admin") }, async (req, reply) => {
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

  // --- manual plate review ---------------------------------------------------
  app.get("/reviews", admin, async (req) => listReviews(db, reviewQuery.parse(req.query)));
  app.get("/reviews/:id", admin, async (req) => getReview(db, idParam.parse(req.params).id));
  app.get("/reviews/:id/image", admin, async (req, reply) => {
    const image = await getReviewImage(db, idParam.parse(req.params).id);
    if (!image) return reply.code(404).send({ error: "no_image", message: "the camera sent no image for this read" });
    return reply.type(image.type).header("cache-control", "private, max-age=3600").send(image.bytes);
  });
  app.post("/reviews/:id/resolve", admin, async (req) =>
    resolveReview(db, idParam.parse(req.params).id, resolveInput.parse(req.body), req.actor, config.violationGraceDays),
  );

  // --- violations -----------------------------------------------------------
  app.get("/violations", admin, async (req) => listViolations(db, violationQuery.parse(req.query)));
  app.post("/violations/:id/settle", admin, async (req) =>
    settleViolation(db, idParam.parse(req.params).id, settleInput.parse(req.body).account_id, req.actor),
  );
  app.post("/violations/:id/waive", admin, async (req) =>
    waiveViolation(db, idParam.parse(req.params).id, waiveInput.parse(req.body).reason, req.actor),
  );

  // --- enforcement -----------------------------------------------------------
  app.post("/admin/run-enforcement", admin, async (req) => {
    const { at } = z.object({ at: z.coerce.date().optional() }).parse(req.body ?? {});
    return runEnforcement(db, config.enforcement, at ?? new Date(), req.actor);
  });
  app.get("/enforcement/hotlist", admin, async () => hotlist(db));
  app.get("/admin/outbox", admin, async (req) => listOutbox(db, outboxQuery.parse(req.query)));

  // --- disputes (operator side) ----------------------------------------------
  app.get("/disputes", admin, async (req) => listDisputes(db, disputeQuery.parse(req.query)));
  app.post("/disputes", { ...bigBody, ...admin }, async (req, reply) => {
    const d = await raiseDispute(db, raiseDisputeInput.parse(req.body), { actor: req.actor, windowDays: config.disputeWindowDays });
    return reply.code(201).send(d);
  });
  app.get("/disputes/:id", admin, async (req) => getDispute(db, idParam.parse(req.params).id));
  app.get("/disputes/:id/evidence/:evidenceId", admin, async (req, reply) => {
    const { id, evidenceId } = evidenceParam.parse(req.params);
    const e = await getEvidence(db, id, evidenceId);
    const name = e.filename.replace(/[^\w.\- ]/g, "_");
    return reply.type(e.content_type).header("content-disposition", `inline; filename="${name}"`).send(Buffer.from(e.data));
  });
  app.post("/disputes/:id/resolve", admin, async (req) =>
    resolveDispute(db, idParam.parse(req.params).id, resolveDisputeInput.parse(req.body), req.actor),
  );
  app.get("/passages/:id/image", admin, async (req, reply) => sendImage(reply, await getPassageImage(db, idParam.parse(req.params).id)));

  // --- customer app ------------------------------------------------------------
  app.post("/auth/demo", { preHandler: demoLimit }, async (req, reply) => {
    if (!config.demoSignin) return reply.code(404).send({ error: "not_found", message: "demo sign-in is not enabled here" });
    return demoSignIn(db, config.demoAccountHours, live.drivingUnregistered());
  });
  // On the public demo nobody is asked for a phone number: sign-in is the sandbox only.
  const smsSignin = !config.demoSignin || config.exposeLoginCodes;
  app.get("/auth/options", async () => ({ demo: config.demoSignin, sms: smsSignin, demo_hours: config.demoAccountHours }));
  app.post("/auth/code", { preHandler: codeLimit }, async (req, reply) => {
    if (!smsSignin) return reply.code(404).send({ error: "not_found", message: "this demo signs in with a sandbox account only" });
    return startLogin(db, startLoginInput.parse(req.body).phone, config.exposeLoginCodes);
  });
  app.post("/auth/verify", async (req) => verifyLogin(db, verifyLoginInput.parse(req.body), config.customerSessionDays));
  app.post("/auth/logout", customer, async (req) => {
    await logout(db, bearer(req));
    return { ok: true };
  });

  app.get("/me", customer, async (req) => overview(db, req.accountId));
  app.patch("/me", customer, async (req) => updateProfile(db, req.accountId, updateProfileInput.parse(req.body)));
  app.get("/me/vehicle-classes", customer, async () => (await db.query("SELECT * FROM vehicle_classes ORDER BY code")).rows);
  app.post("/me/vehicles", customer, async (req, reply) => {
    // Motorists register plates; tags are issued at the counter, so the app can't set one.
    const input = registerVehicleInput.parse({ ...(req.body as object), tag_id: undefined });
    return reply.code(201).send(await registerVehicle(db, req.accountId, input, req.actor));
  });
  app.delete("/me/vehicles/:id", customer, async (req) => deactivateVehicle(db, idParam.parse(req.params).id, req.actor, req.accountId));
  app.get("/me/passages", customer, async (req) => myPassages(db, req.accountId, myPassagesQuery.parse(req.query)));
  app.get("/me/passages/:id/image", customer, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    if (!(await canActOnPassage(db, req.accountId, id))) return reply.code(404).send({ error: "not_found", message: "passage not found" });
    return sendImage(reply, await getPassageImage(db, id));
  });
  app.get("/me/statement", customer, async (req) => buildStatement(db, req.accountId, statementQuery.parse(req.query)));
  app.post("/me/topups", customer, async (req, reply) => {
    const key = req.headers["idempotency-key"];
    const { topup, replayed } = await startTopup(
      topupDeps,
      req.accountId,
      topupInput.parse(req.body),
      req.actor,
      typeof key === "string" && key ? key : undefined,
    );
    return reply.code(replayed ? 200 : 202).send(topup);
  });
  app.get("/me/topups/:id", customer, async (req, reply) => {
    const t = await getTopup(db, idParam.parse(req.params).id);
    if (t.account_id !== req.accountId) return reply.code(404).send({ error: "not_found", message: "top-up not found" });
    return t;
  });
  app.get("/me/violations", customer, async (req) => myViolations(db, req.accountId));
  app.post("/me/violations/:id/pay", customer, async (req) => {
    const { id } = idParam.parse(req.params);
    await assertMyViolation(db, req.accountId, id);
    return settleViolation(db, id, req.accountId, req.actor);
  });
  app.get("/me/disputes", customer, async (req) => (await listDisputes(db, { account_id: req.accountId, limit: 100 })).items);
  app.post("/me/disputes", { ...bigBody, ...customer }, async (req, reply) => {
    const d = await raiseDispute(db, raiseDisputeInput.parse(req.body), {
      actor: req.actor,
      accountId: req.accountId,
      windowDays: config.disputeWindowDays,
    });
    return reply.code(201).send(d);
  });
  app.get("/me/disputes/:id", customer, async (req, reply) => {
    const d = await getDispute(db, idParam.parse(req.params).id);
    if (d.account_id !== req.accountId) return reply.code(404).send({ error: "not_found", message: "dispute not found" });
    // The motorist sees the decision and their own evidence list, not the operator's working.
    const { history: _history, vehicles: _vehicles, camera: _camera, holder_name: _name, ...visible } = d;
    return visible;
  });
  app.get("/me/notices", customer, async (req) => myNotices(db, req.accountId));

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

  // --- operations dashboard -------------------------------------------------
  // The page and the corridor map are public; the numbers need the admin key,
  // which the page asks for and keeps in localStorage.
  // HTML gets the demo footer and, under BASE_PATH, its root-relative URLs prefixed.
  const page =
    (folder: string, name: string, type = "text/html; charset=utf-8") =>
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const file = readFileSync(join(assetDir(folder), name));
      if (type.startsWith("text/html")) return reply.type(type).send(preparePage(file.toString("utf8"), base, folder));
      if (name.endsWith(".webmanifest") && base) return reply.type(type).send(file.toString("utf8").replaceAll('"/app', `"${base}/app`));
      return reply.type(type).send(file);
    };
  app.get("/dashboard", page("dashboard", "index.html"));
  app.get("/dashboard/review", page("dashboard", "review.html"));
  app.get("/dashboard/disputes", page("dashboard", "disputes.html"));
  app.get("/dashboard/corridor.json", page("dashboard", "corridor.json", "application/json"));
  // The motorist app: one page that talks to /auth and /me.
  app.get("/app", page("customer", "index.html"));
  app.get("/app/manifest.webmanifest", page("customer", "manifest.webmanifest", "application/manifest+json"));
  app.get("/dashboard/data", config.publicDashboard ? {} : admin, async (req) => {
    const { window_minutes } = z
      .object({ window_minutes: z.coerce.number().int().min(5).max(24 * 60).default(60) })
      .parse(req.query);
    return dashboardSnapshot(db, window_minutes);
  });

  // --- live 3D view ------------------------------------------------------------
  // The simulation pushes frames with the ingest key; anyone can watch.
  app.post("/live/frame", { ...bigBody, preHandler: requireRole("ingest", "admin") }, async (req) => {
    live.publish(liveFrameInput.parse(req.body));
    return { ok: true, watchers: live.watchers };
  });
  // The feed is public and read-only, so other origins (a viewer in development) may read it.
  const openRead = {
    onSend: async (_req: FastifyRequest, reply: FastifyReply) => {
      reply.header("access-control-allow-origin", "*");
    },
  };
  app.get("/live/stream", async (req, reply) => live.stream(req, reply));
  app.get("/live/snapshot", openRead, async (_req, reply) => {
    reply.header("cache-control", "no-store");
    return live.snapshot();
  });
  app.get("/live/summary", openRead, async () => liveSummary());
  app.get("/live", page("live", "index.html"));
  app.get("/live/road.json", page("live", "road.json", "application/json"));
  app.get("/live/vendor/three.module.min.js", vendor("three/build/three.module.min.js"));
  app.get("/live/vendor/three.core.min.js", vendor("three/build/three.core.min.js"));
  app.get("/live/vendor/OrbitControls.js", vendor("three/examples/jsm/controls/OrbitControls.js"));

  // Small headline numbers for the live view and the project page, cached briefly.
  let summary: { at: number; data: unknown } | null = null;
  async function liveSummary() {
    if (summary && Date.now() - summary.at < 10_000) return summary.data;
    const { rows } = await db.query(
      `SELECT
         (SELECT count(*) FROM passages WHERE passed_at >= $1)::int AS passages_today,
         (SELECT coalesce(sum(amount_thebe), 0) FROM passages WHERE passed_at >= $1 AND status = 'charged')::bigint AS revenue_today_thebe,
         (SELECT count(*) FROM passages WHERE passed_at >= now() - interval '1 hour')::int AS passages_last_hour,
         (SELECT count(*) FROM violations WHERE status = 'open')::int AS open_violations,
         (SELECT count(*) FROM plate_reviews WHERE status = 'open')::int AS open_reviews,
         (SELECT count(*) FROM disputes WHERE status = 'open')::int AS open_disputes,
         (SELECT count(*) FROM accounts)::int AS accounts,
         (SELECT count(*) FROM vehicles WHERE active)::int AS vehicles,
         (SELECT count(*) FROM passages)::bigint AS passages_total`,
      [startOfBotswanaDay()],
    );
    const data = { ...Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, Number(v)])), watchers: live.watchers };
    summary = { at: Date.now(), data };
    return data;
  }

  // The landing page: links to the live view, the dashboard and the motorist app.
  app.get("/", page("site", "index.html"));

  return app;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

export const DEMO_NOTICE =
  "Independent demo with synthetic data. Not affiliated with the Government of Botswana, any ministry, toll operator or payment provider.";

/**
 * Adds the demo footer to a page and, when the app is mounted under a prefix,
 * makes its root-relative URLs work there: href/src/action attributes are
 * rewritten, and fetch/EventSource calls to "/..." get the prefix at run time.
 */
export function preparePage(html: string, base: string, folder = ""): string {
  const shim = base
    ? `<script>(function(){var B=${JSON.stringify(base)};window.TOLL_BASE=B;` +
      `var fix=function(u){return typeof u==="string"&&u.charAt(0)==="/"&&u.charAt(1)!=="/"&&u.indexOf(B+"/")!==0?B+u:u};` +
      `var f=window.fetch;window.fetch=function(u,o){return f.call(this,fix(u),o)};` +
      `var E=window.EventSource;if(E){var P=function(u,o){return new E(fix(u),o)};P.prototype=E.prototype;window.EventSource=P}})();</script>`
    : `<script>window.TOLL_BASE="";</script>`;
  let out = base ? html.replace(/(\s(?:href|src|action)=")\/(?!\/)/g, `$1${base}/`) : html;
  out = /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (m) => m + shim) : shim + out;
  // The motorist app has a fixed tab bar at the bottom; keep the notice clear of it.
  const pad = folder === "customer" ? "16px 16px calc(88px + env(safe-area-inset-bottom))" : "16px";
  const footer =
    `<footer class="demo-notice" style="font:12px/1.4 system-ui,sans-serif;color:#6b7a76;text-align:center;padding:${pad};max-width:720px;margin:0 auto">` +
    `${DEMO_NOTICE}</footer>`;
  return /<\/body>/i.test(out) ? out.replace(/<\/body>/i, footer + "</body>") : out + footer;
}

/** Midnight in Botswana (UTC+2 all year, no daylight saving) as an instant. */
function startOfBotswanaDay(now = Date.now()) {
  const shifted = new Date(now + 2 * 3600_000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - 2 * 3600_000);
}

/** Serves one file from node_modules (three.js for the live view), cached for a day. */
function vendor(path: string) {
  const require = createRequire(import.meta.url);
  let body: Buffer | null = null;
  return async (_req: FastifyRequest, reply: FastifyReply) => {
    body ??= readFileSync(require.resolve(path));
    return reply.type("text/javascript; charset=utf-8").header("cache-control", "public, max-age=86400").send(body);
  };
}

/** Finds a static folder of the repo (dashboard/, customer/) whether running from src/ (tsx) or dist/ (node). */
function assetDir(folder: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, folder, "index.html"))) return join(dir, folder);
    dir = dirname(dir);
  }
  throw new AppError(404, "not_found", `${folder} files are not installed`);
}

function sendImage(reply: FastifyReply, image: { bytes: Buffer; type: string } | null) {
  if (!image) return reply.code(404).send({ error: "no_image", message: "the camera kept no image of this passage" });
  return reply.type(image.type).header("cache-control", "private, max-age=3600").send(image.bytes);
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
    review_id: r.review_id ?? null,
    hotlist: r.hotlist ?? null,
  };
}
