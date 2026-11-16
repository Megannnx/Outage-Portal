import { and, eq, ne } from "drizzle-orm";
import type { Tx } from "../db/client";
import { causeOptions, incidentTransitions, incidents, technicianDispatches } from "../db/schema";
import { clock } from "../lib/clock";

type Incident = typeof incidents.$inferSelect;
type Phase = Incident["phase"];
type Status = Incident["status"];

/**
 * Incident state machine (phase drives automation, status is what people see).
 *
 *   ┌────────────┐ down ≥3 min ┌────────┐  up event  ┌───────────┐ stable  ┌──────────────┐ RFO sent ┌──────────┐
 *   │ validating │────────────▶│ active │───────────▶│ restoring │────────▶│ awaiting_rfo │─────────▶│ resolved │
 *   └────────────┘             └────────┘◀───────────└───────────┘         └──────────────┘          └──────────┘
 *        │ up < 3 min                       down again (flap)                   │ admin waiver ──────────▲
 *        ▼
 *   ┌──────────────┐
 *   │ interruption │  (internal only; no external comms)
 *   └──────────────┘
 */
export const ALLOWED: Record<Phase, Phase[]> = {
  validating: ["active", "interruption", "awaiting_rfo"], // awaiting_rfo: outage ended before validation could run (retrospective)
  active: ["restoring"],
  restoring: ["active", "awaiting_rfo", "resolved"],
  awaiting_rfo: ["resolved"],
  resolved: [],
  interruption: [],
};

export function assertTransition(from: Phase, to: Phase) {
  if (from !== to && !ALLOWED[from].includes(to)) throw new Error(`Illegal incident transition ${from} → ${to}`);
}

export async function deriveStatus(db: Tx, inc: Pick<Incident, "id" | "phase" | "causeKey" | "technicalAssigned" | "techState">): Promise<Status> {
  switch (inc.phase) {
    case "validating": return "validating";
    case "restoring": return "restoring";
    case "awaiting_rfo": return "restored_awaiting_rfo";
    case "resolved": return "resolved";
    case "interruption": return "interruption";
  }
  if (!inc.causeKey) return "awaiting_cause";
  const [cause] = await db.select().from(causeOptions).where(eq(causeOptions.key, inc.causeKey));
  if (cause?.requiresDispatch) {
    const ds = await db.select().from(technicianDispatches)
      .where(and(eq(technicianDispatches.incidentId, inc.id), ne(technicianDispatches.status, "cancelled")));
    if (ds.some((d) => ["acknowledged", "on_site"].includes(d.status))) return "technician_investigating";
    return "technician_required";
  }
  if (cause?.category === "power_area") return "power_area";
  const ts = (inc.techState ?? {}) as { technicians?: string };
  if (ts.technicians === "dispatched" || ts.technicians === "on_site") return "technician_investigating";
  if (inc.technicalAssigned) return "awaiting_backhaul";
  return "under_investigation";
}

export async function recordTransition(db: Tx, before: Pick<Incident, "id" | "phase" | "status">, toPhase: Phase, toStatus: Status, reason: string, actorId: string | null = null) {
  if (before.phase === toPhase && before.status === toStatus) return;
  await db.insert(incidentTransitions).values({
    incidentId: before.id, fromPhase: before.phase, toPhase, fromStatus: before.status, toStatus, reason, actorId, at: clock.now(),
  });
}

/** Re-derive and persist the display status after any fact changes. */
export async function refreshStatus(db: Tx, incidentId: string, reason: string, actorId: string | null = null) {
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  const status = await deriveStatus(db, inc);
  if (status !== inc.status) {
    await db.update(incidents).set({ status, updatedAt: clock.now() }).where(eq(incidents.id, incidentId));
    await recordTransition(db, inc, inc.phase, status, reason, actorId);
  }
  return status;
}
