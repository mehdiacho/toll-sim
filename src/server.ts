import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPgDb, createPgliteDb } from "./db/index.js";
import { migrate, seed } from "./db/migrate.js";
import { httpGateway } from "./payments/gateway.js";

const config = loadConfig();
const db = config.databaseUrl ? createPgDb(config.databaseUrl) : await createPgliteDb(config.pgliteDir);
const applied = await migrate(db);
await seed(db);

const app = buildApp({ db, gateway: httpGateway(config.momoBaseUrl), config, logger: true });
app.log.info({ applied, database: config.databaseUrl ? "postgres" : `pglite:${config.pgliteDir ?? "memory"}` }, "database ready");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
}

await app.listen({ port: config.port, host: config.host });
