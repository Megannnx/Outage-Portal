import { desc, eq, inArray, sql } from "drizzle-orm";
import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { jobs, monitoringEvents } from "@/server/db/schema";
import { systemMeta } from "@/server/queries";
import { verifyAuditChain } from "@/server/audit/verify";
export const dynamic = "force-dynamic";
export const GET = route({ perm: "admin.config" }, async () => {
  const db = getDb();
  const [meta, dead, counts, unmatched, chain] = await Promise.all([
    systemMeta(db),
    db.select().from(jobs).where(eq(jobs.status, "dead")).orderBy(desc(jobs.completedAt)).limit(50),
    db.execute(sql`select status, count(*)::int as n from jobs where status in ('pending','running') group by status`),
    db.select().from(monitoringEvents).where(inArray(monitoringEvents.processing, ["unmatched"])).orderBy(desc(monitoringEvents.receivedAt)).limit(30),
    verifyAuditChain(db, 2000),
  ]);
  return { ...meta, deadJobs: dead, queue: counts.rows, unmatchedEvents: unmatched, auditChain: chain };
});
