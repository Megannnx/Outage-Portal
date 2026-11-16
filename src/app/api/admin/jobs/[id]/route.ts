import { and, eq } from "drizzle-orm";
import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { jobs } from "@/server/db/schema";
import { audit } from "@/server/audit/audit";
/** Re-queue a dead-letter job (handlers are idempotent). */
export const POST = route({ perm: "admin.config" }, async ({ params, actor }) => {
  const db = getDb();
  await db.update(jobs).set({ status: "pending", attempts: 0, runAt: new Date(), lastError: null }).where(and(eq(jobs.id, Number(params.id)), eq(jobs.status, "dead")));
  await audit(db, actor, "job.requeued", "job", params.id);
});
