import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { getDb, getPool } from "./client";

export async function runMigrations() {
  await migrate(getDb(), { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
}

if (process.argv[1]?.endsWith("migrate.ts") || process.argv[1]?.endsWith("migrate.js")) {
  runMigrations()
    .then(async () => { console.log("[migrate] done"); await getPool().end(); })
    .catch(async (e) => { console.error("[migrate] failed", e); await getPool().end(); process.exit(1); });
}
