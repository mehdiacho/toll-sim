export interface Config {
  port: number;
  host: string;
  /** postgres:// URL. When unset, PGlite is used (in memory, or PGLITE_DIR). */
  databaseUrl?: string;
  pgliteDir?: string;
  adminApiKey: string;
  ingestApiKey: string;
  momoBaseUrl: string;
  momoWebhookSecret: string;
  /** Base URL the payment service uses to reach our callback endpoint. */
  publicBaseUrl: string;
  violationGraceDays: number;
  /** Plate reads under this ANPR confidence, with no tag match, wait for manual review. */
  reviewConfidenceThreshold: number;
  topupMinThebe: number;
  topupMaxThebe: number;
  enforcement: EnforcementPolicy;
  /** Run the enforcement ladder on a timer (minutes); 0 leaves it to POST /admin/run-enforcement. */
  enforcementIntervalMinutes: number;
  /** Days after a passage during which the motorist can dispute it. */
  disputeWindowDays: number;
  customerSessionDays: number;
  /** Development only: return the sign-in code in the API response instead of only "sending" it. */
  exposeLoginCodes: boolean;
  /** Public demo: GET /dashboard/data needs no key (the numbers are synthetic). */
  publicDashboard: boolean;
  /** Public demo: POST /auth/demo hands out a sandbox motorist account. */
  demoSignin: boolean;
  /** Behind Cloudflare: take the client address from CF-Connecting-IP / X-Forwarded-For for rate limits. */
  trustProxy: boolean;
  /** Most viewers the live 3D feed will stream to at once. */
  liveMaxClients: number;
}

export interface EnforcementPolicy {
  /** Added when the grace period ends and the first notice goes out. */
  adminFeeThebe: number;
  /** Added with the final notice. */
  lateFeeThebe: number;
  /** Days from the first notice to the final notice. */
  finalNoticeDays: number;
  /** Days from the final notice to referral (the roadside hotlist). */
  referralDays: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    databaseUrl: env.DATABASE_URL || undefined,
    pgliteDir: env.PGLITE_DIR || undefined,
    adminApiKey: required(env, "ADMIN_API_KEY"),
    ingestApiKey: required(env, "INGEST_API_KEY"),
    momoBaseUrl: env.MOMO_BASE_URL ?? "http://localhost:4000",
    momoWebhookSecret: required(env, "MOMO_WEBHOOK_SECRET"),
    publicBaseUrl: env.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
    violationGraceDays: Number(env.VIOLATION_GRACE_DAYS ?? 7),
    reviewConfidenceThreshold: Number(env.REVIEW_CONFIDENCE_THRESHOLD ?? 0.96),
    topupMinThebe: Number(env.TOPUP_MIN_THEBE ?? 1000),
    topupMaxThebe: Number(env.TOPUP_MAX_THEBE ?? 500000),
    enforcement: {
      adminFeeThebe: Number(env.ENFORCEMENT_ADMIN_FEE_THEBE ?? 5000),
      lateFeeThebe: Number(env.ENFORCEMENT_LATE_FEE_THEBE ?? 15000),
      finalNoticeDays: Number(env.ENFORCEMENT_FINAL_NOTICE_DAYS ?? 14),
      referralDays: Number(env.ENFORCEMENT_REFERRAL_DAYS ?? 14),
    },
    enforcementIntervalMinutes: Number(env.ENFORCEMENT_INTERVAL_MINUTES ?? 0),
    disputeWindowDays: Number(env.DISPUTE_WINDOW_DAYS ?? 90),
    customerSessionDays: Number(env.CUSTOMER_SESSION_DAYS ?? 30),
    exposeLoginCodes: env.EXPOSE_LOGIN_CODES === "1",
    publicDashboard: env.PUBLIC_DASHBOARD === "1",
    demoSignin: env.DEMO_SIGNIN === "1",
    trustProxy: env.TRUST_PROXY === "1",
    liveMaxClients: Number(env.LIVE_MAX_CLIENTS ?? 300),
  };
}
