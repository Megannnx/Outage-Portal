/**
 * Wave API: the Outage Portal's side of the resident integration (docs/WAVE_INTEGRATION.md).
 *
 * Wave (ATEC's client and ticketing system) connects to the portal, collects the
 * resident notices that are ready, sends them by SMS, email and portal notice to the
 * estate's clients, and reports the result back. The portal never calls Wave.
 *
 * Which resident deliveries Wave may collect ("held for Wave"):
 *   - live delivery mode: every resident delivery the safety lock allows
 *   - capture mode:       only Test-mode deliveries to a single account (account:<code>),
 *                         so the integration can be tested before go-live
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB, Tx } from "../db/client";
import { communicationDeliveries, communications, deliveryEvents, incidents, sites } from "../db/schema";
import { clock } from "../lib/clock";
import { badRequest, notFound } from "../lib/errors";
import { healthOk } from "../lib/alerts";
import { raiseAlert, resolveAlert } from "../lib/alerts";
import { addTimeline } from "../incidents/timeline";
import { kindDef } from "../domain/catalog";
import { deliveryMode } from "../comms/adapters";
import { smsText } from "../comms/adapters/client-api";

export const LEASE_SECONDS = 300;

/** Resident deliveries go to Wave by collection (pull) unless a push URL is configured. */
export function residentTransport(): "pull" | "push" {
  return process.env.CLIENT_API_URL ? "push" : "pull";
}

/** True when this delivery waits for Wave to collect it instead of being sent by the portal. */
export function heldForWave(d: { channel: string; address: string }) {
  if (d.channel !== "client_api" || residentTransport() !== "pull") return false;
  return deliveryMode() === "live" || d.address.startsWith("account:");
}

const heldSql = () => deliveryMode() === "live"
  ? sql`d.channel = 'client_api'`
  : sql`d.channel = 'client_api' and d.address like 'account:%'`;

const OUTAGE_PURPOSES = ["initial", "cause", "technical", "periodic"];

function toHtml(text: string) {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${esc.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("")}</div>`;
}

export async function claimNotices(db: DB, limit = 25) {
  if (residentTransport() !== "pull") throw badRequest("The portal is configured to push resident notices (CLIENT_API_URL is set); collection is disabled.");
  const now = clock.now();
  const leaseCutoff = new Date(now.getTime() - LEASE_SECONDS * 1000);
  const out = await db.transaction(async (tx) => {
    const rows = await tx.execute(sql`
      select d.id from communication_deliveries d
      where ${heldSql()} and (d.status = 'pending' or (d.status = 'sending' and d.last_attempt_at < ${leaseCutoff.toISOString()}))
      order by d.updated_at limit ${Math.min(Math.max(limit, 1), 100)} for update skip locked`);
    const ids = (rows.rows as { id: string }[]).map((r) => r.id);
    if (!ids.length) return [];
    const ds = await tx.select({ d: communicationDeliveries, c: communications, inc: incidents, site: sites })
      .from(communicationDeliveries)
      .innerJoin(communications, eq(communications.id, communicationDeliveries.communicationId))
      .innerJoin(incidents, eq(incidents.id, communications.incidentId))
      .innerJoin(sites, eq(sites.id, incidents.siteId))
      .where(inArray(communicationDeliveries.id, ids));
    const notices = [];
    for (const { d, c, inc, site } of ds) {
      // Never hand Wave a stale "still down" message once the link is confirmed restored.
      if (OUTAGE_PURPOSES.includes(c.purpose) && ["awaiting_rfo", "resolved", "interruption"].includes(inc.phase)) {
        await tx.update(communicationDeliveries).set({ status: "cancelled", error: "Incident restored before Wave collected it", updatedAt: now }).where(eq(communicationDeliveries.id, d.id));
        await finalize(tx, c.id);
        continue;
      }
      await tx.update(communicationDeliveries).set({ status: "sending", lastAttemptAt: now, attempts: sql`${communicationDeliveries.attempts} + 1`, updatedAt: now }).where(eq(communicationDeliveries.id, d.id));
      await tx.update(communications).set({ status: "sending" }).where(and(eq(communications.id, c.id), eq(communications.status, "queued")));
      const isAccount = d.address.startsWith("account:");
      const ref = d.address.replace(/^(list|account):/, "");
      const subject = isAccount ? `[TEST] ${c.subject}` : c.subject;
      notices.push({
        delivery_id: d.id,
        incident_reference: inc.reference,
        estate: isAccount ? null : ref,
        account_code: isAccount ? ref : null,
        test: isAccount,
        network: site.network || null,
        site_code: site.code,
        site_name: site.name,
        kind: c.kind,
        kind_label: kindDef(c.kind).label,
        notice_status: c.purpose === "restoration" || c.purpose === "final" ? "resolved" : "open",
        channels: ["sms", "email", "portal"],
        subject,
        text: c.body,
        html: toHtml(c.body),
        sms_text: smsText(subject),
        created_at: c.createdAt.toISOString(),
        lease_expires_at: new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString(),
      });
    }
    return notices;
  });
  await healthOk(db, "delivery:wave", "Wave (resident notices)", { lastClaim: now.toISOString(), claimed: out.length });
  return { notices: out, lease_seconds: LEASE_SECONDS };
}

export const ResultSchema = z.object({
  status: z.enum(["accepted", "delivered", "failed"]),
  wave_reference: z.string().max(200).optional(),
  detail: z.string().max(1000).optional(),
  counts: z.object({ sms: z.number().int().min(0).optional(), email: z.number().int().min(0).optional(), portal: z.number().int().min(0).optional() }).partial().optional(),
});

export async function reportResult(db: DB, deliveryId: string, input: z.input<typeof ResultSchema>) {
  const r = ResultSchema.parse(input);
  if (!/^[0-9a-f-]{36}$/i.test(deliveryId)) throw notFound("Unknown delivery");
  return db.transaction(async (tx) => {
    const [d] = await tx.select().from(communicationDeliveries).where(and(eq(communicationDeliveries.id, deliveryId), eq(communicationDeliveries.channel, "client_api"))).for("update");
    if (!d) throw notFound("Unknown delivery");
    const now = clock.now();
    const counts = r.counts ? Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(", ") : "";
    const detail = [r.detail, counts].filter(Boolean).join(" · ");
    await tx.insert(deliveryEvents).values({ deliveryId: d.id, status: r.status, at: now, detail, raw: r as any });
    // Final outcomes are not overwritten by a late "accepted".
    if (r.status === "accepted" && ["delivered", "failed"].includes(d.status)) return { ok: true, status: d.status };
    if (d.status === "cancelled") return { ok: true, status: d.status };
    await tx.update(communicationDeliveries).set({
      status: r.status, providerMessageId: r.wave_reference ?? d.providerMessageId, error: r.status === "failed" ? (detail || "Wave reported failure") : null, updatedAt: now,
    }).where(eq(communicationDeliveries.id, d.id));
    await finalize(tx, d.communicationId);
    return { ok: true, status: r.status };
  });
}

/** Settle a communication once none of its deliveries is still waiting. */
async function finalize(tx: Tx, communicationId: string) {
  const [c] = await tx.select().from(communications).where(eq(communications.id, communicationId)).for("update");
  if (!c) return;
  const ds = await tx.select().from(communicationDeliveries).where(eq(communicationDeliveries.communicationId, c.id));
  if (ds.some((d) => ["pending", "sending", "deferred"].includes(d.status))) return;
  const ok = ds.filter((d) => ["accepted", "delivered"].includes(d.status)).length;
  const failed = ds.filter((d) => ["failed", "bounced"].includes(d.status)).length;
  const status = ok + failed === 0 ? "cancelled" : failed === 0 ? "sent" : ok === 0 ? "failed" : "partially_failed";
  if (status === c.status) return;
  const now = clock.now();
  await tx.update(communications).set({ status, sentAt: c.sentAt ?? (ok ? now : null), ...(status === "cancelled" ? { cancelledReason: "Link restored before Wave collected it" } : {}) }).where(eq(communications.id, c.id));
  const label = `"${kindDef(c.kind).label}" to residents via Wave`;
  await addTimeline(tx, c.incidentId, "delivery", status === "sent" ? `${label}: delivered` : status === "cancelled" ? `${label}: cancelled — link restored first` : `${label}: ${ok} ok, ${failed} failed`, null, { communicationId: c.id, status });
  if (failed) await raiseAlert(tx, `delivery_failed:${c.id}`, ok ? "warning" : "critical", `${label} failed`, c.incidentId);
  else await resolveAlert(tx, `delivery_failed:${c.id}`);
  if (ok && c.purpose === "initial")
    await tx.update(incidents).set({ firstCommAt: sql`coalesce(${incidents.firstCommAt}, ${now.toISOString()}::timestamptz)` }).where(eq(incidents.id, c.incidentId));
}

/** Sites Wave needs to map to its estates. */
export async function listSitesForWave(db: DB) {
  const ss = await db.select().from(sites).where(eq(sites.active, true)).orderBy(sites.name);
  return ss.filter((s) => !s.code.startsWith("DEMO-")).map((s) => ({
    site_code: s.code, site_name: s.name, estate: (s.residentListRef || s.estate || s.name).trim(), network: s.network || null, region: s.region || null,
  }));
}

/** Current outages with the latest message residents were sent, for Wave's portal banner. */
export async function currentOutages(db: DB) {
  const since = new Date(clock.now().getTime() - 24 * 3600_000);
  const rows = await db.execute(sql`
    select distinct on (i.id) i.reference, i.phase, i.outage_started_at, i.restored_at, s.code, s.name, s.network,
      coalesce(nullif(s.resident_list_ref,''), nullif(s.estate,''), s.name) as estate, c.kind, c.subject, c.body, c.purpose, c.created_at
    from incidents i join sites s on s.id = i.site_id
    join communications c on c.incident_id = i.id and c.audience = 'resident' and c.status in ('sending','sent','partially_failed')
    where (i.phase in ('active','restoring') or (i.restored_at is not null and i.restored_at > ${since.toISOString()}))
    order by i.id, c.created_at desc`);
  return (rows.rows as any[]).map((r) => ({
    incident_reference: r.reference, estate: r.estate, site_code: r.code, site_name: r.name, network: r.network || null,
    notice_status: ["active", "restoring"].includes(r.phase) ? "open" : "resolved",
    outage_started_at: r.outage_started_at, restored_at: r.restored_at,
    latest: { kind: r.kind, subject: r.subject, text: r.body, sent_at: r.created_at },
  }));
}
