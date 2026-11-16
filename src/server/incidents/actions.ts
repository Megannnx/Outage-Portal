/**
 * The four human touch-points, implemented as server-side commands:
 *   1. Service Desk confirms the cause
 *   2. Technical enters verified updates / RFO
 *   3. Service Desk creates or confirms an urgent technician dispatch
 *   4. (Admin) exceptional workflows — RFO waiver, correlation grouping
 *
 * Every command: authorisation is checked by the caller (API layer), then
 * optimistic-concurrency check on incident.version, then a single transaction
 * that records the decision, the audit entry, the timeline and any outbound
 * communications together.
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB, Tx } from "../db/client";
import {
  backhaulProviders, causeConfirmations, causeOptions, correlationSuggestions, faultTypes, incidentGroups, incidents,
  rfoRecords, sites, technicalUpdates, technicianDispatches,
} from "../db/schema";
import { clock } from "../lib/clock";
import { conflict, badRequest, notFound } from "../lib/errors";
import { audit, type Actor } from "../audit/audit";
import { addTimeline } from "./timeline";
import { refreshStatus, recordTransition } from "./transitions";
import { createCommunications, scheduleNextUpdate, cancelUnsentCommunications, selectAndRender, buildVars, type CreatedComm } from "../comms/engine";
import { getSettings } from "../domain/settings";
import { extract } from "../extraction";
import type { Extraction } from "../extraction/rules";
import type { TechState } from "../domain/catalog";
import { queueInternal, internalAddresses } from "../comms/internal";
import { fmtDateTime, fmtDuration } from "../lib/time";
import { randomToken, sha256 } from "../lib/crypto";
import { resolveAlert } from "../lib/alerts";

type Incident = typeof incidents.$inferSelect;

async function lockIncident(tx: Tx, id: string, expectedVersion?: number | null): Promise<Incident> {
  const [inc] = await tx.select().from(incidents).where(eq(incidents.id, id)).for("update");
  if (!inc) throw notFound("Incident not found");
  if (expectedVersion != null && expectedVersion !== inc.version) {
    throw conflict("This incident was updated by someone else a moment ago. Review the latest information and try again.", { currentVersion: inc.version });
  }
  return inc;
}
const bump = () => ({ version: sql`${incidents.version} + 1`, updatedAt: clock.now() });

// ───────────────────────────── 1. Cause confirmation ─────────────────────────────

export async function confirmCause(db: DB, actor: Actor, input: { incidentId: string; causeKey: string; expectedVersion?: number; note?: string }) {
  return db.transaction(async (tx) => {
    const inc = await lockIncident(tx, input.incidentId, input.expectedVersion);
    if (!["validating", "active", "restoring"].includes(inc.phase)) throw badRequest("The cause can only be confirmed while the outage is open.");
    const [cause] = await tx.select().from(causeOptions).where(and(eq(causeOptions.key, input.causeKey), eq(causeOptions.active, true)));
    if (!cause) throw badRequest("Unknown cause option");
    if (inc.causeKey === cause.key) return { incident: inc, communications: [] as CreatedComm[], unchanged: true };
    const [site] = await tx.select().from(sites).where(eq(sites.id, inc.siteId));
    const now = clock.now();
    const correction = !!inc.causeKey;
    await tx.update(causeConfirmations).set({ supersededAt: now }).where(and(eq(causeConfirmations.incidentId, inc.id), sql`${causeConfirmations.supersededAt} is null`));
    const [conf] = await tx.insert(causeConfirmations).values({ incidentId: inc.id, causeKey: cause.key, confirmedBy: actor.id!, confirmedAt: now, note: input.note ?? "", isCorrection: correction }).returning();
    await tx.update(incidents).set({
      causeKey: cause.key, causeConfirmedBy: actor.id, causeConfirmedAt: now,
      ...(cause.assignsTechnical ? { technicalAssigned: true, assignedTeam: site.technicalTeam } : {}),
      ...bump(),
    }).where(eq(incidents.id, inc.id));
    await audit(tx, actor, correction ? "incident.cause_corrected" : "incident.cause_confirmed", "incident", inc.id, { causeKey: inc.causeKey }, { causeKey: cause.key, note: input.note });
    await addTimeline(tx, inc.id, "cause", `${correction ? "Cause corrected" : "Cause confirmed"}: ${cause.label}${input.note ? ` — ${input.note}` : ""}`, actor, { confirmationId: conf.id });
    await resolveAlert(tx, `cause_overdue:${inc.id}`);

    let comms: CreatedComm[] = [];
    if (inc.phase === "active") {
      // A correction must never leave two conflicting cause messages in flight.
      if (correction) await cancelUnsentCommunications(tx, inc.id, ["cause"], "Superseded by a corrected cause");
      comms = await createCommunications(tx, { incidentId: inc.id, requestedKind: cause.templateKind, purpose: "cause", idempotencyBase: `cause:${conf.id}`, triggeredBy: actor.id });
      if (comms.length) await scheduleNextUpdate(tx, inc.id, now);
    } else if (inc.phase === "validating") {
      await addTimeline(tx, inc.id, "system", "Cause will be used for the first message once the outage is validated");
    }
    if (cause.assignsTechnical) {
      const to = await internalAddresses(tx, { team: site.technicalTeam, roles: ["technical"] });
      await queueInternal(tx, {
        key: `tech-assign:${conf.id}`, incidentId: inc.id, to,
        subject: `${inc.reference} ${site.name}: ${cause.label} — technical investigation required`,
        text: `Incident ${inc.reference} at ${site.name} (${site.estate}).\nService Desk confirmed: ${cause.label}.\nOutage started ${fmtDateTime(inc.outageStartedAt)}.\nBackhaul circuit: ${site.circuitRef || "—"}\n\nPlease investigate and enter the provider's update in the portal.`,
      });
      await addTimeline(tx, inc.id, "system", `Technical (${site.technicalTeam}) notified`);
    }
    await refreshStatus(tx, inc.id, `Cause: ${cause.label}`, actor.id);
    const [fresh] = await tx.select().from(incidents).where(eq(incidents.id, inc.id));
    return { incident: fresh, communications: comms, unchanged: false, requiresDispatch: cause.requiresDispatch };
  });
}

// ───────────────────────────── 2. Technical updates ─────────────────────────────

export const FactsSchema = z.object({
  providerId: z.string().uuid().nullable().optional(),
  faultType: z.string().max(64).nullable().optional(),
  technicians: z.enum(["dispatched", "on_site"]).nullable().optional(),
  repairStatus: z.enum(["investigating", "underway", "delayed", "completed"]).nullable().optional(),
  eta: z.string().datetime({ offset: true }).nullable().optional(),
  etaUnavailable: z.boolean().optional(),
  providerRef: z.string().max(64).regex(/^[A-Za-z0-9\-\/#_. ]*$/).nullable().optional(),
  nextProviderUpdate: z.string().datetime({ offset: true }).nullable().optional(),
  furtherInvestigation: z.boolean().optional(),
}).strict();
export type Facts = z.infer<typeof FactsSchema>;

const PRIORITY = ["eta_changed", "eta_available", "repair_delayed", "repairs_completed", "technicians_on_site", "repairs_underway", "technicians_dispatched", "__fault__", "eta_unavailable"];

export interface TechPlan { next: TechState; changes: string[]; external: string[]; requestedKind: string | null; errors: string[] }

/** Pure-ish diff of verified facts → what changed, and which approved message (if any) that warrants. */
export async function planTechnicalUpdate(tx: Tx, current: TechState, f: Facts): Promise<TechPlan> {
  const now = clock.now();
  const next: TechState = { ...current };
  const changes: string[] = [], external: string[] = [], errors: string[] = [];
  let faultKind: string | null = null;

  if (f.providerId !== undefined) {
    if (f.providerId) {
      const [p] = await tx.select().from(backhaulProviders).where(eq(backhaulProviders.id, f.providerId));
      if (!p) errors.push("Unknown provider");
      else if (p.id !== current.providerId) { next.providerId = p.id; next.providerName = p.publicName; changes.push("provider_identified"); }
    } else if (current.providerId) { next.providerId = null; next.providerName = null; changes.push("provider_cleared"); }
  }
  if (f.faultType !== undefined) {
    if (f.faultType) {
      const [ft] = await tx.select().from(faultTypes).where(and(eq(faultTypes.key, f.faultType), eq(faultTypes.active, true)));
      if (!ft) errors.push("Unknown fault type");
      else if (ft.key !== current.faultType) {
        next.faultType = ft.key; next.faultDescription = ft.publicDescription;
        changes.push(`fault:${ft.key}`); external.push("__fault__"); faultKind = ft.templateKind;
      }
    } else if (current.faultType) { next.faultType = null; next.faultDescription = null; changes.push("fault_cleared"); }
  }
  if (f.technicians !== undefined && f.technicians !== (current.technicians ?? null)) {
    next.technicians = f.technicians;
    if (f.technicians === "on_site") { changes.push("technicians_on_site"); external.push("technicians_on_site"); }
    else if (f.technicians === "dispatched") { changes.push("technicians_dispatched"); if (current.technicians !== "on_site") external.push("technicians_dispatched"); }
    else changes.push("technicians_cleared");
  }
  if (f.repairStatus !== undefined && f.repairStatus !== (current.repairStatus ?? null)) {
    next.repairStatus = f.repairStatus;
    changes.push(`repair:${f.repairStatus ?? "cleared"}`);
    if (f.repairStatus === "underway") external.push("repairs_underway");
    if (f.repairStatus === "delayed") external.push("repair_delayed");
    if (f.repairStatus === "completed") external.push("repairs_completed");
  }
  if (f.eta !== undefined) {
    if (f.eta) {
      const eta = new Date(f.eta);
      if (eta.getTime() < now.getTime() - 60_000) errors.push("The ETA is in the past — check the time and date");
      else if (!current.eta || Math.abs(new Date(current.eta).getTime() - eta.getTime()) > 60_000 || current.etaUnavailable) {
        const hadEta = !!current.eta && !current.etaUnavailable && new Date(current.eta) > now;
        next.eta = eta.toISOString(); next.etaSetAt = now.toISOString(); next.etaUnavailable = false;
        changes.push(hadEta ? "eta_changed" : "eta_available"); external.push(hadEta ? "eta_changed" : "eta_available");
      }
    } else if (current.eta) { next.eta = null; changes.push("eta_cleared"); }
  }
  if (f.etaUnavailable) {
    if (f.eta) errors.push("Choose either an ETA or 'no ETA', not both");
    else if (!current.etaUnavailable) {
      const hadEta = !!current.eta;
      next.eta = null; next.etaUnavailable = true;
      changes.push("eta_unavailable");
      if (hadEta) external.push("eta_unavailable"); // withdrawing a promised ETA is customer-relevant
    }
  }
  if (f.providerRef !== undefined && (f.providerRef ?? null) !== (current.providerRef ?? null)) { next.providerRef = f.providerRef || null; changes.push("provider_ref"); }
  if (f.nextProviderUpdate !== undefined && f.nextProviderUpdate !== (current.nextProviderUpdate ?? null)) { next.nextProviderUpdate = f.nextProviderUpdate; changes.push("next_provider_update"); }
  if (f.furtherInvestigation !== undefined && f.furtherInvestigation !== !!current.furtherInvestigation) { next.furtherInvestigation = f.furtherInvestigation; changes.push("further_investigation"); }

  let requestedKind: string | null = null;
  for (const k of PRIORITY) if (external.includes(k)) { requestedKind = k === "__fault__" ? faultKind : k; break; }
  return { next, changes, external, requestedKind, errors };
}

/** Analyse pasted text and show EXACTLY what would be sent, before anything is committed. */
export async function previewTechnicalUpdate(db: DB, input: { incidentId: string; text?: string; facts?: Facts }) {
  return db.transaction(async (tx) => {
    const [inc] = await tx.select().from(incidents).where(eq(incidents.id, input.incidentId));
    if (!inc) throw notFound();
    const extraction: Extraction | null = input.text ? await extract(tx, input.text) : null;
    const facts = input.facts ?? (extraction ? factsFromExtraction(extraction, (await getSettings(tx)).extractionConfidence) : {});
    const plan = await planTechnicalUpdate(tx, (inc.techState ?? {}) as TechState, facts);
    let preview: { audience: string; kind: string | null; subject: string; body: string; tried: string[] }[] = [];
    if (plan.requestedKind && inc.phase === "active" && !plan.errors.length) {
      const [site] = await tx.select().from(sites).where(eq(sites.id, inc.siteId));
      const settings = await getSettings(tx);
      const hypothetical = { ...inc, techState: plan.next } as Incident;
      for (const aud of ["resident", "isp"] as const) {
        const vars = await buildVars(tx, hypothetical, site, settings, "technical");
        const sel = await selectAndRender(tx, plan.requestedKind, aud, vars);
        preview.push({ audience: aud, kind: sel.kind, subject: sel.subject, body: sel.body, tried: sel.tried });
      }
    }
    // Read-only: a preview never changes anything.
    return { extraction, facts, plan, preview, phase: inc.phase, version: inc.version };
  });
}

export function factsFromExtraction(ex: Extraction, minConfidence: number): Facts {
  const conflicted = new Set(ex.conflicts.map((c) => c.field));
  const ok = <T>(f?: { value: T; confidence: number }, field?: string) => (f && f.confidence >= minConfidence && !conflicted.has(field ?? "") ? f.value : undefined);
  return {
    providerId: ok(ex.provider, "provider")?.id,
    faultType: ok(ex.faultType, "faultType"),
    technicians: ok(ex.technicians, "technicians"),
    repairStatus: ok(ex.repairStatus, "repairStatus"),
    eta: ok(ex.eta, "eta"),
    etaUnavailable: ok(ex.etaUnavailable, "eta") ? true : undefined,
    providerRef: ok(ex.providerRef, "providerRef"),
    nextProviderUpdate: ok(ex.nextProviderUpdate, "nextProviderUpdate"),
    furtherInvestigation: ok(ex.furtherInvestigation) ? true : undefined,
  };
}

export async function submitTechnicalUpdate(db: DB, actor: Actor, input: {
  incidentId: string; text: string; facts: Facts; expectedVersion?: number;
  /** Fields the extractor flagged as conflicting that the technician explicitly reviewed. */
  acknowledgedConflicts?: string[]; internalOnly?: boolean; applyToGroup?: boolean;
}) {
  const facts = FactsSchema.parse(input.facts);
  if (!input.text.trim()) throw badRequest("Paste or type the update you received");
  return db.transaction(async (tx) => {
    const inc = await lockIncident(tx, input.incidentId, input.expectedVersion);
    if (inc.phase === "resolved" || inc.phase === "interruption") throw badRequest("This incident is closed.");
    const extraction = await extract(tx, input.text);
    const unreviewed = extraction.conflicts.map((c) => c.field).filter((f) => !(input.acknowledgedConflicts ?? []).includes(f) && (facts as Record<string, unknown>)[f] !== undefined);
    if (unreviewed.length) throw badRequest(`The update contains contradictory information (${unreviewed.join(", ")}). Confirm those fields before sending.`, { conflicts: extraction.conflicts });

    const targets: Incident[] = [inc];
    if (input.applyToGroup && inc.groupId) {
      const others = await tx.select().from(incidents).where(and(eq(incidents.groupId, inc.groupId), ne(incidents.id, inc.id), inArray(incidents.phase, ["validating", "active", "restoring"]))).for("update");
      targets.push(...others);
    }
    const results: { incidentId: string; updateId: string; changes: string[]; communications: CreatedComm[] }[] = [];
    const now = clock.now();
    const settings = await getSettings(tx);
    for (const [i, t] of targets.entries()) {
      const plan = await planTechnicalUpdate(tx, (t.techState ?? {}) as TechState, facts);
      if (plan.errors.length) throw badRequest(plan.errors.join(". "));
      const meaningful = !!plan.requestedKind && !input.internalOnly;
      const [upd] = await tx.insert(technicalUpdates).values({
        incidentId: t.id, authorId: actor.id!, originalText: input.text, extraction: extraction as object, confirmedFacts: facts as object,
        changes: plan.changes, meaningful, extractor: extraction.extractor, createdAt: now,
      }).returning();
      await tx.update(incidents).set({ techState: plan.next, lastTechnicalUpdateAt: now, technicalAssigned: true, ...bump() }).where(eq(incidents.id, t.id));
      await audit(tx, actor, "incident.technical_update", "incident", t.id, t.techState, plan.next);
      await addTimeline(tx, t.id, "technical", plan.changes.length ? `Technical update: ${plan.changes.join(", ").replace(/_/g, " ")}` : "Technical note added (no change to verified facts)", actor, { updateId: upd.id, text: input.text });
      await resolveAlert(tx, `tech_overdue:${t.id}`);

      let comms: CreatedComm[] = [];
      if (meaningful && t.phase === "active") {
        comms = await createCommunications(tx, {
          incidentId: t.id, requestedKind: plan.requestedKind!, purpose: "technical", idempotencyBase: `tech:${upd.id}`,
          triggeredBy: actor.id, technicalUpdateId: upd.id, isp: targets.length > 1 ? (i === 0 ? "group" : "skip") : "self",
        });
        if (comms.length && settings.resetIntervalOnImmediate) await scheduleNextUpdate(tx, t.id, now);
        await tx.update(technicalUpdates).set({ communicationIds: comms.map((c) => c.id) }).where(eq(technicalUpdates.id, upd.id));
      } else if (meaningful) {
        await addTimeline(tx, t.id, "system", `No outage update sent: incident is ${t.phase.replace("_", " ")}`);
      }
      await refreshStatus(tx, t.id, "Technical update", actor.id);
      results.push({ incidentId: t.id, updateId: upd.id, changes: plan.changes, communications: comms });
    }
    return { results };
  });
}

// ───────────────────────────── 3. Technician dispatch ─────────────────────────────

export async function createDispatch(db: DB, actor: Actor, input: { incidentId: string; notes?: string; expectedVersion?: number; externalRef?: string }) {
  return db.transaction(async (tx) => {
    const inc = await lockIncident(tx, input.incidentId, input.expectedVersion);
    if (!["validating", "active", "restoring"].includes(inc.phase)) throw badRequest("Dispatch can only be logged for an open outage");
    const [existing] = await tx.select().from(technicianDispatches).where(and(eq(technicianDispatches.incidentId, inc.id), inArray(technicianDispatches.status, ["requested", "sent", "acknowledged", "on_site"])));
    if (existing) throw conflict(`Dispatch ${existing.reference} is already open for this incident`, { dispatchId: existing.id });
    const [site] = await tx.select().from(sites).where(eq(sites.id, inc.siteId));
    const [cause] = inc.causeKey ? await tx.select().from(causeOptions).where(eq(causeOptions.key, inc.causeKey)) : [];
    const now = clock.now();
    const n = Number(((await tx.execute(sql`select nextval('dispatch_reference_seq') as n`)).rows[0] as { n: string }).n);
    const reference = `DSP-${String(n).padStart(6, "0")}`;
    const token = randomToken(24);
    const workOrder = {
      siteName: site.name, siteCode: site.code, estate: site.estate, incident: inc.reference, location: site.address,
      coordinates: site.latitude != null ? `${site.latitude},${site.longitude}` : "", confirmedIssue: cause?.label ?? "Not yet confirmed",
      outageStart: fmtDateTime(inc.outageStartedAt), downtimeAtDispatch: fmtDuration((now.getTime() - inc.outageStartedAt.getTime()) / 1000),
      priority: "URGENT", technicalNotes: input.notes ?? "", circuit: site.circuitRef,
    };
    const [d] = await tx.insert(technicianDispatches).values({
      incidentId: inc.id, reference, team: site.technicalTeam, workOrder, requestedBy: actor.id!, requestedAt: now,
      ackTokenHash: sha256(token), notes: input.notes ?? "", externalRef: input.externalRef ?? null, status: "requested",
    }).returning();
    await tx.update(incidents).set(bump()).where(eq(incidents.id, inc.id));
    await audit(tx, actor, "dispatch.created", "technician_dispatch", d.id, null, workOrder);
    await addTimeline(tx, inc.id, "dispatch", `URGENT technician dispatch ${reference} logged`, actor, { dispatchId: d.id });
    const ackUrl = `${process.env.PUBLIC_BASE_URL ?? ""}/dispatch/${token}`;
    const to = await internalAddresses(tx, { team: site.technicalTeam, roles: ["technical"], emails: (process.env.DISPATCH_EMAILS ?? "").split(",") });
    await queueInternal(tx, {
      key: `dispatch:${d.id}`, incidentId: inc.id, dispatchId: d.id, to,
      subject: `URGENT DISPATCH ${reference} — ${site.name} (${inc.reference})`,
      text: [
        `URGENT technician dispatch ${reference}`, ``,
        `Site: ${site.name} (${site.code}), ${site.estate}`, `Location: ${site.address || "—"} ${workOrder.coordinates}`,
        `Incident: ${inc.reference}`, `Confirmed issue: ${workOrder.confirmedIssue}`,
        `Outage started: ${workOrder.outageStart} (down ${workOrder.downtimeAtDispatch} at dispatch)`, `Circuit: ${site.circuitRef || "—"}`,
        `Notes: ${input.notes || "—"}`, ``, `ACKNOWLEDGE: ${ackUrl}`,
      ].join("\n"),
    });
    await refreshStatus(tx, inc.id, "Dispatch logged", actor.id);
    return { dispatch: d, ackUrl };
  });
}

export async function acknowledgeDispatchByToken(db: DB, token: string, name: string) {
  return db.transaction(async (tx) => {
    const [d] = await tx.select().from(technicianDispatches).where(eq(technicianDispatches.ackTokenHash, sha256(token))).for("update");
    if (!d) throw notFound("This dispatch link is not valid");
    if (d.acknowledgedAt) return d;
    if (d.status === "cancelled" || d.status === "completed") throw badRequest("This dispatch is closed");
    const now = clock.now();
    const [u] = await tx.update(technicianDispatches).set({ status: "acknowledged", acknowledgedAt: now, acknowledgedBy: name.slice(0, 100) }).where(eq(technicianDispatches.id, d.id)).returning();
    await audit(tx, { id: null, label: `Technician: ${name}` }, "dispatch.acknowledged", "technician_dispatch", d.id);
    await addTimeline(tx, d.incidentId, "dispatch", `Dispatch ${d.reference} acknowledged by ${name}`, { id: null, label: name });
    await resolveAlert(tx, `dispatch_unack:${d.id}`);
    await refreshStatus(tx, d.incidentId, "Dispatch acknowledged");
    return u;
  });
}

export async function setDispatchStatus(db: DB, actor: Actor, input: { dispatchId: string; status: "acknowledged" | "on_site" | "completed" | "cancelled"; note?: string; externalRef?: string }) {
  return db.transaction(async (tx) => {
    const [d] = await tx.select().from(technicianDispatches).where(eq(technicianDispatches.id, input.dispatchId)).for("update");
    if (!d) throw notFound();
    const order = ["requested", "sent", "acknowledged", "on_site", "completed"];
    if (input.status !== "cancelled" && order.indexOf(input.status) < order.indexOf(d.status)) throw badRequest("Dispatch is already past that stage");
    const now = clock.now();
    const patch: Partial<typeof technicianDispatches.$inferInsert> = { status: input.status };
    if (input.status === "acknowledged" && !d.acknowledgedAt) { patch.acknowledgedAt = now; patch.acknowledgedBy = actor.label; }
    if (input.status === "on_site") { patch.onSiteAt = now; if (!d.acknowledgedAt) { patch.acknowledgedAt = now; patch.acknowledgedBy = actor.label; } }
    if (input.status === "completed") patch.completedAt = now;
    if (input.status === "cancelled") patch.cancelledAt = now;
    if (input.externalRef) patch.externalRef = input.externalRef;
    if (input.note) patch.notes = `${d.notes}\n${input.note}`.trim();
    await tx.update(technicianDispatches).set(patch).where(eq(technicianDispatches.id, d.id));
    await audit(tx, actor, `dispatch.${input.status}`, "technician_dispatch", d.id, { status: d.status }, patch);
    await addTimeline(tx, d.incidentId, "dispatch", `Dispatch ${d.reference}: ${input.status.replace("_", " ")}${input.note ? ` — ${input.note}` : ""}`, actor);
    if (input.status !== "cancelled") await resolveAlert(tx, `dispatch_unack:${d.id}`);
    await refreshStatus(tx, d.incidentId, `Dispatch ${input.status}`, actor.id);
  });
}

// ───────────────────────────── RFO ─────────────────────────────

export const RfoSchema = z.object({
  rfoText: z.string().trim().min(10, "Enter the verified reason for outage").max(1500),
  providerRef: z.string().max(64).optional().default(""),
  receivedAt: z.string().datetime({ offset: true }).optional(),
  internalNotes: z.string().max(4000).optional().default(""),
});

export async function submitRfo(db: DB, actor: Actor, input: { incidentId: string; expectedVersion?: number } & z.input<typeof RfoSchema>) {
  const r = RfoSchema.parse(input);
  return db.transaction(async (tx) => {
    const inc = await lockIncident(tx, input.incidentId, input.expectedVersion);
    if (inc.phase !== "awaiting_rfo") throw badRequest("An RFO can only be entered once the link is restored and the incident is awaiting RFO.");
    if (inc.rfoStatus === "sent") throw conflict("The RFO for this incident has already been sent.");
    const now = clock.now();
    const [rec] = await tx.insert(rfoRecords).values({
      incidentId: inc.id, rfoText: r.rfoText, providerRef: r.providerRef, internalNotes: r.internalNotes,
      receivedAt: r.receivedAt ? new Date(r.receivedAt) : now, enteredBy: actor.id!, enteredAt: now,
    }).returning();
    await tx.update(incidents).set({ rfoStatus: "sent", ...bump() }).where(eq(incidents.id, inc.id));
    await audit(tx, actor, "incident.rfo_entered", "incident", inc.id, null, { rfoText: r.rfoText, providerRef: r.providerRef });
    await addTimeline(tx, inc.id, "rfo", "Verified RFO entered — sending final communication", actor, { rfoId: rec.id });
    const comms = await createCommunications(tx, {
      incidentId: inc.id, requestedKind: "final_rfo", purpose: "final", idempotencyBase: `final:${inc.id}:${rec.id}`,
      triggeredBy: actor.id, extraVars: { rfo: r.rfoText },
    });
    if (!comms.length) throw badRequest("No published 'Final RFO' template is available — ask an administrator to publish one.");
    await tx.update(rfoRecords).set({ communicationId: comms[0].id }).where(eq(rfoRecords.id, rec.id));
    await resolveAlert(tx, `rfo_overdue:${inc.id}`);
    return { rfo: rec, communications: comms };
  });
}

export async function waiveRfo(db: DB, actor: Actor, input: { incidentId: string; reason: string; expectedVersion?: number; sendFinal: boolean }) {
  if (input.reason.trim().length < 10) throw badRequest("Give the authorised reason (at least 10 characters)");
  return db.transaction(async (tx) => {
    const inc = await lockIncident(tx, input.incidentId, input.expectedVersion);
    if (inc.phase !== "awaiting_rfo" || inc.rfoStatus === "sent") throw badRequest("Only an incident awaiting RFO can be closed without one.");
    await tx.update(incidents).set({ rfoStatus: "waived", rfoWaiverReason: input.reason.trim(), ...bump() }).where(eq(incidents.id, inc.id));
    await audit(tx, actor, "incident.rfo_waived", "incident", inc.id, { rfoStatus: inc.rfoStatus }, { rfoStatus: "waived", reason: input.reason });
    await addTimeline(tx, inc.id, "rfo", `RFO not required — authorised by ${actor.label}: ${input.reason.trim()}`, actor);
    await resolveAlert(tx, `rfo_overdue:${inc.id}`);
    if (input.sendFinal) {
      const comms = await createCommunications(tx, { incidentId: inc.id, requestedKind: "final_no_rfo", purpose: "final", idempotencyBase: `final:${inc.id}:waiver`, triggeredBy: actor.id });
      if (comms.length) return { communications: comms };
    }
    const now = clock.now();
    await tx.update(incidents).set({ phase: "resolved", status: "resolved", resolvedAt: now, ...bump() }).where(eq(incidents.id, inc.id));
    await recordTransition(tx, inc, "resolved", "resolved", "RFO waived by administrator", actor.id);
    return { communications: [] };
  });
}

// ───────────────────────────── Correlation groups ─────────────────────────────

export async function decideCorrelation(db: DB, actor: Actor, input: { suggestionId: string; accept: boolean }) {
  return db.transaction(async (tx) => {
    const [sgg] = await tx.select().from(correlationSuggestions).where(eq(correlationSuggestions.id, input.suggestionId)).for("update");
    if (!sgg || sgg.status !== "open") throw notFound("Suggestion no longer open");
    const now = clock.now();
    await tx.update(correlationSuggestions).set({ status: input.accept ? "accepted" : "dismissed", decidedBy: actor.id, decidedAt: now }).where(eq(correlationSuggestions.id, sgg.id));
    await audit(tx, actor, input.accept ? "correlation.accepted" : "correlation.dismissed", "correlation_suggestion", sgg.id);
    if (!input.accept) return { groupId: null };
    const members = await tx.select().from(incidents).where(inArray(incidents.id, sgg.incidentIds)).for("update");
    let groupId = members.find((m) => m.groupId)?.groupId ?? null;
    if (!groupId) {
      const n = Number(((await tx.execute(sql`select nextval('group_reference_seq') as n`)).rows[0] as { n: string }).n);
      const [g] = await tx.insert(incidentGroups).values({ reference: `GRP-${String(n).padStart(5, "0")}`, label: sgg.reason, reason: sgg.reason, createdBy: actor.id, createdAt: now }).returning();
      groupId = g.id;
    }
    for (const m of members) {
      await tx.update(incidents).set({ groupId, ...bump() }).where(eq(incidents.id, m.id));
      await addTimeline(tx, m.id, "system", `Linked to related outages (${members.length} sites): ${sgg.reason}`, actor);
    }
    return { groupId };
  });
}

// ───────────────────────────── Previews for confirmation dialogs ─────────────────────────────

/** Exactly what residents would receive if this cause were confirmed now. */
export async function previewCause(db: DB, incidentId: string, causeKey: string) {
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!inc) throw notFound();
  const [cause] = await db.select().from(causeOptions).where(eq(causeOptions.key, causeKey));
  if (!cause) throw badRequest("Unknown cause");
  const [site] = await db.select().from(sites).where(eq(sites.id, inc.siteId));
  const settings = await getSettings(db);
  const hypothetical = { ...inc, causeKey } as Incident;
  const vars = await buildVars(db, hypothetical, site, settings, "cause");
  const sel = await selectAndRender(db, cause.templateKind, "resident", vars);
  return {
    cause: { key: cause.key, label: cause.label, requiresDispatch: cause.requiresDispatch, assignsTechnical: cause.assignsTechnical },
    willSendNow: inc.phase === "active", phase: inc.phase, siteName: site.name,
    kind: sel.kind, subject: sel.subject, body: sel.body,
  };
}

export async function previewRfo(db: DB, incidentId: string, rfoText: string) {
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!inc) throw notFound();
  const [site] = await db.select().from(sites).where(eq(sites.id, inc.siteId));
  const vars = await buildVars(db, inc, site, await getSettings(db), "final", { rfo: rfoText.trim() || undefined });
  const sel = await selectAndRender(db, "final_rfo", "resident", vars);
  return { kind: sel.kind, subject: sel.subject, body: sel.body, tried: sel.tried };
}
