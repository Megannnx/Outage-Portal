/**
 * Read models for the UI. Role-aware: Technical sees its own queue by default,
 * the Service Desk sees everything that needs a customer-facing decision.
 */
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { DB } from "./db/client";
import {
  alerts, backhaulProviders, causeOptions, communicationDeliveries, communicationSchedules, communications, correlationSuggestions,
  escalations, faultTypes, incidentGroups, incidents, integrationHealth, rfoRecords, sites, technicalUpdates, technicianDispatches,
  timelineEntries, users,
} from "./db/schema";
import { clock, addMinutes } from "./lib/clock";
import type { Role } from "./auth/permissions";
import type { TechState } from "./domain/catalog";
import { getSettings } from "./domain/settings";
import { deliveryMode } from "./comms/adapters";
import { notFound } from "./lib/errors";

export interface ActionItem { label: string; urgency: "urgent" | "high" | "normal"; who: "service_desk" | "technical" | "admin" }

export async function listIncidents(db: DB, role: Role, opts: { scope?: "open" | "mine" | "rfo" | "recent"; q?: string } = {}) {
  const now = clock.now();
  const scope = opts.scope ?? (role === "technical" ? "mine" : "open");
  const phases = scope === "rfo" ? ["awaiting_rfo"] : scope === "recent" ? ["resolved", "interruption", "awaiting_rfo", "active", "validating", "restoring"] : ["validating", "active", "restoring", "awaiting_rfo"];
  const conds = [inArray(incidents.phase, phases as any)];
  if (scope === "recent") conds.push(gte(incidents.outageStartedAt, addMinutes(now, -7 * 24 * 60)));
  const rows = await db.select({ i: incidents, site: sites, provider: backhaulProviders.name, cause: causeOptions, sched: communicationSchedules })
    .from(incidents).innerJoin(sites, eq(sites.id, incidents.siteId))
    .leftJoin(backhaulProviders, eq(backhaulProviders.id, sites.backhaulProviderId))
    .leftJoin(causeOptions, eq(causeOptions.key, incidents.causeKey))
    .leftJoin(communicationSchedules, eq(communicationSchedules.incidentId, incidents.id))
    .where(and(...conds)).orderBy(desc(incidents.outageStartedAt)).limit(500);
  const ids = rows.map((r) => r.i.id);
  const comms = ids.length ? await db.select({ id: communications.id, incidentId: communications.incidentId, kind: communications.kind, status: communications.status, sentAt: communications.sentAt, createdAt: communications.createdAt, audience: communications.audience })
    .from(communications).where(and(inArray(communications.incidentId, ids), eq(communications.audience, "resident"))) : [];
  const dispatches = ids.length ? await db.select().from(technicianDispatches).where(inArray(technicianDispatches.incidentId, ids)) : [];
  const escs = ids.length ? await db.select().from(escalations).where(and(inArray(escalations.incidentId, ids), isNull(escalations.resolvedAt))) : [];
  const failing = ids.length ? await db.select({ incidentId: communications.incidentId, status: communications.status }).from(communications)
    .where(and(inArray(communications.incidentId, ids), inArray(communications.status, ["failed", "partially_failed", "sending"]))) : [];

  let list = rows.map(({ i, site, provider, cause, sched }) => {
    const ts = (i.techState ?? {}) as TechState;
    const myComms = comms.filter((c) => c.incidentId === i.id && c.status !== "cancelled").sort((a, b) => (b.sentAt ?? b.createdAt).getTime() - (a.sentAt ?? a.createdAt).getTime());
    const d = dispatches.filter((x) => x.incidentId === i.id && x.status !== "cancelled").sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())[0];
    const actions: ActionItem[] = [];
    if (i.phase === "active" && !i.causeKey) actions.push({ label: "Confirm cause", urgency: "urgent", who: "service_desk" });
    if (cause?.requiresDispatch && i.phase === "active" && !d) actions.push({ label: "LOG URGENT TECHNICIAN", urgency: "urgent", who: "service_desk" });
    if (d && ["requested", "sent"].includes(d.status)) actions.push({ label: "Dispatch not acknowledged", urgency: "high", who: "technical" });
    if (i.phase === "active" && i.technicalAssigned) {
      const since = i.lastTechnicalUpdateAt ?? i.causeConfirmedAt ?? i.validatedAt ?? i.createdAt;
      const overdue = now.getTime() - since.getTime() > 60 * 60_000;
      actions.push({ label: i.lastTechnicalUpdateAt ? (overdue ? "Technical update overdue" : "Provide updates as received") : "Enter provider update", urgency: overdue ? "high" : "normal", who: "technical" });
    }
    if (ts.eta && !ts.etaUnavailable && new Date(ts.eta) < now && i.phase === "active") actions.push({ label: "ETA passed — get a new ETA", urgency: "high", who: "technical" });
    if (i.phase === "awaiting_rfo" && i.rfoStatus === "awaiting") actions.push({ label: "Enter RFO", urgency: "normal", who: "technical" });
    const commHealth = failing.some((f) => f.incidentId === i.id && f.status === "failed") ? "failed"
      : failing.some((f) => f.incidentId === i.id && f.status === "partially_failed") ? "partial"
      : failing.some((f) => f.incidentId === i.id && f.status === "sending") ? "retrying"
      : sched?.active && sched.nextDueAt && sched.nextDueAt < addMinutes(now, -5) ? "overdue" : "ok";
    const priority =
      (actions.some((a) => a.urgency === "urgent") ? 1000 : 0) + (actions.some((a) => a.urgency === "high") ? 500 : 0) +
      (commHealth !== "ok" ? 400 : 0) + escs.filter((e) => e.incidentId === i.id).length * 100 +
      ({ validating: 50, active: 300, restoring: 200, awaiting_rfo: 10, resolved: 0, interruption: 0 } as const)[i.phase] +
      Math.min(200, (now.getTime() - i.outageStartedAt.getTime()) / 60_000 / 6);
    return {
      id: i.id, reference: i.reference, version: i.version, phase: i.phase, status: i.status,
      siteId: site.id, siteName: site.name, siteCode: site.code, estate: site.estate, provider: provider ?? null, circuitRef: site.circuitRef,
      outageStartedAt: i.outageStartedAt, restoredAt: i.restoredAt, downtimeSeconds: i.downtimeSeconds,
      cause: cause?.label ?? null, causeKey: i.causeKey, technicalAssigned: i.technicalAssigned, assignedTeam: i.assignedTeam ?? site.technicalTeam,
      lastComm: myComms[0] ? { kind: myComms[0].kind, at: myComms[0].sentAt ?? myComms[0].createdAt, status: myComms[0].status } : null,
      nextCommAt: sched?.active ? sched.nextDueAt : null,
      dispatch: d ? { reference: d.reference, status: d.status, acknowledgedBy: d.acknowledgedBy } : null,
      eta: ts.eta && !ts.etaUnavailable ? ts.eta : null, techStatus: ts.repairStatus ?? ts.technicians ?? null,
      lastTechnicalUpdateAt: i.lastTechnicalUpdateAt, rfoStatus: i.rfoStatus, groupId: i.groupId, flapCount: i.flapCount,
      actions, commHealth, openEscalations: escs.filter((e) => e.incidentId === i.id).length, priority,
      linkUp: ["restoring", "awaiting_rfo", "resolved", "interruption"].includes(i.phase),
    };
  });
  if (scope === "mine") list = list.filter((x) => x.technicalAssigned || x.phase === "awaiting_rfo" || x.dispatch || x.groupId);
  if (opts.q) {
    const q = opts.q.toLowerCase();
    list = list.filter((x) => [x.reference, x.siteName, x.siteCode, x.estate, x.provider ?? "", x.circuitRef].some((v) => v.toLowerCase().includes(q)));
  }
  return list.sort((a, b) => b.priority - a.priority);
}
export type IncidentListItem = Awaited<ReturnType<typeof listIncidents>>[number];

export async function incidentDetail(db: DB, id: string) {
  const [row] = await db.select({ i: incidents, site: sites, provider: backhaulProviders, sched: communicationSchedules })
    .from(incidents).innerJoin(sites, eq(sites.id, incidents.siteId))
    .leftJoin(backhaulProviders, eq(backhaulProviders.id, sites.backhaulProviderId))
    .leftJoin(communicationSchedules, eq(communicationSchedules.incidentId, incidents.id))
    .where(eq(incidents.id, id));
  if (!row) throw notFound("Incident not found");
  const [timeline, comms, dispatches, updates, rfo, escs, causeOpts, faults, providers] = await Promise.all([
    db.select().from(timelineEntries).where(eq(timelineEntries.incidentId, id)).orderBy(desc(timelineEntries.at), desc(timelineEntries.id)),
    db.select().from(communications).where(eq(communications.incidentId, id)).orderBy(desc(communications.createdAt)),
    db.select().from(technicianDispatches).where(eq(technicianDispatches.incidentId, id)).orderBy(desc(technicianDispatches.requestedAt)),
    db.select({ u: technicalUpdates, author: users.name }).from(technicalUpdates).innerJoin(users, eq(users.id, technicalUpdates.authorId)).where(eq(technicalUpdates.incidentId, id)).orderBy(desc(technicalUpdates.createdAt)),
    db.select().from(rfoRecords).where(eq(rfoRecords.incidentId, id)).orderBy(desc(rfoRecords.enteredAt)),
    db.select().from(escalations).where(eq(escalations.incidentId, id)).orderBy(desc(escalations.raisedAt)),
    db.select().from(causeOptions).where(eq(causeOptions.active, true)).orderBy(causeOptions.sort),
    db.select().from(faultTypes).where(eq(faultTypes.active, true)),
    db.select().from(backhaulProviders).where(eq(backhaulProviders.active, true)),
  ]);
  const commIds = comms.map((c) => c.id);
  const deliveries = commIds.length ? await db.select().from(communicationDeliveries).where(inArray(communicationDeliveries.communicationId, commIds)) : [];
  let group = null as null | { reference: string; label: string; members: { id: string; reference: string; siteName: string; phase: string }[] };
  if (row.i.groupId) {
    const [g] = await db.select().from(incidentGroups).where(eq(incidentGroups.id, row.i.groupId));
    const members = await db.select({ id: incidents.id, reference: incidents.reference, siteName: sites.name, phase: incidents.phase }).from(incidents).innerJoin(sites, eq(sites.id, incidents.siteId)).where(eq(incidents.groupId, row.i.groupId));
    group = { reference: g.reference, label: g.label, members };
  }
  const suggestions = await db.select().from(correlationSuggestions).where(and(eq(correlationSuggestions.status, "open"), sql`${id}::uuid = any(${correlationSuggestions.incidentIds})`));
  const suggestionDetails = await Promise.all(suggestions.map(async (sg) => ({
    id: sg.id, reason: sg.reason,
    members: await db.select({ id: incidents.id, reference: incidents.reference, siteName: sites.name }).from(incidents).innerJoin(sites, eq(sites.id, incidents.siteId)).where(inArray(incidents.id, sg.incidentIds)),
  })));
  let related = null as null | { id: string; reference: string };
  if (row.i.relatedIncidentId) {
    const [r] = await db.select({ id: incidents.id, reference: incidents.reference }).from(incidents).where(eq(incidents.id, row.i.relatedIncidentId));
    related = r ?? null;
  }
  const settings = await getSettings(db);
  return {
    incident: row.i, site: row.site, provider: row.provider, schedule: row.sched, timeline,
    communications: comms.map((c) => ({
      ...c,
      deliveries: deliveries.filter((d) => d.communicationId === c.id).map((d) => ({ id: d.id, channel: d.channel, address: c.audience === "isp" ? d.address : d.address, status: d.status, error: d.error, attempts: d.attempts })),
    })),
    dispatches, technicalUpdates: updates.map((u) => ({ ...u.u, author: u.author })), rfo, escalations: escs,
    causeOptions: causeOpts, faultTypes: faults, providers: providers.map((p) => ({ id: p.id, name: p.name })),
    group, suggestions: suggestionDetails, related,
    settings: { updateIntervalMinutes: settings.updateIntervalMinutes, validationMinutes: settings.validationMinutes, restorationStabilityMinutes: settings.restorationStabilityMinutes },
  };
}
export type IncidentDetail = Awaited<ReturnType<typeof incidentDetail>>;

export async function systemMeta(db: DB) {
  const now = clock.now();
  const health = await db.select().from(integrationHealth);
  const openAlerts = await db.select().from(alerts).where(isNull(alerts.resolvedAt)).orderBy(desc(alerts.raisedAt)).limit(50);
  const worker = health.find((h) => h.key === "worker");
  return {
    deliveryMode: deliveryMode(),
    workerOk: !!worker?.lastSuccessAt && now.getTime() - worker.lastSuccessAt.getTime() < 3 * 60_000,
    workerLastSeen: worker?.lastSuccessAt ?? null,
    health, alerts: openAlerts,
  };
}

export async function handover(db: DB) {
  const list = await listIncidents(db, "admin", { scope: "open" });
  const dispatches = await db.select({ d: technicianDispatches, ref: incidents.reference, site: sites.name }).from(technicianDispatches)
    .innerJoin(incidents, eq(incidents.id, technicianDispatches.incidentId)).innerJoin(sites, eq(sites.id, incidents.siteId))
    .where(inArray(technicianDispatches.status, ["requested", "sent", "acknowledged", "on_site"]));
  const meta = await systemMeta(db);
  return {
    generatedAt: clock.now(),
    active: list.filter((x) => ["validating", "active", "restoring"].includes(x.phase)),
    awaitingRfo: list.filter((x) => x.phase === "awaiting_rfo"),
    needsAction: list.filter((x) => x.actions.some((a) => a.urgency !== "normal")),
    commProblems: list.filter((x) => x.commHealth !== "ok"),
    dispatches: dispatches.map((x) => ({ ...x.d, incidentReference: x.ref, siteName: x.site })),
    alerts: meta.alerts.filter((a) => a.severity !== "info"),
  };
}
void or;
