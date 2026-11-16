/**
 * Asynchronous delivery status (delivered / bounced / deferred / complaint) from
 * provider webhooks or the bounce mailbox. "Accepted by the provider" is never
 * treated as "delivered".
 */
import { eq, or } from "drizzle-orm";
import type { DB } from "../db/client";
import { communicationDeliveries, communications, deliveryEvents, recipients, incidents } from "../db/schema";
import { clock } from "../lib/clock";
import { raiseAlert } from "../lib/alerts";
import { getSettings } from "../domain/settings";
import { addTimeline } from "../incidents/timeline";

export interface StatusUpdate { providerMessageId?: string; deliveryId?: string; status: "delivered" | "bounced" | "deferred" | "failed"; detail?: string; hard?: boolean; raw?: unknown }

export async function applyDeliveryStatus(db: DB, u: StatusUpdate): Promise<boolean> {
  return db.transaction(async (tx) => {
    const conds = [u.providerMessageId ? eq(communicationDeliveries.providerMessageId, u.providerMessageId) : undefined, u.deliveryId ? eq(communicationDeliveries.id, u.deliveryId) : undefined].filter(Boolean);
    if (!conds.length) return false;
    const [d] = await tx.select().from(communicationDeliveries).where(or(...(conds as any))).for("update");
    if (!d) return false;
    const now = clock.now();
    await tx.insert(deliveryEvents).values({ deliveryId: d.id, status: u.status, at: now, detail: u.detail ?? "", raw: (u.raw ?? null) as any });
    // A late "deferred" never overrides a final outcome.
    if (u.status === "deferred" && ["delivered", "bounced", "failed"].includes(d.status)) return true;
    await tx.update(communicationDeliveries).set({ status: u.status, error: u.status === "delivered" ? null : u.detail ?? u.status, updatedAt: now }).where(eq(communicationDeliveries.id, d.id));

    if (d.recipientId) {
      const [r] = await tx.select().from(recipients).where(eq(recipients.id, d.recipientId)).for("update");
      if (r && u.status === "delivered") await tx.update(recipients).set({ lastDeliveredAt: now, updatedAt: now }).where(eq(recipients.id, r.id));
      if (r && u.status === "bounced") {
        const s = await getSettings(tx as any);
        const count = r.bounceCount + 1;
        const invalid = u.hard !== false && count >= s.bounceInvalidThreshold;
        await tx.update(recipients).set({ bounceCount: count, lastBounceAt: now, updatedAt: now, ...(invalid ? { status: "invalid", statusReason: `Bounced ${count}×: ${u.detail ?? ""}`.slice(0, 200) } : {}) }).where(eq(recipients.id, r.id));
        if (invalid) await raiseAlert(tx, `recipient_invalid:${r.id}`, "critical", `${r.email} has bounced ${count} times and was marked invalid — this ${r.audience === "isp" ? "ISP" : "recipient"} is no longer receiving outage notices`);
      }
    }
    const [c] = await tx.select().from(communications).where(eq(communications.id, d.communicationId)).for("update");
    if (c && ["sent", "partially_failed", "failed"].includes(c.status)) {
      const ds = await tx.select().from(communicationDeliveries).where(eq(communicationDeliveries.communicationId, c.id));
      const ok = ds.filter((x) => ["accepted", "delivered"].includes(x.status)).length;
      const bad = ds.filter((x) => ["bounced", "failed"].includes(x.status)).length;
      const status = bad === 0 ? "sent" : ok === 0 ? "failed" : "partially_failed";
      if (status !== c.status) await tx.update(communications).set({ status }).where(eq(communications.id, c.id));
      if (u.status === "bounced" || u.status === "failed") {
        const [inc] = await tx.select().from(incidents).where(eq(incidents.id, c.incidentId));
        await addTimeline(tx, c.incidentId, "delivery", `${d.address} ${u.status}: ${u.detail ?? ""}`.trim());
        await raiseAlert(tx, `delivery_failed:${c.id}`, ok ? "warning" : "critical", `${inc?.reference} "${c.kind}": ${d.address} ${u.status}`, c.incidentId);
      }
    }
    return true;
  });
}
