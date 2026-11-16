/**
 * Escalation sweep — evaluated every 30 s by exactly one worker (advisory lock).
 * Conditions are derived from incident state in the database, so the sweep is
 * idempotent: escalations are keyed (incident, rule, subject) and auto-resolve
 * when the condition clears. Customer communications never depend on this.
 */
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { DB, Tx } from "../db/client";
import {
  alerts, causeOptions, communicationDeliveries, communicationSchedules, communications, escalationRules, escalations,
  incidents, integrationHealth, sites, technicianDispatches,
} from "../db/schema";
import { clock, minutesBetween, addMinutes } from "../lib/clock";
import { getSettings } from "../domain/settings";
import { isBusinessHours, fmtDuration, fmtDateTime } from "../lib/time";
import { queueInternal, internalAddresses } from "../comms/internal";
import { raiseAlert, resolveAlert } from "../lib/alerts";
import { addTimeline } from "../incidents/timeline";
import type { TechState } from "../domain/catalog";

export const TRIGGERS = {
  cause_overdue: "Service Desk has not confirmed the cause",
  dispatch_not_created: "Server-room power confirmed but no technician dispatch logged",
  dispatch_unacknowledged: "Technician dispatch not acknowledged",
  technical_update_overdue: "No technical update received",
  eta_passed: "ETA has passed and the link is still down",
  rfo_overdue: "Link restored but RFO not received",
  communication_overdue: "Scheduled customer update is overdue (scheduler stalled?)",
  delivery_failed: "Customer communication failed to deliver",
} as const;
export type Trigger = keyof typeof TRIGGERS;

interface Condition { incidentId: string; subjectRef: string; since: Date; message: string; team: string }

async function conditions(tx: Tx, trigger: Trigger, now: Date): Promise<Condition[]> {
  const out: Condition[] = [];
  const open = await tx.select({ i: incidents, site: sites }).from(incidents).innerJoin(sites, eq(sites.id, incidents.siteId))
    .where(inArray(incidents.phase, ["active", "restoring", "awaiting_rfo"]));
  for (const { i, site } of open) {
    const base = `${i.reference} ${site.name}`;
    const ts = (i.techState ?? {}) as TechState;
    switch (trigger) {
      case "cause_overdue":
        if (i.phase === "active" && !i.causeKey && i.validatedAt) out.push({ incidentId: i.id, subjectRef: "", since: i.validatedAt, message: `${base}: cause not confirmed`, team: site.technicalTeam });
        break;
      case "dispatch_not_created": {
        if (i.phase !== "active" || !i.causeKey || !i.causeConfirmedAt) break;
        const [c] = await tx.select().from(causeOptions).where(eq(causeOptions.key, i.causeKey));
        if (!c?.requiresDispatch) break;
        const ds = await tx.select().from(technicianDispatches).where(and(eq(technicianDispatches.incidentId, i.id), sql`${technicianDispatches.status} <> 'cancelled'`));
        if (!ds.length) out.push({ incidentId: i.id, subjectRef: i.causeConfirmedAt.toISOString(), since: i.causeConfirmedAt, message: `${base}: ${c.label} — URGENT technician dispatch not yet logged`, team: site.technicalTeam });
        break;
      }
      case "dispatch_unacknowledged": {
        const ds = await tx.select().from(technicianDispatches).where(and(eq(technicianDispatches.incidentId, i.id), inArray(technicianDispatches.status, ["requested", "sent"])));
        for (const d of ds) out.push({ incidentId: i.id, subjectRef: d.id, since: d.requestedAt, message: `${base}: dispatch ${d.reference} not acknowledged`, team: d.team });
        break;
      }
      case "technical_update_overdue":
        if (i.phase === "active" && i.technicalAssigned) {
          const since = i.lastTechnicalUpdateAt ?? i.causeConfirmedAt ?? i.validatedAt ?? i.createdAt;
          out.push({ incidentId: i.id, subjectRef: since.toISOString(), since, message: `${base}: no technical update since ${fmtDateTime(since)}`, team: i.assignedTeam ?? site.technicalTeam });
        }
        break;
      case "eta_passed":
        if (i.phase === "active" && ts.eta && !ts.etaUnavailable && new Date(ts.eta) < now)
          out.push({ incidentId: i.id, subjectRef: ts.eta, since: new Date(ts.eta), message: `${base}: ETA ${fmtDateTime(ts.eta)} has passed — customers will no longer be quoted it; obtain a new ETA`, team: i.assignedTeam ?? site.technicalTeam });
        break;
      case "rfo_overdue":
        if (i.phase === "awaiting_rfo" && i.rfoStatus === "awaiting" && i.restorationConfirmedAt)
          out.push({ incidentId: i.id, subjectRef: "", since: i.restorationConfirmedAt, message: `${base}: RFO outstanding for ${fmtDuration((now.getTime() - i.restorationConfirmedAt.getTime()) / 1000)}`, team: i.assignedTeam ?? site.technicalTeam });
        break;
      case "communication_overdue": {
        const [s] = await tx.select().from(communicationSchedules).where(eq(communicationSchedules.incidentId, i.id));
        if (s?.active && s.nextDueAt && s.nextDueAt < now) out.push({ incidentId: i.id, subjectRef: s.nextDueAt.toISOString(), since: s.nextDueAt, message: `${base}: customer update due at ${fmtDateTime(s.nextDueAt)} has not gone out`, team: site.technicalTeam });
        break;
      }
      case "delivery_failed": {
        const failed = await tx.select({ c: communications }).from(communications)
          .where(and(eq(communications.incidentId, i.id), inArray(communications.status, ["failed", "partially_failed"])));
        for (const { c } of failed) out.push({ incidentId: i.id, subjectRef: c.id, since: c.createdAt, message: `${base}: "${c.kind}" to ${c.audience} ${c.status.replace("_", " ")}`, team: site.technicalTeam });
        break;
      }
    }
  }
  return out;
}

export async function runEscalationSweep(db: DB) {
  const now = clock.now();
  const settings = await getSettings(db);
  const rules = await db.select().from(escalationRules).where(eq(escalationRules.active, true));
  const byTrigger = new Map<string, typeof rules>();
  for (const r of rules) byTrigger.set(r.trigger, [...(byTrigger.get(r.trigger) ?? []), r].sort((a, b) => a.level - b.level));

  for (const trigger of Object.keys(TRIGGERS) as Trigger[]) {
    const tRules = byTrigger.get(trigger) ?? [];
    await db.transaction(async (tx) => {
      const conds = await conditions(tx, trigger, now);
      const live = new Set<string>();
      for (const c of conds) {
        for (const rule of tRules) {
          const key = `${c.incidentId}|${rule.id}|${c.subjectRef}`;
          if (minutesBetween(c.since, now) < rule.afterMinutes) continue;
          live.add(key);
          const bh = isBusinessHours(now, settings.businessHoursStart, settings.businessHoursEnd);
          if (rule.window === "business_hours" && !bh) continue;
          if (rule.window === "after_hours" && bh) continue;
          const [row] = await tx.insert(escalations).values({
            incidentId: c.incidentId, ruleId: rule.id, trigger, level: rule.level, subjectRef: c.subjectRef, raisedAt: now, message: c.message,
          }).onConflictDoNothing().returning();
          if (!row) continue; // already raised
          const to = await internalAddresses(tx, { roles: rule.notifyRoles, emails: rule.notifyEmails, team: rule.notifyTeam ? c.team : null });
          await queueInternal(tx, {
            key: `esc:${row.id}`, incidentId: c.incidentId, to,
            subject: `Escalation L${rule.level}: ${c.message}`,
            text: `${TRIGGERS[trigger]}.\n\n${c.message}\nOutstanding for ${fmtDuration((now.getTime() - c.since.getTime()) / 1000)} (threshold ${rule.afterMinutes} min).\n\nThis is an internal escalation. Customer communications continue automatically.`,
          });
          await tx.update(escalations).set({ notified: to }).where(eq(escalations.id, row.id));
          await addTimeline(tx, c.incidentId, "escalation", `Escalation L${rule.level}: ${TRIGGERS[trigger]} (${to.length} notified)`);
          const alertKey = trigger === "cause_overdue" ? `cause_overdue:${c.incidentId}` : trigger === "dispatch_unacknowledged" ? `dispatch_unack:${c.subjectRef}` :
            trigger === "rfo_overdue" ? `rfo_overdue:${c.incidentId}` : trigger === "technical_update_overdue" ? `tech_overdue:${c.incidentId}` : `esc:${trigger}:${c.incidentId}:${c.subjectRef}`;
          await raiseAlert(tx, alertKey, rule.level >= 2 ? "critical" : "warning", c.message, c.incidentId);
        }
      }
      // Auto-resolve escalations whose condition has cleared.
      const openEsc = await tx.select().from(escalations).where(and(eq(escalations.trigger, trigger), isNull(escalations.resolvedAt)));
      for (const e of openEsc) {
        if (!live.has(`${e.incidentId}|${e.ruleId}|${e.subjectRef}`)) await tx.update(escalations).set({ resolvedAt: now }).where(eq(escalations.id, e.id));
      }
    });
  }
}

/** Platform health: monitoring silence, stuck queues, dead jobs, bouncing ISPs. */
export async function runHealthSweep(db: DB) {
  const now = clock.now();
  const s = await getSettings(db);
  const [nx] = await db.select().from(integrationHealth).where(eq(integrationHealth.key, "monitoring:netxms"));
  if (nx?.lastSuccessAt && minutesBetween(nx.lastSuccessAt, now) > s.monitoringSilenceAlertMinutes)
    await raiseAlert(db, "monitoring_silent:netxms", "critical", `No events or heartbeats from NetXMS for ${Math.round(minutesBetween(nx.lastSuccessAt, now))} min — outages may not be detected`);
  else await resolveAlert(db, "monitoring_silent:netxms");

  const stuck = await db.execute(sql`select count(*)::int as n from jobs where status = 'pending' and run_at < ${addMinutes(now, -5).toISOString()}`);
  const n = (stuck.rows[0] as { n: number }).n;
  if (n > 0) await raiseAlert(db, "queue_backlog", "critical", `${n} scheduled job(s) are more than 5 minutes late — check the worker`);
  else await resolveAlert(db, "queue_backlog");

  const dead = await db.execute(sql`select count(*)::int as n from jobs where status = 'dead' and completed_at > ${addMinutes(now, -1440).toISOString()}`);
  const d = (dead.rows[0] as { n: number }).n;
  if (d > 0) await raiseAlert(db, "dead_jobs", "warning", `${d} job(s) failed permanently in the last 24h (dead-letter) — see Admin › System health`);
  else await resolveAlert(db, "dead_jobs");

  const pendingDeliveries = await db.select({ n: sql<number>`count(*)::int` }).from(communicationDeliveries)
    .where(and(inArray(communicationDeliveries.status, ["pending", "sending"]), lt(communicationDeliveries.updatedAt, addMinutes(now, -15))));
  if ((pendingDeliveries[0]?.n ?? 0) > 0) await raiseAlert(db, "delivery_stuck", "critical", `${pendingDeliveries[0].n} delivery(ies) stuck for over 15 minutes`);
  else await resolveAlert(db, "delivery_stuck");
  void alerts;
}
