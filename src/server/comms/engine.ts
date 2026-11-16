/**
 * Communication engine.
 *
 *   request (kind + purpose)  →  template selection (published only, with fallback chain)
 *                             →  strict render from VERIFIED incident data
 *                             →  communication row (idempotency key)  →  per-recipient deliveries
 *                             →  durable delivery job  →  adapters  →  status reconciliation
 *
 * Nothing here composes wording. The only text that leaves the system is an
 * administrator-approved template with placeholders filled from verified data.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DB, Tx } from "../db/client";
import {
  causeOptions, communicationDeliveries, communicationSchedules, communications, deliveryEvents,
  incidents, recipients, siteIsps, sites, templateVersions, communicationTemplates, isps,
} from "../db/schema";
import { clock, addMinutes } from "../lib/clock";
import { fmtCustomerTime, fmtDateTime, fmtDuration } from "../lib/time";
import { raiseAlert, resolveAlert, healthError, healthOk } from "../lib/alerts";
import { getSettings, type Settings } from "../domain/settings";
import { fallbackChain, kindDef, REPAIR_STATUS_WORDING, type TechState } from "../domain/catalog";
import { MissingValueError, render, toHtml, type Vars } from "./render";
import { enqueue, cancelJobs } from "../scheduler/jobs";
import { addTimeline } from "../incidents/timeline";
import { getAdapter, DeliveryError } from "./adapters";

export type Purpose = "initial" | "cause" | "technical" | "periodic" | "restoration" | "final";
const OUTAGE_PURPOSES: Purpose[] = ["initial", "cause", "technical", "periodic"];

type Incident = typeof incidents.$inferSelect;
type Site = typeof sites.$inferSelect;

export interface CommRequest {
  incidentId: string;
  requestedKind: string;
  purpose: Purpose;
  /** Stable key for this logical message; the audience is appended. Repeats are no-ops. */
  idempotencyBase: string;
  triggeredBy?: string | null;
  technicalUpdateId?: string | null;
  /** self: this site's ISPs · group: one message covering every site in the group · skip */
  isp?: "self" | "group" | "skip";
  residents?: boolean;
  extraVars?: Vars;
}

export interface CreatedComm { id: string; audience: string; kind: string; requestedKind: string; deliveries: number }

// ───────────────────────────── Variables ─────────────────────────────

export async function buildVars(db: Tx, inc: Incident, site: Site, settings: Settings, purpose: Purpose, extra: Vars = {}): Promise<Vars> {
  const now = clock.now();
  const ts = (inc.techState ?? {}) as TechState;
  let cause: string | undefined;
  if (inc.causeKey) {
    const [c] = await db.select().from(causeOptions).where(eq(causeOptions.key, inc.causeKey));
    cause = c?.publicDescription;
  }
  const eta = ts.eta && !ts.etaUnavailable && new Date(ts.eta) > now ? fmtCustomerTime(new Date(ts.eta), now) : undefined;
  let nextUpdate: string | undefined;
  if (OUTAGE_PURPOSES.includes(purpose)) {
    const resets = purpose !== "technical" || settings.resetIntervalOnImmediate;
    if (resets) nextUpdate = fmtCustomerTime(addMinutes(now, settings.updateIntervalMinutes), now);
    else {
      const [s] = await db.select().from(communicationSchedules).where(eq(communicationSchedules.incidentId, inc.id));
      nextUpdate = s?.nextDueAt ? fmtCustomerTime(s.nextDueAt, now) : undefined;
    }
  }
  return {
    site_name: site.name,
    estate_name: site.estate || site.name,
    incident_reference: inc.reference,
    outage_start_time: fmtDateTime(inc.outageStartedAt),
    confirmed_cause: cause,
    provider_name: ts.providerName ?? undefined,
    fault_description: ts.faultDescription ?? undefined,
    repair_status: ts.repairStatus ? REPAIR_STATUS_WORDING[ts.repairStatus] : undefined,
    eta,
    next_update_time: nextUpdate,
    support_contact: settings.supportContact,
    restored_time: inc.restoredAt ? fmtDateTime(inc.restoredAt) : undefined,
    downtime: inc.downtimeSeconds != null ? fmtDuration(inc.downtimeSeconds) : undefined,
    ...extra,
  };
}

// ───────────────────────────── Templates ─────────────────────────────

export async function publishedVersion(db: Tx, kind: string, audience: "resident" | "isp") {
  const rows = await db.select({ v: templateVersions, t: communicationTemplates })
    .from(templateVersions)
    .innerJoin(communicationTemplates, eq(communicationTemplates.id, templateVersions.templateId))
    .where(and(eq(communicationTemplates.kind, kind), inArray(communicationTemplates.audience, [audience, "all"]), eq(templateVersions.status, "published")));
  // Audience-specific wording beats the shared version.
  return rows.find((r) => r.t.audience === audience)?.v ?? rows.find((r) => r.t.audience === "all")?.v ?? null;
}

/** Walk the fallback chain until a published template renders with verified data only. */
export async function selectAndRender(db: Tx, requestedKind: string, audience: "resident" | "isp", vars: Vars) {
  const tried: string[] = [];
  for (const kind of fallbackChain(requestedKind)) {
    const v = await publishedVersion(db, kind, audience);
    if (!v) { tried.push(`${kind}: no published template`); continue; }
    try {
      return { kind, version: v, subject: render(v.subject, vars), body: render(v.body, vars), tried };
    } catch (e) {
      if (e instanceof MissingValueError) { tried.push(`${kind}: ${e.message}`); continue; }
      throw e;
    }
  }
  return { kind: null, version: null, subject: "", body: "", tried };
}

// ───────────────────────────── Recipients ─────────────────────────────

interface PlannedDelivery { channel: "client_api" | "smtp"; address: string; recipientId: string | null; ispId: string | null; suppressed: string | null }

async function plan(db: Tx, audience: "resident" | "isp", siteIds: string[]): Promise<PlannedDelivery[]> {
  const out: PlannedDelivery[] = [];
  if (audience === "resident") {
    const ss = await db.select().from(sites).where(inArray(sites.id, siteIds));
    for (const s of ss) if (s.residentListRef) out.push({ channel: "client_api", address: `list:${s.residentListRef}`, recipientId: null, ispId: null, suppressed: null });
    const direct = await db.select().from(recipients).where(and(eq(recipients.audience, "resident"), inArray(recipients.siteId, siteIds)));
    for (const r of direct) out.push({ channel: "smtp", address: r.email.toLowerCase(), recipientId: r.id, ispId: null, suppressed: r.status === "active" ? null : `Recipient ${r.status}${r.statusReason ? `: ${r.statusReason}` : ""}` });
  } else {
    const links = await db.select({ ispId: siteIsps.ispId }).from(siteIsps)
      .innerJoin(isps, eq(isps.id, siteIsps.ispId))
      .where(and(inArray(siteIsps.siteId, siteIds), eq(isps.active, true)));
    const ispIds = [...new Set(links.map((l) => l.ispId))];
    if (ispIds.length) {
      const rs = await db.select().from(recipients).where(and(eq(recipients.audience, "isp"), inArray(recipients.ispId, ispIds)));
      for (const r of rs) out.push({ channel: "smtp", address: r.email.toLowerCase(), recipientId: r.id, ispId: r.ispId, suppressed: r.status === "active" ? null : `Recipient ${r.status}${r.statusReason ? `: ${r.statusReason}` : ""}` });
    }
  }
  // An address linked to several affected ISPs/sites receives ONE copy.
  const seen = new Set<string>();
  return out.filter((d) => { const k = `${d.channel}|${d.address}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ───────────────────────────── Create ─────────────────────────────

export async function createCommunications(db: Tx, req: CommRequest): Promise<CreatedComm[]> {
  const settings = await getSettings(db);
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, req.incidentId));
  if (!inc) throw new Error(`Incident ${req.incidentId} not found`);
  const [site] = await db.select().from(sites).where(eq(sites.id, inc.siteId));
  const created: CreatedComm[] = [];

  const audiences: { aud: "resident" | "isp"; siteIds: string[]; extra: Vars; groupId: string | null }[] = [];
  if (req.residents !== false) audiences.push({ aud: "resident", siteIds: [site.id], extra: {}, groupId: null });
  const ispMode = req.isp ?? "self";
  if (ispMode === "self") audiences.push({ aud: "isp", siteIds: [site.id], extra: {}, groupId: null });
  if (ispMode === "group" && inc.groupId) {
    const members = await db.select({ siteId: incidents.siteId, name: sites.name }).from(incidents)
      .innerJoin(sites, eq(sites.id, incidents.siteId))
      .where(and(eq(incidents.groupId, inc.groupId), inArray(incidents.phase, ["validating", "active", "restoring"])));
    const ids = [...new Set([site.id, ...members.map((m) => m.siteId)])];
    const names = [...new Set([site.name, ...members.map((m) => m.name)])].sort();
    audiences.push({ aud: "isp", siteIds: ids, extra: { affected_sites: names.join(", ") }, groupId: inc.groupId });
  }

  for (const a of audiences) {
    const vars = await buildVars(db, inc, site, settings, req.purpose, { ...a.extra, ...req.extraVars });
    const sel = await selectAndRender(db, req.requestedKind, a.aud, vars);
    if (!sel.version || !sel.kind) {
      await raiseAlert(db, `template_missing:${req.requestedKind}:${a.aud}`, "critical",
        `No usable published template for "${req.requestedKind}" (${a.aud}). Tried: ${sel.tried.join("; ")}`, inc.id);
      await addTimeline(db, inc.id, "communication", `Could not send ${req.requestedKind} to ${a.aud === "isp" ? "ISPs" : "residents"}: no published template`, null, { tried: sel.tried });
      continue;
    }
    const key = `${req.idempotencyBase}:${a.aud}`;
    const [comm] = await db.insert(communications).values({
      incidentId: inc.id, groupId: a.groupId, kind: sel.kind, requestedKind: req.requestedKind, audience: a.aud,
      purpose: req.purpose, templateVersionId: sel.version.id, subject: sel.subject, body: sel.body,
      variables: vars as Record<string, unknown>, idempotencyKey: key, status: "queued",
      triggeredBy: req.triggeredBy ?? null, technicalUpdateId: req.technicalUpdateId ?? null, createdAt: clock.now(),
    }).onConflictDoNothing({ target: communications.idempotencyKey }).returning();
    if (!comm) continue; // already created by an earlier attempt — idempotent

    const planned = await plan(db, a.aud, a.siteIds);
    if (planned.length) {
      await db.insert(communicationDeliveries).values(planned.map((p) => ({
        communicationId: comm.id, recipientId: p.recipientId, ispId: p.ispId, channel: p.channel, address: p.address,
        status: (p.suppressed ? "suppressed" : "pending") as "suppressed" | "pending", error: p.suppressed,
      })));
    }
    const live = planned.filter((p) => !p.suppressed).length;
    if (!live) {
      await db.update(communications).set({ status: "no_recipients" }).where(eq(communications.id, comm.id));
      await raiseAlert(db, `no_recipients:${site.id}:${a.aud}`, "warning", `${site.name}: no active ${a.aud === "isp" ? "ISP contacts" : "resident distribution"} configured — "${sel.kind}" was not delivered`, inc.id);
    } else {
      await resolveAlert(db, `no_recipients:${site.id}:${a.aud}`);
      await enqueue(db, { kind: "deliver_communication", runAt: clock.now(), incidentId: inc.id, dedupeKey: `deliver:${comm.id}:0`, payload: { communicationId: comm.id } });
    }
    await addTimeline(db, inc.id, "communication",
      `${sel.kind === req.requestedKind ? "" : `"${kindDef(req.requestedKind).label}" not possible with verified data — `}Queued "${kindDef(sel.kind).label}" to ${a.aud === "isp" ? `ISPs (${live} contact${live === 1 ? "" : "s"})` : `residents (${live} channel${live === 1 ? "" : "s"})`}`,
      null, { communicationId: comm.id, templateVersionId: sel.version.id, tried: sel.tried });
    created.push({ id: comm.id, audience: a.aud, kind: sel.kind, requestedKind: req.requestedKind, deliveries: live });
  }
  return created;
}

/** Cancel queued outage messages that nobody has received yet (cause corrections, restoration). */
export async function cancelUnsentCommunications(db: Tx, incidentId: string, purposes: Purpose[], reason: string, exceptIds: string[] = []) {
  const rows = await db.select().from(communications).where(and(
    eq(communications.incidentId, incidentId), inArray(communications.purpose, purposes), inArray(communications.status, ["queued", "sending"])));
  for (const c of rows) {
    if (exceptIds.includes(c.id)) continue;
    const ds = await db.select().from(communicationDeliveries).where(eq(communicationDeliveries.communicationId, c.id));
    if (ds.some((d) => ["accepted", "delivered", "sending"].includes(d.status))) continue; // already partly out — let it finish
    await db.update(communicationDeliveries).set({ status: "cancelled", error: reason, updatedAt: clock.now() })
      .where(and(eq(communicationDeliveries.communicationId, c.id), inArray(communicationDeliveries.status, ["pending", "deferred"])));
    await db.update(communications).set({ status: "cancelled", cancelledReason: reason }).where(eq(communications.id, c.id));
    await addTimeline(db, incidentId, "communication", `Cancelled unsent "${c.kind}" to ${c.audience}: ${reason}`, null, { communicationId: c.id });
  }
}

// ───────────────────────────── Schedule ─────────────────────────────

/** Restart the 2-hour clock from `from` (the latest outage update). */
export async function scheduleNextUpdate(db: Tx, incidentId: string, from: Date) {
  const s = await getSettings(db);
  const due = addMinutes(from, s.updateIntervalMinutes);
  await db.insert(communicationSchedules).values({ incidentId, intervalMinutes: s.updateIntervalMinutes, lastOutageUpdateAt: from, nextDueAt: due, active: true, updatedAt: clock.now() })
    .onConflictDoUpdate({ target: communicationSchedules.incidentId, set: { intervalMinutes: s.updateIntervalMinutes, lastOutageUpdateAt: from, nextDueAt: due, active: true, stoppedReason: null, updatedAt: clock.now() } });
  await cancelJobs(db, incidentId, ["periodic_update"]);
  await enqueue(db, { kind: "periodic_update", runAt: due, incidentId, dedupeKey: `periodic:${incidentId}:${due.toISOString()}`, payload: { dueAt: due.toISOString() } });
  return due;
}

export async function deferScheduleTo(db: Tx, incidentId: string, due: Date) {
  await db.update(communicationSchedules).set({ nextDueAt: due, updatedAt: clock.now() }).where(eq(communicationSchedules.incidentId, incidentId));
  await cancelJobs(db, incidentId, ["periodic_update"]);
  await enqueue(db, { kind: "periodic_update", runAt: due, incidentId, dedupeKey: `periodic:${incidentId}:${due.toISOString()}`, payload: { dueAt: due.toISOString() } });
}

export async function stopSchedule(db: Tx, incidentId: string, reason: string) {
  await db.update(communicationSchedules).set({ active: false, nextDueAt: null, stoppedReason: reason, updatedAt: clock.now() }).where(eq(communicationSchedules.incidentId, incidentId));
  await cancelJobs(db, incidentId, ["periodic_update"]);
}

// ───────────────────────────── Deliver ─────────────────────────────

const LEASE_MS = 5 * 60_000;

/**
 * Job handler. Network calls happen OUTSIDE database transactions; each result
 * is committed on its own so a crash mid-batch never loses or repeats more
 * than the single in-flight message.
 */
export async function deliverCommunication(db: DB, communicationId: string): Promise<void> {
  const settings = await getSettings(db);
  const work = await db.transaction(async (tx) => {
    const [c] = await tx.select().from(communications).where(eq(communications.id, communicationId)).for("update");
    if (!c || ["sent", "failed", "partially_failed", "cancelled", "no_recipients"].includes(c.status)) return null;
    const [inc] = await tx.select().from(incidents).where(eq(incidents.id, c.incidentId));
    const ds = await tx.select().from(communicationDeliveries).where(eq(communicationDeliveries.communicationId, c.id));
    const anyOut = ds.some((d) => ["accepted", "delivered"].includes(d.status));
    // Never send a stale "still down" message once the link is confirmed restored.
    if (OUTAGE_PURPOSES.includes(c.purpose as Purpose) && ["awaiting_rfo", "resolved", "interruption"].includes(inc.phase) && !anyOut) {
      await tx.update(communicationDeliveries).set({ status: "cancelled", error: "Incident restored before send", updatedAt: clock.now() })
        .where(and(eq(communicationDeliveries.communicationId, c.id), inArray(communicationDeliveries.status, ["pending", "deferred", "sending"])));
      await tx.update(communications).set({ status: "cancelled", cancelledReason: "Link restored before this update was sent" }).where(eq(communications.id, c.id));
      await addTimeline(tx, inc.id, "communication", `Cancelled "${kindDef(c.kind).label}" to ${c.audience}: link restored before it was sent`);
      return null;
    }
    const now = clock.now();
    const due = ds.filter((d) => d.status === "pending" || d.status === "deferred" ||
      (d.status === "sending" && (!d.lastAttemptAt || now.getTime() - d.lastAttemptAt.getTime() > LEASE_MS)));
    if (due.length) {
      await tx.update(communicationDeliveries).set({ status: "sending", lastAttemptAt: now, attempts: sql`${communicationDeliveries.attempts} + 1`, updatedAt: now })
        .where(inArray(communicationDeliveries.id, due.map((d) => d.id)));
      await tx.update(communications).set({ status: "sending" }).where(eq(communications.id, c.id));
    }
    const [site] = await tx.select().from(sites).where(eq(sites.id, inc.siteId));
    return { c, inc, site, due: due.map((d) => ({ ...d, attempts: d.attempts + 1 })) };
  });
  if (!work) return;

  for (const d of work.due) {
    const adapter = getAdapter(d.channel as "client_api" | "smtp");
    const cfgErr = adapter.configError();
    let status: "accepted" | "delivered" | "deferred" | "failed";
    let providerId: string | null = null, error: string | null = null;
    if (cfgErr) {
      status = "failed"; error = `Not configured: ${cfgErr}`;
      await raiseAlert(db, `adapter_config:${d.channel}`, "critical", `${d.channel === "smtp" ? "SMTP" : "Client API"} is not configured (${cfgErr}). Outage communications cannot be delivered.`);
    } else {
      try {
        const r = await adapter.send({
          deliveryId: d.id, address: d.address, subject: work.c.subject, text: work.c.body, html: toHtml(work.c.body),
          meta: { incidentReference: work.inc.reference, siteCode: work.site.code, audience: work.c.audience, kind: work.c.kind },
        });
        status = r.status; providerId = r.providerMessageId ?? null;
        // Capture mode never reports an integration as healthy — it is not a live connection.
        if (!adapter.isCapture) await healthOk(db, `delivery:${d.channel}`, d.channel === "smtp" ? "SMTP relay" : "Client communications API");
      } catch (e) {
        const de = e instanceof DeliveryError ? e : new DeliveryError((e as Error).message, true);
        error = de.message;
        status = de.transient && d.attempts <= settings.deliveryRetryMinutes.length ? "deferred" : "failed";
        if (!adapter.isCapture) await healthError(db, `delivery:${d.channel}`, d.channel === "smtp" ? "SMTP relay" : "Client communications API", de.message);
      }
    }
    await db.transaction(async (tx) => {
      await tx.update(communicationDeliveries).set({ status, providerMessageId: providerId, error, updatedAt: clock.now() }).where(eq(communicationDeliveries.id, d.id));
      await tx.insert(deliveryEvents).values({ deliveryId: d.id, status, detail: error ?? providerId ?? "", at: clock.now() });
    });
  }

  await db.transaction(async (tx) => {
    const [c] = await tx.select().from(communications).where(eq(communications.id, communicationId)).for("update");
    const ds = await tx.select().from(communicationDeliveries).where(eq(communicationDeliveries.communicationId, c.id));
    const ok = ds.filter((d) => d.status === "accepted" || d.status === "delivered").length;
    const failed = ds.filter((d) => d.status === "failed" || d.status === "bounced").length;
    const deferred = ds.filter((d) => d.status === "deferred");
    const now = clock.now();
    if (deferred.length) {
      const attempt = Math.max(...deferred.map((d) => d.attempts));
      const wait = settings.deliveryRetryMinutes[Math.min(attempt - 1, settings.deliveryRetryMinutes.length - 1)];
      await enqueue(tx, { kind: "deliver_communication", runAt: addMinutes(now, wait), incidentId: c.incidentId, dedupeKey: `deliver:${c.id}:${attempt}`, payload: { communicationId: c.id } });
      await tx.update(communications).set({ status: "sending", sentAt: c.sentAt ?? (ok ? now : null) }).where(eq(communications.id, c.id));
      await raiseAlert(tx, `delivery_retry:${c.id}`, "warning", `${deferred.length} delivery(ies) for ${work.inc.reference} "${c.kind}" failed temporarily — retrying in ${wait} min`, c.incidentId);
      return;
    }
    await resolveAlert(tx, `delivery_retry:${c.id}`);
    const status = failed === 0 ? "sent" : ok === 0 ? "failed" : "partially_failed";
    await tx.update(communications).set({ status, sentAt: c.sentAt ?? (ok ? now : null) }).where(eq(communications.id, c.id));
    const label = c.audience === "isp" ? "ISPs" : "residents";
    await addTimeline(tx, c.incidentId, "delivery",
      status === "sent" ? `"${kindDef(c.kind).label}" to ${label}: ${ok} of ${ok} accepted for delivery` : `"${kindDef(c.kind).label}" to ${label}: ${ok} accepted, ${failed} failed`,
      null, { communicationId: c.id, status });
    if (failed) await raiseAlert(tx, `delivery_failed:${c.id}`, ok ? "warning" : "critical", `${work.inc.reference} "${c.kind}" to ${label}: ${failed} delivery(ies) failed`, c.incidentId);
    if (ok && c.purpose === "initial") {
      await tx.update(incidents).set({ firstCommAt: sql`coalesce(${incidents.firstCommAt}, ${now.toISOString()}::timestamptz)` }).where(eq(incidents.id, c.incidentId));
    }
    if (c.purpose === "final") await finaliseResolution(tx, c.incidentId);
  });
}

/** Close the incident once every final message has reached a terminal state with at least one accepted delivery. */
export async function finaliseResolution(tx: Tx, incidentId: string) {
  const [inc] = await tx.select().from(incidents).where(eq(incidents.id, incidentId)).for("update");
  if (!inc || inc.phase !== "awaiting_rfo" || !["sent", "waived"].includes(inc.rfoStatus)) return;
  const finals = await tx.select().from(communications).where(and(eq(communications.incidentId, incidentId), eq(communications.purpose, "final")));
  if (!finals.length || finals.some((f) => ["queued", "sending"].includes(f.status))) return;
  const anyOk = finals.some((f) => ["sent", "partially_failed", "no_recipients"].includes(f.status));
  if (!anyOk) {
    await raiseAlert(tx, `final_failed:${incidentId}`, "critical", `${inc.reference}: final communication failed for every recipient — incident left open`, incidentId);
    return;
  }
  const now = clock.now();
  await tx.update(incidents).set({ phase: "resolved", status: "resolved", resolvedAt: now, updatedAt: now, version: sql`${incidents.version} + 1` }).where(eq(incidents.id, incidentId));
  const { recordTransition } = await import("../incidents/transitions");
  await recordTransition(tx, inc, "resolved", "resolved", "Final communication delivered");
  await addTimeline(tx, incidentId, "system", "Incident resolved — final communication delivered");
}
