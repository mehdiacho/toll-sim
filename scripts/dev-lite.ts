// Runs the back office and the mock payment service in one process, on PGlite,
// so the whole thing works on a machine with no Docker and no Postgres.
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPgliteDb } from "../src/db/index.js";
import { migrate, seed } from "../src/db/migrate.js";
import { createMomoApp } from "../src/momo/app.js";
import { httpGateway } from "../src/payments/gateway.js";

const env = {
  ADMIN_API_KEY: "dev-admin-key",
  INGEST_API_KEY: "dev-ingest-key",
  MOMO_WEBHOOK_SECRET: "dev-webhook-secret",
  PGLITE_DIR: ".pglite",
  ...process.env,
};
const config = loadConfig(env);

const momo = createMomoApp({ secret: config.momoWebhookSecret, logger: true });
await momo.listen({ port: Number(new URL(config.momoBaseUrl).port || 4000), host: "127.0.0.1" });

const db = await createPgliteDb(config.pgliteDir);
await migrate(db);
await seed(db);
const app = buildApp({ db, gateway: httpGateway(config.momoBaseUrl), config, logger: true });
await app.listen({ port: config.port, host: "127.0.0.1" });
console.log(`\ntoll-sim back office on http://127.0.0.1:${config.port}  (admin key: ${config.adminApiKey})`);
