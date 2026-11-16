import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type DB = NodePgDatabase<typeof schema>;
/** Either the root db or an open transaction — every service function accepts this. */
export type Tx = DB | Parameters<Parameters<DB["transaction"]>[0]>[0];

const g = globalThis as unknown as { __portalPool?: Pool; __portalDb?: DB };

export function getPool(): Pool {
  if (!g.__portalPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    g.__portalPool = new Pool({
      connectionString: url,
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" } : undefined,
    });
    g.__portalPool.on("error", (err) => console.error("[db] idle client error", err));
  }
  return g.__portalPool;
}

export function getDb(): DB {
  if (!g.__portalDb) g.__portalDb = drizzle(getPool(), { schema });
  return g.__portalDb;
}

/** Test hook: point the app at a different database. */
export async function resetDbForTests(url: string) {
  if (g.__portalPool) await g.__portalPool.end().catch(() => {});
  g.__portalPool = undefined;
  g.__portalDb = undefined;
  process.env.DATABASE_URL = url;
}

export { schema };
