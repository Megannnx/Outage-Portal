/**
 * Internal notifications (Technical, supervisors, escalations).
 * Kept completely separate from customer communications: different code path,
 * different subject prefix, never uses customer templates or recipient lists.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { DB, Tx } from "../db/client";
import { recipients, technicianDispatches, users } from "../db/schema";
import { enqueue } from "../scheduler/jobs";
import { clock } from "../lib/clock";
import { getAdapter, DeliveryError } from "./adapters";
import { raiseAlert, resolveAlert } from "../lib/alerts";
import { sha256 } from "../lib/crypto";

export interface InternalMessage { to: string[]; subject: string; text: string; incidentId?: string | null; dispatchId?: string | null; key: string }

export async function queueInternal(db: Tx, m: InternalMessage) {
  const to = [...new Set(m.to.map((x) => x.trim().toLowerCase()).filter(Boolean))];
  if (!to.length) {
    await raiseAlert(db, `internal_no_recipients:${m.key}`, "warning", `Internal notification "${m.subject}" has no recipients configured`, m.incidentId);
    return;
  }
  await enqueue(db, {
    kind: "internal_notify", runAt: clock.now(), incidentId: m.incidentId ?? null, dedupeKey: `internal:${sha256(m.key)}`,
    payload: { ...m, to, subject: `[INTERNAL] ${m.subject}` }, maxAttempts: 6,
  });
}

/** Team mailboxes + users holding the given roles. */
export async function internalAddresses(db: Tx, opts: { team?: string | null; roles?: string[]; emails?: string[] }) {
  const out: string[] = [...(opts.emails ?? [])];
  if (opts.team) {
    const rs = await db.select().from(recipients).where(and(eq(recipients.audience, "internal"), eq(recipients.team, opts.team), eq(recipients.status, "active")));
    out.push(...rs.map((r) => r.email));
  }
  if (opts.roles?.length) {
    const us = await db.select().from(users).where(and(inArray(users.role, opts.roles as ("admin" | "technical" | "service_desk")[]), eq(users.active, true)));
    out.push(...us.map((u) => u.email));
  }
  return [...new Set(out.map((e) => e.toLowerCase()))];
}

export async function runInternalNotify(db: DB, payload: InternalMessage) {
  const adapter = getAdapter("smtp");
  const err = adapter.configError();
  if (err) {
    await raiseAlert(db, "adapter_config:smtp", "critical", `SMTP is not configured (${err}). Internal notifications cannot be sent.`);
    throw new DeliveryError(err, true);
  }
  for (const to of payload.to) {
    await adapter.send({
      deliveryId: sha256(`${payload.key}|${to}`).slice(0, 32), address: to, subject: payload.subject, text: payload.text,
      html: `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap">${payload.text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`,
      meta: { incidentReference: "", siteCode: "", audience: "internal", kind: "internal" },
    });
  }
  await resolveAlert(db, `internal_no_recipients:${payload.key}`);
  if (payload.dispatchId) {
    await db.update(technicianDispatches).set({ status: "sent", sentAt: clock.now() })
      .where(and(eq(technicianDispatches.id, payload.dispatchId), eq(technicianDispatches.status, "requested")));
  }
}
