import { asc } from "drizzle-orm";
import type { DB } from "../db/client";
import { auditLogs } from "../db/schema";
import { sha256, canonicalJson } from "../lib/crypto";

/** Recompute the hash chain to detect tampering (run from Admin › System health). */
export async function verifyAuditChain(db: DB, limit = 100000) {
  const rows = await db.select().from(auditLogs).orderBy(asc(auditLogs.id)).limit(limit);
  let prev = "genesis";
  for (const r of rows) {
    const payload = canonicalJson({ at: r.at.toISOString(), actor: r.actorId, action: r.action, entityType: r.entityType, entityId: r.entityId, before: r.before ?? null, after: r.after ?? null });
    if (r.prevHash !== prev || r.hash !== sha256(prev + payload)) return { ok: false, brokenAt: r.id, checked: rows.length };
    prev = r.hash;
  }
  return { ok: true, brokenAt: null, checked: rows.length };
}
