import type { Tx } from "../db/client";
import { timelineEntries } from "../db/schema";
import { clock } from "../lib/clock";
import type { Actor } from "../audit/audit";

export type TimelineKind = "monitoring" | "cause" | "technical" | "communication" | "dispatch" | "system" | "escalation" | "rfo" | "delivery";

export async function addTimeline(db: Tx, incidentId: string, kind: TimelineKind, summary: string, actor?: Actor | null, data: Record<string, unknown> = {}, at?: Date) {
  await db.insert(timelineEntries).values({
    incidentId, kind, summary, data,
    actorId: actor?.id ?? null, actorLabel: actor?.label ?? "System",
    at: at ?? clock.now(),
  });
}
