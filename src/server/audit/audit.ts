import { desc, sql } from "drizzle-orm";
import type { Tx } from "../db/client";
import { auditLogs } from "../db/schema";
import { sha256 } from "../lib/crypto";
import { clock } from "../lib/clock";

export interface Actor { id: string | null; label: string; ip?: string | null }
export const SYSTEM: Actor = { id: null, label: "System" };

/**
 * Append to the hash-chained audit log. Serialised with an advisory lock so the
 * chain stays linear under concurrent writers.
 */
export async function audit(db: Tx, actor: Actor, action: string, entityType: string, entityId: string, before?: unknown, after?: unknown) {
  await db.execute(sql`select pg_advisory_xact_lock(7210001)`);
  const [prev] = await db.select({ hash: auditLogs.hash }).from(auditLogs).orderBy(desc(auditLogs.id)).limit(1);
  const prevHash = prev?.hash ?? "genesis";
  const at = clock.now();
  const payload = JSON.stringify({ at: at.toISOString(), actor: actor.id, action, entityType, entityId, before: before ?? null, after: after ?? null });
  await db.insert(auditLogs).values({
    at, actorId: actor.id, actorLabel: actor.label, action, entityType, entityId,
    before: (before ?? null) as any, after: (after ?? null) as any, ip: actor.ip ?? null,
    prevHash, hash: sha256(prevHash + payload),
  });
}
