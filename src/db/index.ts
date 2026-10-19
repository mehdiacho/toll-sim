import pg from "pg";

export interface QueryResult<T> {
  rows: T[];
}

/** Anything that can run a parameterised statement: the pool, or a transaction. */
export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  /** Run fn in a single transaction. Inside fn, use only the q it is given. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Run a multi-statement script with no parameters (migrations, seed). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return {
    query: (sql, params) => pool.query(sql, params as any[]) as Promise<QueryResult<any>>,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({ query: (sql, params) => client.query(sql, params as any[]) as Promise<QueryResult<any>> });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async exec(sql) {
      await pool.query(sql);
    },
    close: () => pool.end(),
  };
}

/**
 * In-process Postgres (PGlite, Postgres compiled to WASM). Used by the tests and
 * by `npm run dev:lite`, so the back office runs on a machine with no Docker.
 * dataDir undefined = in-memory.
 */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const lite = await PGlite.create(dataDir);
  return {
    query: (sql, params) => lite.query(sql, params as any[]) as Promise<QueryResult<any>>,
    tx: (fn) =>
      lite.transaction((t) => fn({ query: (sql, params) => t.query(sql, params as any[]) as Promise<QueryResult<any>> })),
    async exec(sql) {
      await lite.exec(sql);
    },
    close: () => lite.close(),
  };
}
