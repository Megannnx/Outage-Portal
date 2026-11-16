import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "../db/client";
import { settings } from "../db/schema";

/** Every operational knob, with safe defaults. Stored in `settings`, edited by administrators. */
export const SettingsSchema = z.object({
  validationMinutes: z.number().int().min(1).max(30).default(3),
  updateIntervalMinutes: z.number().int().min(15).max(480).default(120),
  /** Restart the 2-hour clock after an immediate technical update. */
  resetIntervalOnImmediate: z.boolean().default(true),
  restorationStabilityMinutes: z.number().int().min(0).max(60).default(5),
  /** A new outage within this window after restoration is linked to the previous incident. */
  relatedIncidentWindowMinutes: z.number().int().min(0).max(1440).default(120),
  correlationWindowMinutes: z.number().int().min(1).max(60).default(10),
  /** Delivery retry backoff (minutes). After the last step the delivery is failed and alerted. */
  deliveryRetryMinutes: z.array(z.number().int().min(1)).default([1, 3, 10, 30, 60]),
  businessHoursStart: z.number().int().min(0).max(23).default(7),
  businessHoursEnd: z.number().int().min(1).max(24).default(18),
  supportContact: z.string().default("ATEC Support: support@atec.co.za"),
  /** Hard bounces before a recipient is marked invalid. */
  bounceInvalidThreshold: z.number().int().min(1).max(10).default(2),
  /** Minimum extraction confidence for a fact to be pre-ticked. */
  extractionConfidence: z.number().min(0).max(1).default(0.8),
  /** NetXMS event names. */
  downEvents: z.array(z.string()).default(["SYS_NODE_DOWN", "SYS_NODE_UNREACHABLE", "SYS_IF_DOWN"]),
  upEvents: z.array(z.string()).default(["SYS_NODE_UP", "SYS_IF_UP"]),
  monitoringSilenceAlertMinutes: z.number().int().min(5).max(1440).default(60),
  /** Telegram backup parser: regexes with named groups `object` and `state` (down|up words). */
  telegramPatterns: z.array(z.string()).default([
    "(?<object>[A-Z0-9][\\w .\\-/]+?)\\s+(?:is|went|changed to)\\s+(?<state>down|up|unreachable|offline|online)",
  ]),
});
export type Settings = z.infer<typeof SettingsSchema>;

export async function getSettings(db: Tx): Promise<Settings> {
  const rows = await db.select().from(settings);
  const merged: Record<string, unknown> = {};
  for (const r of rows) merged[r.key] = r.value;
  return SettingsSchema.parse(merged);
}

export async function updateSettings(db: Tx, patch: Partial<Settings>, userId: string | null) {
  const current = await getSettings(db);
  const next = SettingsSchema.parse({ ...current, ...patch });
  for (const [k, v] of Object.entries(patch)) {
    await db.insert(settings).values({ key: k, value: (next as any)[k], updatedBy: userId ?? undefined })
      .onConflictDoUpdate({ target: settings.key, set: { value: (next as any)[k], updatedBy: userId ?? undefined, updatedAt: new Date() } });
  }
  void eq;
  return next;
}
