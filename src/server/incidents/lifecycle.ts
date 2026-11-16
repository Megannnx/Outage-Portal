/**
 * Monitoring-driven incident lifecycle + the server-side jobs that run it.
 *
 * Concurrency: every change for a site runs inside a transaction holding a
 * per-site advisory lock, so simultaneous events, timers and retries for the
 * same site are applied one at a time, in order. Different sites never block
 * each other.
 */
import { and, desc, eq, inArray, isNotNull, ne, or, sql, gte, lte } from "drizzle-orm";
import type { DB, Tx } from "../db/client";
import {
  causeOptions, correlationSuggestions, communicationSchedules, incidents, monitoredObjectState, monitoringEvents,
  siteMonitoringIdentifiers, sites,
} from "../db/schema";
import { clock, addMinutes, minutesBetween } from "../lib/clock";
import { getSettings } from "../domain/settings";
import { raiseAlert, healthOk } from "../lib/alerts";
import { enqueue, cancelJobs } from "../scheduler/jobs";
import { addTimeline } from "./timeline";
import { deriveStatus, recordTransition, assertTransition } from "./transitions";
import {
  createCommunications, scheduleNextUpdate, stopSchedule, deferScheduleTo, cancelUnsentCommunications,
} from "../comms/engine";
import type { NormalizedEvent } from "../ingestion/normalize";
import { fmtDuration, fmtTime } from "../lib/time";
import type { TechState } from "../domain/catalog";

type Incident = typeof incidents.$inferSelect;
const OPEN = ["validating", "active", "restoring"] as const;

export async function lockSite(tx: Tx, siteId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"site:" + siteId}))`);
}

async function nextReference(tx: Tx, seq: "incident_reference_seq" | "group_reference_seq", prefix: string) {
  const r = await tx.execute(sql`select nextval(${seq}) as n`);
  const n = Number((r.rows[0] as { n: string }).n);
  return `${prefix}-${clock.now().getUTCFullYear()}-${String(n).padStart(6, "0")}`;
}

async function siteIsDown(tx: Tx, siteId: string): Promise<boolean> {
  const rows = await tx.select({ state: monitoredObjectState.state })
    .from(monitoredObjectState)
    .innerJoin(siteMonitoringIdentifiers, eq(siteMonitoringIdentifiers.id, monitoredObjectState.identifierId))
    .where(and(eq(monitoredObjectState.siteId, siteId), eq(siteMonitoringIdentifiers.critical, true)));
  return rows.some((r) => r.state === "down");
}

/** Latest "up" moment across the site's critical objects (for stability checks). */
async function siteUpSince(tx: Tx, siteId: string): Promise<Date | null> {
  const rows = await tx.select({ s: monitoredObjectState }).from(monitoredObjectState)
    .innerJoin(siteMonitoringIdentifiers, eq(siteMonitoringIdentifiers.id, monitoredObjectState.identifierId))
    .where(and(eq(monitoredObjectState.siteId, siteId), eq(siteMonitoringIdentifiers.critical, true)));
  if (rows.some((r) => r.s.state === "down")) return null;
  const ups = rows.map((r) => r.s.lastUpAt?.getTime() ?? 0);
  return ups.length ? new Date(Math.max(...ups)) : null;
}

async function matchIdentifier(tx: Tx, ev: NormalizedEvent) {
  const isInterface = ev.objectRef.includes("/");
  const cands = await tx.select().from(siteMonitoringIdentifiers).where(and(
    inArray(siteMonitoringIdentifiers.source, [ev.source, "any"]),
    or(
      and(eq(siteMonitoringIdentifiers.matchType, "object_id"), eq(siteMonitoringIdentifiers.value, ev.objectRef)),
      isInterface ? sql`false` : and(eq(siteMonitoringIdentifiers.matchType, "name_exact"), sql`lower(${siteMonitoringIdentifiers.value}) = lower(${ev.objectName})`),
      isInterface ? sql`false` : and(eq(siteMonitoringIdentifiers.matchType, "name_prefix"), sql`${ev.objectName} <> '' and lower(${ev.objectName}) like lower(${siteMonitoringIdentifiers.value}) || '%'`),
    )));
  const rank = (m: string) => (m === "object_id" ? 3 : m === "name_exact" ? 2 : 1);
  cands.sort((a, b) => rank(b.matchType) - rank(a.matchType) || b.value.length - a.value.length);
  const id = cands[0];
  if (!id) return null;
  const [site] = await tx.select().from(sites).where(eq(sites.id, id.siteId));
  return site?.active ? { identifier: id, site } : null;
}

async function setPhase(tx: Tx, inc: Incident, phase: Incident["phase"], patch: Partial<typeof incidents.$inferInsert>, reason: string, actorId: string | null = null) {
  assertTransition(inc.phase, phase);
  const next = { ...inc, ...patch, phase } as Incident;
  const status = await deriveStatus(tx, next);
  await tx.update(incidents).set({ ...patch, phase, status, updatedAt: clock.now(), version: sql`${incidents.version} + 1` }).where(eq(incidents.id, inc.id));
  await recordTransition(tx, inc, phase, status, reason, actorId);
  return { ...next, status };
}

// ───────────────────────────── Event processing ─────────────────────────────

export interface ProcessResult { result: "processed" | "duplicate" | "unmatched" | "stale" | "ignored"; eventId?: string; incidentId?: string; note?: string }

export async function processEvent(db: DB, ev: NormalizedEvent): Promise<ProcessResult> {
  return db.transaction(async (tx) => {
    const s = await getSettings(tx);
    await healthOk(tx, `monitoring:${ev.source}`, ev.source === "netxms" ? "NetXMS events" : `${ev.source} events`, { lastEvent: `${ev.eventName} ${ev.objectName}`.trim() });

    const insertEvent = async (processing: "processed" | "unmatched" | "ignored", siteId: string | null, identifierId: string | null, note = "") => {
      const [row] = await tx.insert(monitoringEvents).values({
        source: ev.source, dedupeKey: ev.dedupeKey, kind: ev.kind, eventName: ev.eventName, objectRef: ev.objectRef, objectName: ev.objectName,
        siteId, identifierId, occurredAt: ev.occurredAt, receivedAt: clock.now(), processing, note, raw: ev.raw as object,
      }).onConflictDoNothing({ target: monitoringEvents.dedupeKey }).returning({ id: monitoringEvents.id });
      return row?.id ?? null;
    };

    if (ev.kind === "heartbeat" || ev.kind === "unknown") {
      const id = await insertEvent("ignored", null, null, ev.kind === "heartbeat" ? "Heartbeat" : "Event type not mapped to down/up");
      return { result: id ? "ignored" : "duplicate", eventId: id ?? undefined };
    }

    const match = await matchIdentifier(tx, ev);
    if (!match) {
      const id = await insertEvent("unmatched", null, null, "No site matches this monitoring object");
      if (id) await raiseAlert(tx, `unmatched:${ev.source}:${ev.objectRef || ev.objectName}`, "warning",
        `Monitoring object "${ev.objectName || ev.objectRef}" (${ev.source}) is not linked to any site — its events are being ignored`);
      return { result: id ? "unmatched" : "duplicate", eventId: id ?? undefined };
    }
    const { identifier, site } = match;
    const eventId = await insertEvent("processed", site.id, identifier.id);
    if (!eventId) return { result: "duplicate" };

    await lockSite(tx, site.id);
    const mark = (processing: "processed" | "stale" | "ignored", note: string, incidentId?: string) =>
      tx.update(monitoringEvents).set({ processing, note, incidentId: incidentId ?? null }).where(eq(monitoringEvents.id, eventId));

    // ── Per-object state with out-of-order protection ──
    const [prev] = await tx.select().from(monitoredObjectState).where(eq(monitoredObjectState.identifierId, identifier.id));
    if (prev && ev.occurredAt.getTime() < prev.lastEventAt.getTime()) {
      const r = await handleOutOfOrder(tx, ev, site, prev, s.validationMinutes);
      await mark("stale", r.note, r.incidentId);
      return { result: "stale", eventId, incidentId: r.incidentId, note: r.note };
    }
    if (prev && prev.state === ev.kind) {
      // Same state repeated (e.g. NODE_DOWN then NODE_UNREACHABLE) — attach to the open incident, change nothing.
      const [open] = await tx.select().from(incidents).where(and(eq(incidents.siteId, site.id), inArray(incidents.phase, [...OPEN])));
      await mark("ignored", `Object already ${ev.kind}`, open?.id);
      return { result: "ignored", eventId, incidentId: open?.id };
    }
    const wasDown = await siteIsDown(tx, site.id);
    await tx.insert(monitoredObjectState).values({
      identifierId: identifier.id, siteId: site.id, state: ev.kind, lastEventAt: ev.occurredAt, lastEventId: eventId,
      lastDownAt: ev.kind === "down" ? ev.occurredAt : null, lastUpAt: ev.kind === "up" ? ev.occurredAt : null,
    }).onConflictDoUpdate({
      target: monitoredObjectState.identifierId,
      set: {
        state: ev.kind, lastEventAt: ev.occurredAt, lastEventId: eventId,
        ...(ev.kind === "down" ? { lastDownAt: ev.occurredAt } : { lastUpAt: ev.occurredAt }),
      },
    });
    if (!identifier.critical) {
      await mark("processed", "Non-critical object — recorded only");
      return { result: "processed", eventId };
    }
    const isDown = await siteIsDown(tx, site.id);
    const [open] = await tx.select().from(incidents).where(and(eq(incidents.siteId, site.id), inArray(incidents.phase, [...OPEN])));
    const label = `${ev.objectName || ev.objectRef} ${ev.kind === "down" ? "went DOWN" : "came UP"} (${ev.source} ${ev.eventName})`;

    // ── Site went down ──
    if (isDown && !wasDown) {
      if (open?.phase === "restoring") {
        await setPhase(tx, open, "active", { restoredAt: null, restorationDetectedAt: null, flapCount: open.flapCount + 1 }, "Link dropped again during the stability period");
        await cancelJobs(tx, open.id, ["verify_restoration"]);
        await addTimeline(tx, open.id, "monitoring", `${label} — restoration not stable, outage continues (flap #${open.flapCount + 1})`, null, { eventId }, ev.occurredAt);
        await mark("processed", "Flap during restoration", open.id);
        return { result: "processed", eventId, incidentId: open.id };
      }
      if (open) { await mark("processed", "Already in an open incident", open.id); return { result: "processed", eventId, incidentId: open.id }; }
      // Recently restored? Link the new incident so reporting can see the repeat.
      const [recent] = await tx.select().from(incidents).where(and(
        eq(incidents.siteId, site.id), inArray(incidents.phase, ["awaiting_rfo", "resolved"]),
        gte(incidents.restoredAt, addMinutes(ev.occurredAt, -s.relatedIncidentWindowMinutes)))).orderBy(desc(incidents.restoredAt)).limit(1);
      const reference = await nextReference(tx, "incident_reference_seq", "INC");
      const [inc] = await tx.insert(incidents).values({
        reference, siteId: site.id, phase: "validating", status: "validating", outageStartedAt: ev.occurredAt, detectedAt: clock.now(),
        relatedIncidentId: recent?.id ?? null, rfoStatus: "not_applicable", createdAt: clock.now(), updatedAt: clock.now(),
      }).returning();
      await recordTransition(tx, { id: inc.id, phase: null as any, status: null as any }, "validating", "validating", "Outage detected");
      await addTimeline(tx, inc.id, "monitoring", `${label} — validating for ${s.validationMinutes} min before notifying anyone`, null, { eventId }, ev.occurredAt);
      if (recent) await addTimeline(tx, inc.id, "system", `Repeat outage: ${recent.reference} was restored ${fmtDuration((ev.occurredAt.getTime() - (recent.restoredAt?.getTime() ?? 0)) / 1000)} earlier`);
      await enqueue(tx, { kind: "validate_outage", runAt: addMinutes(ev.occurredAt, s.validationMinutes), incidentId: inc.id, dedupeKey: `validate:${inc.id}`, payload: { incidentId: inc.id } });
      await mark("processed", "Incident created", inc.id);
      return { result: "processed", eventId, incidentId: inc.id };
    }

    // ── Site came back up ──
    if (!isDown && wasDown && open) {
      if (open.phase === "validating") {
        const mins = minutesBetween(open.outageStartedAt, ev.occurredAt);
        if (mins < s.validationMinutes) {
          await setPhase(tx, open, "interruption", { restoredAt: ev.occurredAt, downtimeSeconds: Math.round(mins * 60), restorationConfirmedAt: clock.now() }, "Restored inside the validation window");
          await cancelJobs(tx, open.id, ["validate_outage"]);
          await addTimeline(tx, open.id, "monitoring", `${label} — short interruption (${fmtDuration(mins * 60)}), no external communication sent`, null, { eventId }, ev.occurredAt);
        } else {
          // Real outage that we only learnt about after it ended (delayed events / worker outage).
          await setPhase(tx, open, "awaiting_rfo", { restoredAt: ev.occurredAt, downtimeSeconds: Math.round(mins * 60), restorationConfirmedAt: clock.now(), retrospective: true, rfoStatus: site.rfoRequired ? "awaiting" : "not_applicable" }, "Restored before validation could complete");
          await cancelJobs(tx, open.id, ["validate_outage"]);
          await addTimeline(tx, open.id, "system", `${label} — outage of ${fmtDuration(mins * 60)} ended before validation ran; no customer communication was sent`, null, { eventId });
          await raiseAlert(tx, `retrospective:${open.id}`, "warning", `${open.reference} (${site.name}): ${fmtDuration(mins * 60)} outage was only processed after it ended — review whether customers need a notice`, open.id);
        }
        await mark("processed", "Restored during validation", open.id);
        return { result: "processed", eventId, incidentId: open.id };
      }
      if (open.phase === "active") {
        await setPhase(tx, open, "restoring", { restoredAt: ev.occurredAt, restorationDetectedAt: clock.now() }, "Monitoring reports the link is up");
        const verifyAt = new Date(Math.max(clock.now().getTime(), addMinutes(ev.occurredAt, s.restorationStabilityMinutes).getTime()));
        await enqueue(tx, { kind: "verify_restoration", runAt: verifyAt, incidentId: open.id, dedupeKey: `verify:${open.id}:${ev.occurredAt.toISOString()}`, payload: { incidentId: open.id, upAt: ev.occurredAt.toISOString() } });
        await addTimeline(tx, open.id, "monitoring", `${label} — confirming stability for ${s.restorationStabilityMinutes} min`, null, { eventId }, ev.occurredAt);
        await mark("processed", "Restoration pending stability", open.id);
        return { result: "processed", eventId, incidentId: open.id };
      }
    }
    await mark("processed", isDown ? "Site still down" : "Site up, no open incident", open?.id);
    return { result: "processed", eventId, incidentId: open?.id };
  });
}

/** An event older than the object's current state (late delivery or reordering). */
async function handleOutOfOrder(tx: Tx, ev: NormalizedEvent, site: typeof sites.$inferSelect, prev: typeof monitoredObjectState.$inferSelect, validationMinutes: number): Promise<{ note: string; incidentId?: string }> {
  if (ev.kind !== "down" || prev.state !== "up" || !prev.lastUpAt || ev.occurredAt >= prev.lastUpAt) {
    return { note: "Older than current object state — history only" };
  }
  // A DOWN that belongs before an UP we already processed: the outage already ended.
  const [covering] = await tx.select().from(incidents).where(and(eq(incidents.siteId, site.id),
    lte(incidents.outageStartedAt, prev.lastUpAt), or(sql`${incidents.restoredAt} is null`, gte(incidents.restoredAt, ev.occurredAt)))).limit(1);
  if (covering) return { note: "Late event inside an existing incident", incidentId: covering.id };
  const mins = minutesBetween(ev.occurredAt, prev.lastUpAt);
  const reference = await nextReference(tx, "incident_reference_seq", "INC");
  const short = mins < validationMinutes;
  const [inc] = await tx.insert(incidents).values({
    reference, siteId: site.id, phase: short ? "interruption" : "awaiting_rfo", status: short ? "interruption" : "restored_awaiting_rfo",
    outageStartedAt: ev.occurredAt, detectedAt: clock.now(), restoredAt: prev.lastUpAt, restorationConfirmedAt: clock.now(),
    downtimeSeconds: Math.round(mins * 60), retrospective: !short, rfoStatus: !short && site.rfoRequired ? "awaiting" : "not_applicable",
    createdAt: clock.now(), updatedAt: clock.now(),
  }).returning();
  await recordTransition(tx, { id: inc.id, phase: null as any, status: null as any }, inc.phase, inc.status, "Reconstructed from out-of-order events");
  await addTimeline(tx, inc.id, "monitoring", `Out-of-order events: down at ${fmtTime(ev.occurredAt)} arrived after the up at ${fmtTime(prev.lastUpAt)} — ${short ? "short interruption recorded" : "missed outage recorded, no customer communication was sent"}`);
  if (!short) await raiseAlert(tx, `retrospective:${inc.id}`, "warning", `${reference} (${site.name}): ${fmtDuration(mins * 60)} outage reconstructed from late events`, inc.id);
  return { note: short ? "Reconstructed short interruption" : "Reconstructed missed outage", incidentId: inc.id };
}

// ───────────────────────────── Jobs ─────────────────────────────

/** 3-minute rule: still down → incident goes live and the first message goes out automatically. */
export async function runValidateOutage(db: DB, incidentId: string) {
  await db.transaction(async (tx) => {
    const [pre] = await tx.select().from(incidents).where(eq(incidents.id, incidentId));
    if (!pre) return;
    await lockSite(tx, pre.siteId);
    const [inc] = await tx.select().from(incidents).where(eq(incidents.id, incidentId));
    if (inc.phase !== "validating") return; // restored, or already validated by an earlier attempt
    if (!(await siteIsDown(tx, inc.siteId))) return; // the up event will settle it
    const now = clock.now();
    const live = await setPhase(tx, inc, "active", { validatedAt: now }, "Down for the full validation period");
    await addTimeline(tx, inc.id, "system", `Outage confirmed after ${Math.round(minutesBetween(inc.outageStartedAt, now))} min — sending initial communication`);
    // If the Service Desk already confirmed a cause during validation, lead with that wording.
    let kind = "initial_outage";
    if (live.causeKey) {
      const [c] = await tx.select().from(causeOptions).where(eq(causeOptions.key, live.causeKey));
      if (c) kind = c.templateKind;
    }
    await createCommunications(tx, { incidentId: inc.id, requestedKind: kind, purpose: "initial", idempotencyBase: `initial:${inc.id}` });
    await scheduleNextUpdate(tx, inc.id, now);
    // Correlation is advisory: it runs in a savepoint and can never block customer communication.
    try { await tx.transaction(async (sp) => { await suggestCorrelation(sp, inc.id); }); }
    catch (e) { console.error("[correlation] skipped:", (e as Error).message); }
  });
}

/** Restoration only counts once the link has stayed up for the stability period. */
export async function runVerifyRestoration(db: DB, incidentId: string, upAt: string) {
  await db.transaction(async (tx) => {
    const [pre] = await tx.select().from(incidents).where(eq(incidents.id, incidentId));
    if (!pre) return;
    await lockSite(tx, pre.siteId);
    const [inc] = await tx.select().from(incidents).where(eq(incidents.id, incidentId));
    if (inc.phase !== "restoring" || inc.restoredAt?.toISOString() !== upAt) return; // flapped / superseded
    const s = await getSettings(tx);
    const since = await siteUpSince(tx, inc.siteId);
    const now = clock.now();
    if (!since) return; // down again; the down event already handled it
    if (minutesBetween(since, now) < s.restorationStabilityMinutes - 0.01) {
      await enqueue(tx, { kind: "verify_restoration", runAt: addMinutes(since, s.restorationStabilityMinutes), incidentId, dedupeKey: `verify:${incidentId}:${since.toISOString()}:b`, payload: { incidentId, upAt } });
      return;
    }
    const [site] = await tx.select().from(sites).where(eq(sites.id, inc.siteId));
    const downtime = Math.round((inc.restoredAt!.getTime() - inc.outageStartedAt.getTime()) / 1000);
    await setPhase(tx, inc, "awaiting_rfo", {
      restorationConfirmedAt: now, downtimeSeconds: downtime,
      rfoStatus: site.rfoRequired ? "awaiting" : "waived",
      rfoWaiverReason: site.rfoRequired ? null : "Site policy: RFO not required",
    }, "Link stable for the restoration period");
    await stopSchedule(tx, inc.id, "Link restored");
    await cancelUnsentCommunications(tx, inc.id, ["initial", "cause", "technical", "periodic"], "Link restored before this update was sent");
    await addTimeline(tx, inc.id, "monitoring", `Link stable — restored at ${fmtTime(inc.restoredAt)} after ${fmtDuration(downtime)}`);
    if (site.rfoRequired) {
      await createCommunications(tx, { incidentId: inc.id, requestedKind: "restored_awaiting_rfo", purpose: "restoration", idempotencyBase: `restored:${inc.id}` });
    } else {
      await createCommunications(tx, { incidentId: inc.id, requestedKind: "final_no_rfo", purpose: "final", idempotencyBase: `final:${inc.id}` });
    }
  });
}

/** Pick the no-update wording that matches the last VERIFIED state. */
export async function periodicKind(tx: Tx, inc: Incident): Promise<string> {
  const ts = (inc.techState ?? {}) as TechState;
  if (inc.causeKey) {
    const [c] = await tx.select().from(causeOptions).where(eq(causeOptions.key, inc.causeKey));
    if (c?.category === "power_area") return c.periodicKind || "power_still_unavailable";
    if (c && c.periodicKind && c.periodicKind !== "no_update" && !(ts.faultType || ts.technicians || ts.repairStatus || ts.eta)) return c.periodicKind;
  }
  const hasVerifiedFacts = !!(ts.faultType || ts.technicians || ts.repairStatus || ts.eta || ts.etaUnavailable);
  if (inc.technicalAssigned && !hasVerifiedFacts) return "awaiting_backhaul";
  return "no_update";
}

/** Group lead = earliest open incident in the group; only it sends the combined ISP message. */
async function ispModeFor(tx: Tx, inc: Incident): Promise<"self" | "group" | "skip"> {
  if (!inc.groupId) return "self";
  const [lead] = await tx.select({ id: incidents.id }).from(incidents)
    .where(and(eq(incidents.groupId, inc.groupId), inArray(incidents.phase, [...OPEN]))).orderBy(incidents.outageStartedAt, incidents.reference).limit(1);
  return lead?.id === inc.id ? "group" : "skip";
}

export async function runPeriodicUpdate(db: DB, incidentId: string, dueAt: string) {
  await db.transaction(async (tx) => {
    const [pre] = await tx.select().from(incidents).where(eq(incidents.id, incidentId));
    if (!pre) return;
    await lockSite(tx, pre.siteId);
    const [inc] = await tx.select().from(incidents).where(eq(incidents.id, incidentId));
    const [sched] = await tx.select().from(communicationSchedules).where(eq(communicationSchedules.incidentId, incidentId));
    if (!sched?.active || sched.nextDueAt?.toISOString() !== dueAt) return; // superseded by a newer schedule
    const now = clock.now();
    if (inc.phase === "restoring") {
      const s = await getSettings(tx);
      await deferScheduleTo(tx, inc.id, addMinutes(now, s.restorationStabilityMinutes + 1));
      return;
    }
    if (inc.phase !== "active") { await stopSchedule(tx, inc.id, `Incident ${inc.phase}`); return; }
    const kind = await periodicKind(tx, inc);
    await createCommunications(tx, { incidentId: inc.id, requestedKind: kind, purpose: "periodic", idempotencyBase: `periodic:${inc.id}:${dueAt}`, isp: await ispModeFor(tx, inc) });
    await scheduleNextUpdate(tx, inc.id, now);
  });
}

// ───────────────────────────── Correlation ─────────────────────────────

export async function suggestCorrelation(tx: Tx, incidentId: string) {
  const s = await getSettings(tx);
  const [inc] = await tx.select({ i: incidents, site: sites }).from(incidents).innerJoin(sites, eq(sites.id, incidents.siteId)).where(eq(incidents.id, incidentId));
  const others = await tx.select({ i: incidents, site: sites }).from(incidents).innerJoin(sites, eq(sites.id, incidents.siteId)).where(and(
    inArray(incidents.phase, ["validating", "active"]), ne(incidents.id, incidentId),
    gte(incidents.outageStartedAt, addMinutes(inc.i.outageStartedAt, -s.correlationWindowMinutes)),
    lte(incidents.outageStartedAt, addMinutes(inc.i.outageStartedAt, s.correlationWindowMinutes))));
  const upstream = others.filter((o) => inc.site.upstreamRef && o.site.upstreamRef === inc.site.upstreamRef);
  const circuit = others.filter((o) => inc.site.circuitRef && o.site.circuitRef === inc.site.circuitRef);
  const provider = others.filter((o) => inc.site.backhaulProviderId && o.site.backhaulProviderId === inc.site.backhaulProviderId);
  let members: typeof others = [], reason = "";
  if (upstream.length) { members = upstream; reason = `Same upstream point (${inc.site.upstreamRef})`; }
  else if (circuit.length) { members = circuit; reason = `Same circuit (${inc.site.circuitRef})`; }
  else if (provider.length >= 2) { members = provider; reason = "Same backhaul provider, 3+ sites down within minutes"; }
  if (!members.length) return;
  const ids = [incidentId, ...members.map((m) => m.i.id)].sort();
  const [existing] = await tx.select().from(correlationSuggestions).where(and(eq(correlationSuggestions.status, "open"), sql`${correlationSuggestions.incidentIds} && ARRAY[${sql.join(ids.map((i) => sql`${i}`), sql`, `)}]::uuid[]`));
  if (existing) {
    const merged = [...new Set([...existing.incidentIds, ...ids])].sort();
    await tx.update(correlationSuggestions).set({ incidentIds: merged }).where(eq(correlationSuggestions.id, existing.id));
  } else {
    await tx.insert(correlationSuggestions).values({ incidentIds: ids, reason, createdAt: clock.now() });
  }
  for (const id of ids) await addTimeline(tx, id, "system", `Possible common cause with ${ids.length - 1} other outage(s): ${reason}`);
  void isNotNull;
}
