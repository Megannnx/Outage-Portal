import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type DB = NodePgDatabase<typeof schema>;
/** Either the root db or an open transaction — every service function accepts this. */
export type Tx = DB | Parameters<Parameters<DB["transaction"]>[0]>[0];

const g = globalThis as unknown as { __portalPool?: Pool; __portalDb?: DB };

export function getPool(): Pool {
  if (!g.__portalPool) {
    // DATABASE_URL, or POSTGRES_URL as injected by the Supabase ↔ Vercel integration (transaction pooler).
    const raw = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!raw) throw new Error("DATABASE_URL (or POSTGRES_URL) is not set");
    const u = new URL(raw);
    const wantsSsl = process.env.DATABASE_SSL === "true" || ["require", "verify-ca", "verify-full", "prefer"].includes(u.searchParams.get("sslmode") ?? "");
    // node-postgres treats sslmode in the URL as verify-full; we configure TLS explicitly instead.
    for (const k of ["sslmode", "supa", "pgbouncer"]) u.searchParams.delete(k);
    g.__portalPool = new Pool({
      connectionString: u.toString(),
      max: Number(process.env.DATABASE_POOL_MAX ?? (process.env.VERCEL ? 3 : 10)),
      idleTimeoutMillis: process.env.VERCEL ? 5_000 : 30_000,
      ssl: wantsSsl ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === "true" } : undefined,
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
