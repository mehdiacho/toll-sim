import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./index.js";

/** Finds the repo's db/ folder whether running from src/ (tsx) or dist/ (node). */
function sqlDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "db", "migrations"))) return join(dir, "db");
    dir = dirname(dir);
  }
  throw new Error("could not find db/migrations");
}

export async function migrate(db: Db): Promise<string[]> {
  const dir = sqlDir();
  await db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const { rows } = await db.query<{ name: string }>("SELECT name FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.name));
  const files = readdirSync(join(dir, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, "migrations", file), "utf8");
    await db.exec(`BEGIN;\n${sql}\nINSERT INTO schema_migrations (name) VALUES ('${file}');\nCOMMIT;`);
    ran.push(file);
  }
  return ran;
}

export async function seed(db: Db): Promise<void> {
  await db.exec(readFileSync(join(sqlDir(), "seed.sql"), "utf8"));
}
