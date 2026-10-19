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
  topupMinThebe: number;
  topupMaxThebe: number;
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
    topupMinThebe: Number(env.TOPUP_MIN_THEBE ?? 1000),
    topupMaxThebe: Number(env.TOPUP_MAX_THEBE ?? 500000),
  };
}
