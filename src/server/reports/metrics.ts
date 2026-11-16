/**
 * Management reporting. Every number is computed from recorded rows (incidents,
 * communications, deliveries, dispatches, technical updates, RFOs, escalations)
 * and every metric carries a plain-English definition. Where data is too thin to
 * support a conclusion the report says so rather than inventing one.
 */
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import {
  backhaulProviders, causeOptions, communicationDeliveries, communications, escalations, incidents, rfoRecords, sites,
  technicalUpdates, technicianDispatches,
} from "../db/schema";
import { getSettings } from "../domain/settings";
import { clock } from "../lib/clock";
import { DISPLAY_TZ, inTz } from "../lib/time";
import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";

export interface ReportFilters { from: Date; to: Date; estate?: string; siteId?: string; providerId?: string; causeKey?: string; team?: string; status?: string }

export const DEFINITIONS: Record<string, string> = {
  qualifyingOutages: "Incidents where a site stayed down for at least the validation period (default 3 min) and customers were notified. Short interruptions are counted separately.",
  interruptions: "Site went down and recovered inside the validation window. No customer communication is sent; kept for network-quality analysis.",
  totalDowntime: "Sum of (restored time − outage start time) for qualifying outages restored in the period. Ongoing outages are counted up to now in 'active' only.",
  mtrs: "Mean Time to Restore Service: average of (restored time − outage start time) for restored qualifying outages.",
  mttr: "Mean Time to Repair: average of (restored time − technician on-site time) where a dispatch recorded an on-site time. Not measurable otherwise.",
  restoreToRfo: "Average time from restoration to the verified RFO being received from the provider.",
  rfoToFinal: "Average time from the RFO being entered to the final customer message being accepted by the delivery provider.",
  detectionToFirstComm: "Average time from outage start (monitoring timestamp) to the first customer message being accepted for delivery. Includes the validation period.",
  updateInterval: "Gap between consecutive customer outage messages (residents) while an incident was active, including the gap to the restoration notice.",
  intervalCompliance: "Share of update gaps that were within the configured interval (default 120 min) plus a 5-minute grace.",
  deliverySuccess: "Deliveries accepted or delivered ÷ all non-suppressed delivery attempts. 'Accepted' means the provider took the message; bounces reported later are counted as failures.",
  causeConfirmation: "Average time from outage validation to the Service Desk confirming a cause.",
  dispatchCreation: "Average time from a cause requiring dispatch being confirmed to the dispatch being logged.",
  dispatchAck: "Average time from dispatch logged to acknowledgement by a technician.",
  firstTechUpdate: "Average time from outage validation to the first technical update, for incidents assigned to Technical.",
};

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const secs = (a: Date | null | undefined, b: Date | null | undefined) => (a && b ? (b.getTime() - a.getTime()) / 1000 : null);
const nn = (xs: (number | null)[]) => xs.filter((x): x is number => x != null && x >= 0);

export async function buildReport(db: DB, f: ReportFilters) {
  const settings = await getSettings(db);
  const now = clock.now();
  const conds = [gte(incidents.outageStartedAt, f.from), lt(incidents.outageStartedAt, f.to)];
  if (f.siteId) conds.push(eq(incidents.siteId, f.siteId));
  if (f.causeKey) conds.push(eq(incidents.causeKey, f.causeKey));
  if (f.status) conds.push(eq(incidents.status, f.status as any));
  let rows = await db.select({ i: incidents, site: sites, provider: backhaulProviders.name, cause: causeOptions.label })
    .from(incidents).innerJoin(sites, eq(sites.id, incidents.siteId))
    .leftJoin(backhaulProviders, eq(backhaulProviders.id, sites.backhaulProviderId))
    .leftJoin(causeOptions, eq(causeOptions.key, incidents.causeKey))
    .where(and(...conds));
  if (f.estate) rows = rows.filter((r) => r.site.estate === f.estate);
  if (f.providerId) rows = rows.filter((r) => r.site.backhaulProviderId === f.providerId);
  if (f.team) rows = rows.filter((r) => (r.i.assignedTeam ?? r.site.technicalTeam) === f.team);

  const qualifying = rows.filter((r) => r.i.phase !== "interruption");
  const interruptions = rows.filter((r) => r.i.phase === "interruption");
  const ids = qualifying.map((r) => r.i.id);
  const restored = qualifying.filter((r) => r.i.restoredAt);
  const downtimes = restored.map((r) => secs(r.i.outageStartedAt, r.i.restoredAt)!).filter((x) => x >= 0);

  const comms = ids.length ? await db.select().from(communications).where(inArray(communications.incidentId, ids)) : [];
  const deliveries = comms.length ? await db.select({ d: communicationDeliveries, incidentId: communications.incidentId }).from(communicationDeliveries)
    .innerJoin(communications, eq(communications.id, communicationDeliveries.communicationId)).where(inArray(communications.incidentId, ids)) : [];
  const dispatches = ids.length ? await db.select().from(technicianDispatches).where(inArray(technicianDispatches.incidentId, ids)) : [];
  const techUpdates = ids.length ? await db.select({ incidentId: technicalUpdates.incidentId, createdAt: technicalUpdates.createdAt }).from(technicalUpdates).where(inArray(technicalUpdates.incidentId, ids)) : [];
  const rfos = ids.length ? await db.select().from(rfoRecords).where(inArray(rfoRecords.incidentId, ids)) : [];
  const escs = ids.length ? await db.select().from(escalations).where(inArray(escalations.incidentId, ids)) : [];

  // ── Group-bys ──
  const groupCount = (key: (r: (typeof qualifying)[number]) => string) => {
    const m = new Map<string, { count: number; downtime: number }>();
    for (const r of qualifying) {
      const k = key(r) || "—";
      const e = m.get(k) ?? { count: 0, downtime: 0 };
      e.count++; e.downtime += r.i.restoredAt ? secs(r.i.outageStartedAt, r.i.restoredAt)! : 0;
      m.set(k, e);
    }
    return [...m.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.count - a.count || b.downtime - a.downtime);
  };
  const bySite = groupCount((r) => r.site.name);
  const repeatSites = bySite.filter((s) => s.count >= 2);
  const interruptionsBySite = new Map<string, number>();
  for (const r of interruptions) interruptionsBySite.set(r.site.name, (interruptionsBySite.get(r.site.name) ?? 0) + 1);

  // ── Restoration ──
  const mttr = nn(restored.map((r) => {
    const onSite = dispatches.filter((d) => d.incidentId === r.i.id && d.onSiteAt).map((d) => d.onSiteAt!.getTime());
    return onSite.length ? (r.i.restoredAt!.getTime() - Math.min(...onSite)) / 1000 : null;
  }));
  const restoreToRfo = nn(rfos.map((rf) => { const r = qualifying.find((q) => q.i.id === rf.incidentId); return secs(r?.i.restoredAt, rf.receivedAt); }));
  const rfoToFinal = nn(rfos.map((rf) => { const c = comms.find((x) => x.id === rf.communicationId); return secs(rf.enteredAt, c?.sentAt); }));

  // ── Communications ──
  const outagePurposes = ["initial", "cause", "technical", "periodic"];
  const residentSent = comms.filter((c) => c.audience === "resident" && c.sentAt);
  const intervals: number[] = [];
  for (const r of qualifying) {
    if (!r.i.validatedAt) continue;
    const times = residentSent.filter((c) => c.incidentId === r.i.id && [...outagePurposes, "restoration", "final"].includes(c.purpose))
      .map((c) => c.sentAt!.getTime()).sort((a, b) => a - b);
    const stopAt = r.i.restorationConfirmedAt?.getTime() ?? now.getTime();
    for (let k = 1; k < times.length; k++) if (times[k - 1] <= stopAt) intervals.push((times[k] - times[k - 1]) / 60_000);
    // Still active: the open gap since the last message counts if it already exceeds the target.
    if (!r.i.restorationConfirmedAt && times.length) {
      const open = (now.getTime() - times[times.length - 1]) / 60_000;
      if (open > settings.updateIntervalMinutes + 5) intervals.push(open);
    }
  }
  const target = settings.updateIntervalMinutes + 5;
  const attempted = deliveries.filter((d) => !["suppressed", "cancelled", "pending"].includes(d.d.status));
  const okDeliveries = attempted.filter((d) => ["accepted", "delivered"].includes(d.d.status));
  const failedDeliveries = attempted.filter((d) => ["failed", "bounced"].includes(d.d.status));
  const failuresBySite = new Map<string, number>();
  for (const fd of failedDeliveries) {
    const r = qualifying.find((q) => q.i.id === fd.incidentId);
    if (r) failuresBySite.set(r.site.name, (failuresBySite.get(r.site.name) ?? 0) + 1);
  }
  const failuresByIsp = new Map<string, number>();
  for (const fd of failedDeliveries) if (fd.d.ispId) failuresByIsp.set(fd.d.address, (failuresByIsp.get(fd.d.address) ?? 0) + 1);

  // ── Staff & workflow ──
  const serverRoomKeys = (await db.select().from(causeOptions).where(eq(causeOptions.requiresDispatch, true))).map((c) => c.key);
  const dispatchCreation = nn(qualifying.filter((r) => r.i.causeKey && serverRoomKeys.includes(r.i.causeKey)).map((r) => {
    const d = dispatches.filter((x) => x.incidentId === r.i.id).sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())[0];
    return secs(r.i.causeConfirmedAt, d?.requestedAt);
  }));
  const firstTech = nn(qualifying.filter((r) => r.i.technicalAssigned).map((r) => {
    const t = techUpdates.filter((u) => u.incidentId === r.i.id).map((u) => u.createdAt.getTime());
    return t.length ? (Math.min(...t) - (r.i.validatedAt ?? r.i.createdAt).getTime()) / 1000 : null;
  }));

  const summary = {
    qualifyingOutages: qualifying.length,
    affectedSites: new Set(qualifying.map((r) => r.site.id)).size,
    interruptions: interruptions.length,
    activeUnresolved: qualifying.filter((r) => ["validating", "active", "restoring", "awaiting_rfo"].includes(r.i.phase)).length,
    totalDowntimeSec: downtimes.reduce((a, b) => a + b, 0),
    avgDowntimeSec: avg(downtimes), medianDowntimeSec: median(downtimes),
    longestSec: downtimes.length ? Math.max(...downtimes) : null, shortestSec: downtimes.length ? Math.min(...downtimes) : null,
    mtrsSec: avg(downtimes), mttrSec: avg(mttr), mttrSample: mttr.length,
    restoreToRfoSec: avg(restoreToRfo), rfoToFinalSec: avg(rfoToFinal),
    awaitingRfo: qualifying.filter((r) => r.i.phase === "awaiting_rfo" && r.i.rfoStatus === "awaiting").length,
    retrospective: qualifying.filter((r) => r.i.retrospective).length,
    initialComms: comms.filter((c) => c.purpose === "initial" && c.audience === "resident").length,
    detectionToFirstCommSec: avg(nn(qualifying.map((r) => secs(r.i.outageStartedAt, r.i.firstCommAt)))),
    scheduledUpdates: comms.filter((c) => c.purpose === "periodic" && c.audience === "resident" && c.status !== "cancelled").length,
    immediateTechnicalUpdates: comms.filter((c) => c.purpose === "technical" && c.audience === "resident" && c.status !== "cancelled").length,
    noUpdateComms: comms.filter((c) => c.purpose === "periodic" && c.audience === "resident" && c.status !== "cancelled").length,
    avgIntervalMin: avg(intervals), maxIntervalMin: intervals.length ? Math.max(...intervals) : null,
    intervalCompliancePct: intervals.length ? (100 * intervals.filter((x) => x <= target).length) / intervals.length : null,
    missedDeadlines: intervals.filter((x) => x > target).length,
    failedSends: failedDeliveries.length,
    deliverySuccessPct: attempted.length ? (100 * okDeliveries.length) / attempted.length : null,
    noConfirmedCause: qualifying.filter((r) => !r.i.causeKey).length,
    causeConfirmationSec: avg(nn(qualifying.map((r) => secs(r.i.validatedAt, r.i.causeConfirmedAt)))),
    dispatchIncidents: new Set(dispatches.map((d) => d.incidentId)).size,
    dispatchCreationSec: avg(dispatchCreation),
    dispatchAckSec: avg(nn(dispatches.map((d) => secs(d.requestedAt, d.acknowledgedAt)))),
    techUpdatesPerIncident: qualifying.filter((r) => r.i.technicalAssigned).length ? techUpdates.length / qualifying.filter((r) => r.i.technicalAssigned).length : null,
    firstTechUpdateSec: avg(firstTech),
    overdueTechFollowUps: escs.filter((e) => e.trigger === "technical_update_overdue").length,
    escalatedIncidents: new Set(escs.map((e) => e.incidentId)).size,
  };

  const incidentRows = rows.map((r) => ({
    reference: r.i.reference, site: r.site.name, estate: r.site.estate, provider: r.provider ?? "", cause: r.cause ?? (r.i.phase === "interruption" ? "Short interruption" : "Not confirmed"),
    status: r.i.status, start: r.i.outageStartedAt, restored: r.i.restoredAt, downtimeSec: r.i.restoredAt ? secs(r.i.outageStartedAt, r.i.restoredAt) : null,
    rfo: r.i.rfoStatus, comms: comms.filter((c) => c.incidentId === r.i.id && c.audience === "resident" && c.status !== "cancelled").length,
    flaps: r.i.flapCount, retrospective: r.i.retrospective,
  })).sort((a, b) => a.start.getTime() - b.start.getTime());

  return {
    period: { from: f.from, to: f.to }, generatedAt: now, filters: f, settings: { updateIntervalMinutes: settings.updateIntervalMinutes, validationMinutes: settings.validationMinutes },
    summary, definitions: DEFINITIONS,
    bySite, byEstate: groupCount((r) => r.site.estate), byProvider: groupCount((r) => r.provider ?? ""), byCause: groupCount((r) => r.cause ?? "Not confirmed"),
    repeatSites, interruptionsBySite: [...interruptionsBySite.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    deliveryFailuresBySite: [...failuresBySite.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    deliveryFailuresByIspAddress: [...failuresByIsp.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    downtimeDistribution: bucket(downtimes),
    rfoBacklog: qualifying.filter((r) => r.i.phase === "awaiting_rfo" && r.i.rfoStatus === "awaiting").map((r) => ({ reference: r.i.reference, site: r.site.name, ageSec: secs(r.i.restorationConfirmedAt, now) }))
      .sort((a, b) => (b.ageSec ?? 0) - (a.ageSec ?? 0)),
    incidents: incidentRows,
  };
}

function bucket(xs: number[]) {
  const b = [{ label: "< 30 min", max: 1800 }, { label: "30–60 min", max: 3600 }, { label: "1–2 h", max: 7200 }, { label: "2–4 h", max: 14400 }, { label: "4–8 h", max: 28800 }, { label: "8–24 h", max: 86400 }, { label: "> 24 h", max: Infinity }];
  return b.map((x, i) => ({ label: x.label, count: xs.filter((v) => v < x.max && v >= (i ? b[i - 1].max : 0)).length }));
}

export type Report = Awaited<ReturnType<typeof buildReport>>;

/** Six-month trend + previous period comparison. */
export async function trend(db: DB, endExclusive: Date, months = 6) {
  const out: { month: string; outages: number; interruptions: number; downtimeHours: number }[] = [];
  for (let k = months - 1; k >= 0; k--) {
    // Calendar months in the display time zone (SAST), ending at endExclusive.
    const e = inTz(endExclusive);
    const from = new Date(new TZDate(e.getFullYear(), e.getMonth() - k - 1, 1, 0, 0, 0, DISPLAY_TZ).getTime());
    const to = new Date(new TZDate(e.getFullYear(), e.getMonth() - k, 1, 0, 0, 0, DISPLAY_TZ).getTime());
    const r = await db.execute(sql`
      select count(*) filter (where phase <> 'interruption')::int as outages,
             count(*) filter (where phase = 'interruption')::int as interruptions,
             coalesce(sum(extract(epoch from (restored_at - outage_started_at))) filter (where phase <> 'interruption' and restored_at is not null), 0)::float as downtime
      from incidents where outage_started_at >= ${from.toISOString()} and outage_started_at < ${to.toISOString()}`);
    const row = r.rows[0] as { outages: number; interruptions: number; downtime: number };
    out.push({ month: format(inTz(from), "yyyy-MM"), outages: row.outages, interruptions: row.interruptions, downtimeHours: Math.round((row.downtime / 3600) * 10) / 10 });
  }
  return out;
}

/** Findings and recommendations derived strictly from the numbers. */
export function findings(r: Report, prev: Report | null) {
  const out: { level: "info" | "attention" | "action"; text: string }[] = [];
  const s = r.summary;
  if (s.qualifyingOutages === 0) {
    out.push({ level: "info", text: "No qualifying outages were recorded in this period, so no restoration or communication trends can be drawn." });
    return out;
  }
  if (s.qualifyingOutages < 5) out.push({ level: "info", text: `Only ${s.qualifyingOutages} qualifying outage(s) — averages below are indicative, not statistically meaningful.` });
  if (prev && prev.summary.qualifyingOutages >= 3) {
    const d = s.qualifyingOutages - prev.summary.qualifyingOutages;
    out.push({ level: d > 0 ? "attention" : "info", text: `Outages ${d >= 0 ? "increased" : "decreased"} from ${prev.summary.qualifyingOutages} to ${s.qualifyingOutages} compared with the previous period.` });
  }
  for (const site of r.repeatSites.slice(0, 5)) out.push({ level: "action", text: `${site.name} had ${site.count} outages — review for a recurring root cause.` });
  for (const site of r.interruptionsBySite.filter((x) => x.count >= 5).slice(0, 5)) out.push({ level: "attention", text: `${site.name} had ${site.count} short interruptions (under the validation period) — possible unstable link or power.` });
  if (s.intervalCompliancePct != null && s.intervalCompliancePct < 95) out.push({ level: "action", text: `Only ${s.intervalCompliancePct.toFixed(1)}% of customer update gaps met the ${r.settings.updateIntervalMinutes}-minute target (${s.missedDeadlines} missed). Check worker and delivery health.` });
  if (s.deliverySuccessPct != null && s.deliverySuccessPct < 98) out.push({ level: "action", text: `Delivery success was ${s.deliverySuccessPct.toFixed(1)}% (${s.failedSends} failed). Review failing recipients in Admin › Recipients.` });
  for (const isp of r.deliveryFailuresByIspAddress.filter((x) => x.count >= 2).slice(0, 5)) out.push({ level: "action", text: `${isp.name} failed to receive ${isp.count} outage notice(s) — confirm the ISP's contact address.` });
  if (s.awaitingRfo > 0) out.push({ level: "attention", text: `${s.awaitingRfo} restored incident(s) are still awaiting an RFO.` });
  if (s.noConfirmedCause > 0 && s.noConfirmedCause / s.qualifyingOutages > 0.2) out.push({ level: "attention", text: `${s.noConfirmedCause} outage(s) never had a cause confirmed.` });
  if (s.retrospective > 0) out.push({ level: "attention", text: `${s.retrospective} outage(s) were only processed after they ended (monitoring delay or worker downtime).` });
  const topProvider = r.byProvider[0];
  if (topProvider && r.byProvider.length > 1 && topProvider.count >= 3 && topProvider.count / s.qualifyingOutages >= 0.5)
    out.push({ level: "attention", text: `${topProvider.name} accounted for ${topProvider.count} of ${s.qualifyingOutages} outages — consider an SLA review.` });
  return out;
}
void escalations;
