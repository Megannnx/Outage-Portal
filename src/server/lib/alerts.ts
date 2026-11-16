import { and, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "../db/client";
import { alerts, integrationHealth } from "../db/schema";
import { clock } from "./clock";

/** Raise (or keep open) a system alert. One open alert per key. */
export async function raiseAlert(db: Tx, key: string, severity: "info" | "warning" | "critical", message: string, incidentId?: string | null) {
  await db.execute(sql`
    insert into system_alerts (key, severity, message, incident_id, raised_at)
    values (${key}, ${severity}, ${message}, ${incidentId ?? null}, ${clock.now().toISOString()})
    on conflict (key) where resolved_at is null do update set message = excluded.message, severity = excluded.severity`);
}

export async function resolveAlert(db: Tx, key: string) {
  await db.update(alerts).set({ resolvedAt: clock.now() }).where(and(eq(alerts.key, key), isNull(alerts.resolvedAt)));
}

export async function healthOk(db: Tx, key: string, label: string, meta?: Record<string, unknown>) {
  const now = clock.now();
  await db.insert(integrationHealth).values({ key, label, lastSuccessAt: now, consecutiveErrors: 0, meta: meta ?? {} })
    .onConflictDoUpdate({ target: integrationHealth.key, set: { lastSuccessAt: now, consecutiveErrors: 0, ...(meta ? { meta } : {}) } });
}

export async function healthError(db: Tx, key: string, label: string, error: string) {
  const now = clock.now();
  await db.insert(integrationHealth).values({ key, label, lastErrorAt: now, lastError: error.slice(0, 1000), consecutiveErrors: 1 })
    .onConflictDoUpdate({
      target: integrationHealth.key,
      set: { lastErrorAt: now, lastError: error.slice(0, 1000), consecutiveErrors: sql`${integrationHealth.consecutiveErrors} + 1` },
    });
}
