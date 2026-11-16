/**
 * One-time setup for hosted deployments: migrations, reference data, first administrator.
 * Allowed only while no user exists (first run) or for a signed-in administrator (re-run migrations).
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db/client";
import { runMigrations } from "./db/migrate";
import { roles, users } from "./db/schema";
import { seedReferenceData, ROLE_ROWS } from "./domain/seed-data";
import { AppError } from "./lib/errors";
import { hashPassword } from "./auth/session";
import { audit } from "./audit/audit";
import { deliveryMode } from "./comms/adapters";
import { seedDemoSites } from "./demo";

export async function needsFirstAdmin(): Promise<boolean> {
  const db = getDb();
  try {
    const r = await db.execute(sql`select count(*)::int as n from users`);
    return (r.rows[0] as { n: number }).n === 0;
  } catch { return true; } // tables not created yet
}

export async function runSetup(opts: { admin?: { name: string; email: string; password: string }; demo?: boolean }) {
  // Two simultaneous first runs can race on CREATE SCHEMA; the loser waits and retries (migrations are idempotent).
  try { await runMigrations(); } catch { await new Promise((r) => setTimeout(r, 3000)); await runMigrations(); }
  const db = getDb();
  for (const r of ROLE_ROWS) await db.insert(roles).values(r).onConflictDoNothing();
  let adminId: string | null = null;
  if (opts.admin) {
    const passwordHash = await hashPassword(opts.admin.password);
    const admin = opts.admin;
    adminId = await db.transaction(async (tx) => {
      // Serialise first-run requests: only the first one can create the administrator.
      await tx.execute(sql`select pg_advisory_xact_lock(7210003)`);
      const r = await tx.execute(sql`select count(*)::int as n from users`);
      if ((r.rows[0] as { n: number }).n > 0) throw new AppError("forbidden", "Setup has already been completed", 403);
      const [u] = await tx.insert(users).values({ email: admin.email.toLowerCase(), name: admin.name, role: "admin", passwordHash }).returning();
      await audit(tx, { id: u.id, label: u.email }, "setup.first_admin_created", "user", u.id);
      return u.id;
    });
  }
  const demo = !!opts.demo && deliveryMode() === "capture";
  await seedReferenceData(db, { publishAs: demo ? adminId : null });
  if (demo) await seedDemoSites(db);
  return { demo };
}
