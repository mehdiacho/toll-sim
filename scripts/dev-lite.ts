// Runs the back office and the mock payment service in one process, on PGlite,
// so the whole thing works on a machine with no Docker and no Postgres.
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPgliteDb } from "../src/db/index.js";
import { migrate, seed } from "../src/db/migrate.js";
import { createMomoApp } from "../src/momo/app.js";
import { httpGateway } from "../src/payments/gateway.js";
import { scheduleEnforcement } from "../src/services/enforcement.js";

const env = {
  ADMIN_API_KEY: "dev-admin-key",
  INGEST_API_KEY: "dev-ingest-key",
  MOMO_WEBHOOK_SECRET: "dev-webhook-secret",
  PGLITE_DIR: ".pglite",
  // No SMS gateway here: the sign-in code comes back in the response so the app can be tried.
  EXPOSE_LOGIN_CODES: "1",
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
scheduleEnforcement(db, config.enforcement, config.enforcementIntervalMinutes, (run) => app.log.info({ run }, "enforcement run"));
console.log(`\ntoll-sim back office on http://127.0.0.1:${config.port}  (admin key: ${config.adminApiKey})`);
console.log(`customer app on http://127.0.0.1:${config.port}/app  (sign-in codes are shown on screen)`);
