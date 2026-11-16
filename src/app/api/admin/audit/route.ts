import { and, desc, eq, lt } from "drizzle-orm";
import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { auditLogs } from "@/server/db/schema";
export const dynamic = "force-dynamic";
export const GET = route({ perm: "admin.audit" }, async ({ req }) => {
  const u = new URL(req.url);
  const before = Number(u.searchParams.get("before") ?? 0);
  const entity = u.searchParams.get("entityType");
  const conds = [];
  if (before) conds.push(lt(auditLogs.id, before));
  if (entity) conds.push(eq(auditLogs.entityType, entity));
  const items = await getDb().select().from(auditLogs).where(conds.length ? and(...conds) : undefined).orderBy(desc(auditLogs.id)).limit(100);
  return { items };
});
