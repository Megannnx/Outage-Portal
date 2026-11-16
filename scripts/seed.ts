/**
 * Production bootstrap (idempotent):
 *   - roles, cause options, fault vocabulary, escalation rules
 *   - starter templates as PENDING APPROVAL (nothing is sendable until an admin approves)
 *   - first administrator from BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD (if no admin exists)
 */
import { eq } from "drizzle-orm";
import { getDb, getPool } from "../src/server/db/client";
import { runMigrations } from "../src/server/db/migrate";
import { users } from "../src/server/db/schema";
import { seedReferenceData } from "../src/server/domain/seed-data";
import { hashPasswordRaw } from "./util";

async function main() {
  await runMigrations();
  const db = getDb();
  await seedReferenceData(db, {});
  const admins = await db.select().from(users).where(eq(users.role, "admin"));
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL, pw = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!admins.length && !(email && pw)) {
    console.log("[seed] no administrator yet — open https://<your-portal>/setup to create the first one");
  } else if (!admins.length && email && pw) {
    if (pw.length < 12) throw new Error("BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters");
    await db.insert(users).values({ email, name: process.env.BOOTSTRAP_ADMIN_NAME ?? "Administrator", role: "admin", passwordHash: await hashPasswordRaw(pw) });
    console.log(`[seed] administrator ${email} created — sign in and enrol MFA, then approve the starter templates`);
  }
  console.log("[seed] reference data ready");
  await getPool().end();
}
main().catch(async (e) => { console.error(e); await getPool().end(); process.exit(1); });
