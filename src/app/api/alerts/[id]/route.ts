import { eq } from "drizzle-orm";
import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { alerts } from "@/server/db/schema";
import { audit } from "@/server/audit/audit";
export const POST = route({ perm: "admin.config" }, async ({ params, actor }) => {
  const db = getDb();
  await db.update(alerts).set({ resolvedAt: new Date() }).where(eq(alerts.id, params.id));
  await audit(db, actor, "alert.dismissed", "system_alert", params.id);
});
