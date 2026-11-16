import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { siteMonitoringIdentifiers, sites } from "@/server/db/schema";
import { processEvent } from "@/server/incidents/lifecycle";
import { deliveryMode } from "@/server/comms/adapters";
import { audit } from "@/server/audit/audit";
import { AppError } from "@/server/lib/errors";

/**
 * Outage simulator (CAPTURE MODE ONLY): feeds a down/up event for a site's critical
 * monitoring identifier through the exact same pipeline NetXMS uses.
 */
export const POST = route({ perm: "admin.config", body: z.object({ siteId: z.string().uuid(), state: z.enum(["down", "up"]) }) }, async ({ body, actor }) => {
  if (deliveryMode() === "live") throw new AppError("forbidden", "The simulator is disabled in live mode", 403);
  const db = getDb();
  const [id] = await db.select({ i: siteMonitoringIdentifiers, code: sites.code }).from(siteMonitoringIdentifiers).innerJoin(sites, eq(sites.id, siteMonitoringIdentifiers.siteId))
    .where(and(eq(siteMonitoringIdentifiers.siteId, body.siteId), eq(siteMonitoringIdentifiers.critical, true)));
  if (!id) throw new AppError("bad_request", "This site has no critical monitoring identifier to simulate", 400);
  const now = new Date();
  const r = await processEvent(db, {
    source: id.i.source === "any" ? "simulator" : id.i.source,
    dedupeKey: `simulator:${id.i.id}:${body.state}:${now.getTime()}`,
    kind: body.state, eventName: body.state === "down" ? "SIMULATED_DOWN" : "SIMULATED_UP",
    objectRef: id.i.matchType === "object_id" ? id.i.value : "", objectName: id.i.matchType !== "object_id" ? id.i.value : `${id.code} (simulated)`,
    occurredAt: now, raw: { simulated: true, by: actor.label },
  });
  await audit(db, actor, `simulator.${body.state}`, "site", body.siteId, null, r);
  return r;
});
