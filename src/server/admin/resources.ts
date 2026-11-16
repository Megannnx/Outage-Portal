/**
 * Administrator-managed configuration, exposed through one validated, audited CRUD layer.
 * Every change is written to the hash-chained audit log with before/after values
 * (this is also the contact-update history for recipients).
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../db/client";
import * as s from "../db/schema";
import { audit, type Actor } from "../audit/audit";
import { badRequest, conflict, notFound } from "../lib/errors";
import { hashPassword } from "../auth/session";
import { TRIGGERS } from "../escalations/engine";
import { KIND_MAP } from "../domain/catalog";
import { assertNoPrivateTerms } from "../comms/privacy";

const kindRef = z.string().refine((k) => KIND_MAP.has(k) || /^custom_[a-z0-9_]{3,40}$/.test(k), "Unknown template kind");
const uuid = z.string().uuid();
const opt = <T extends z.ZodTypeAny>(t: T) => t.optional().nullable();

interface Resource {
  table: any; schema: z.ZodObject<any>; order?: any; idCol?: string; softDelete?: boolean; label: (r: any) => string;
  beforeWrite?: (db: DB, input: any, existing?: any) => Promise<any>;
  list?: (db: DB) => Promise<unknown[]>;
}

export const RESOURCES: Record<string, Resource> = {
  sites: {
    table: s.sites, order: asc(s.sites.name), softDelete: true, label: (r) => `${r.code} ${r.name}`,
    schema: z.object({
      code: z.string().trim().min(2).max(16).regex(/^[A-Z0-9_-]+$/, "Upper-case letters, digits, - or _"), name: z.string().trim().min(2).max(100),
      estate: z.string().max(100).default(""), region: z.string().max(100).default(""), address: z.string().max(300).default(""),
      latitude: opt(z.number().min(-90).max(90)), longitude: opt(z.number().min(-180).max(180)), backhaulProviderId: opt(uuid),
      circuitRef: z.string().max(100).default(""), upstreamRef: z.string().max(100).default(""), technicalTeam: z.string().max(60).default("NOC"),
      residentListRef: z.string().max(200).default(""), rfoRequired: z.boolean().default(true), active: z.boolean().default(true), notes: z.string().max(2000).default(""),
    }),
  },
  identifiers: {
    table: s.siteMonitoringIdentifiers, label: (r) => `${r.matchType}=${r.value}`,
    schema: z.object({ siteId: uuid, source: z.enum(["netxms", "telegram", "any"]).or(z.string().regex(/^[a-z0-9_-]{2,32}$/)), matchType: z.enum(["object_id", "ip", "name_exact", "name_prefix"]), value: z.string().trim().min(1).max(200), critical: z.boolean().default(true), label: z.string().max(100).default("") }),
  },
  providers: {
    table: s.backhaulProviders, order: asc(s.backhaulProviders.name), softDelete: true, label: (r) => r.name,
    schema: z.object({ name: z.string().trim().min(2).max(100), publicName: z.string().trim().min(2).max(100), aliases: z.array(z.string().trim().min(2).max(60)).max(20).default([]), supportEmail: opt(z.string().email()), supportPhone: opt(z.string().max(40)), slaRestoreMinutes: opt(z.number().int().min(1).max(100000)), active: z.boolean().default(true) }),
  },
  isps: {
    table: s.isps, order: asc(s.isps.name), softDelete: true, label: (r) => r.name,
    schema: z.object({ name: z.string().trim().min(2).max(100), active: z.boolean().default(true) }),
  },
  "site-isps": {
    table: s.siteIsps, label: (r) => `${r.siteId}↔${r.ispId}`, idCol: "composite",
    schema: z.object({ siteId: uuid, ispId: uuid }),
  },
  recipients: {
    table: s.recipients, order: asc(s.recipients.email), label: (r) => r.email,
    schema: z.object({
      audience: z.enum(["isp", "resident", "internal"]), ispId: opt(uuid), siteId: opt(uuid), team: opt(z.string().max(60)),
      name: z.string().max(100).default(""), email: z.string().trim().toLowerCase().email().max(254),
      status: z.enum(["active", "suppressed", "invalid"]).default("active"), statusReason: opt(z.string().max(300)),
    }),
    beforeWrite: async (_db, input, existing) => {
      const v = { ...existing, ...input };
      if (v.audience === "isp" && !v.ispId) throw badRequest("ISP contacts must be linked to an ISP");
      if (v.audience === "resident" && !v.siteId) throw badRequest("Resident contacts must be linked to a site");
      if (v.audience === "internal" && !v.team) throw badRequest("Internal contacts need a team");
      if (input.status === "active" && existing?.status !== "active") return { ...input, bounceCount: 0, statusReason: null };
      return { ...input, updatedAt: new Date() };
    },
  },
  causes: {
    table: s.causeOptions, order: asc(s.causeOptions.sort), idCol: "key", softDelete: true, label: (r) => r.label,
    schema: z.object({ key: z.string().regex(/^[a-z0-9_]{3,40}$/), label: z.string().min(2).max(80), publicDescription: z.string().min(3).max(200), category: z.enum(["power_area", "power_server_room", "power_ok", "other"]), templateKind: kindRef, requiresDispatch: z.boolean().default(false), assignsTechnical: z.boolean().default(false), periodicKind: kindRef.default("no_update"), sort: z.number().int().default(100), active: z.boolean().default(true) }),
  },
  faults: {
    table: s.faultTypes, idCol: "key", softDelete: true, label: (r) => r.label,
    schema: z.object({ key: z.string().regex(/^[a-z0-9_]{3,40}$/), label: z.string().min(2).max(80), publicDescription: z.string().min(3).max(200), templateKind: kindRef, keywords: z.array(z.string().trim().min(3).max(60)).max(50).default([]), active: z.boolean().default(true) }),
  },
  "escalation-rules": {
    table: s.escalationRules, label: (r) => `${r.trigger} L${r.level}`, softDelete: true,
    schema: z.object({ trigger: z.enum(Object.keys(TRIGGERS) as [string, ...string[]]), level: z.number().int().min(1).max(5), afterMinutes: z.number().int().min(0).max(100000), notifyRoles: z.array(z.enum(["service_desk", "technical", "admin"])).default([]), notifyEmails: z.array(z.string().email()).max(20).default([]), notifyTeam: z.boolean().default(false), window: z.enum(["always", "business_hours", "after_hours"]).default("always"), active: z.boolean().default(true), description: z.string().max(200).default("") }),
  },
  users: {
    table: s.users, order: asc(s.users.name), softDelete: true, label: (r) => r.email,
    schema: z.object({ email: z.string().trim().toLowerCase().email(), name: z.string().trim().min(2).max(100), role: z.enum(["service_desk", "technical", "admin"]), active: z.boolean().default(true), password: z.string().min(12).max(200).optional(), resetMfa: z.boolean().optional() }),
    list: async (db) => (await db.select().from(s.users).orderBy(asc(s.users.name))).map(({ passwordHash, mfaSecretEnc, ...u }) => { void passwordHash; void mfaSecretEnc; return u; }),
    beforeWrite: async (db, input, existing) => {
      const out: any = { ...input };
      delete out.password; delete out.resetMfa;
      if (input.password) out.passwordHash = await hashPassword(input.password);
      else if (!existing) throw badRequest("Set an initial password (at least 12 characters)");
      if (input.resetMfa) { out.mfaEnabled = false; out.mfaSecretEnc = null; }
      if (existing?.role === "admin" && (input.role && input.role !== "admin" || input.active === false)) {
        const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(s.users).where(and(eq(s.users.role, "admin"), eq(s.users.active, true)));
        if (n <= 1) throw badRequest("You cannot remove the last active administrator");
      }
      return out;
    },
  },
};

const redact = (r: any) => (r && typeof r === "object" ? (({ passwordHash, mfaSecretEnc, ...rest }) => { void passwordHash; void mfaSecretEnc; return rest; })(r) : r);

export async function listResource(db: DB, name: string) {
  const r = RESOURCES[name];
  if (!r) throw notFound("Unknown resource");
  if (r.list) return r.list(db);
  const q = db.select().from(r.table);
  return r.order ? q.orderBy(r.order) : q;
}

export async function createResource(db: DB, actor: Actor, name: string, body: unknown) {
  const r = RESOURCES[name];
  if (!r) throw notFound("Unknown resource");
  let input = r.schema.parse(body);
  if (typeof (input as any).publicDescription === "string") await assertNoPrivateTerms(db, (input as any).publicDescription, "The client wording");
  if (r.beforeWrite) input = await r.beforeWrite(db, input);
  try {
    const [row] = (await db.insert(r.table).values(input).returning()) as any[];
    await audit(db, actor, `${name}.created`, name, String(row.id ?? row.key ?? r.label(row)), null, redact(row));
    return redact(row);
  } catch (e: any) {
    if (e?.cause?.code === "23505" || e?.code === "23505") throw conflict(`That ${name.replace(/s$/, "")} already exists`);
    if (e?.cause?.code === "23503" || e?.code === "23503") throw badRequest("A linked record does not exist");
    throw e;
  }
}

function idWhere(r: Resource, id: string) {
  if (r.idCol === "key") return eq(r.table.key, id);
  if (r.idCol === "composite") { const [a, b] = id.split(":"); return and(eq(r.table.siteId, a), eq(r.table.ispId, b)); }
  return eq(r.table.id, id);
}

export async function updateResource(db: DB, actor: Actor, name: string, id: string, body: unknown) {
  const r = RESOURCES[name];
  if (!r) throw notFound("Unknown resource");
  const [existing] = await db.select().from(r.table).where(idWhere(r, id));
  if (!existing) throw notFound();
  let input: any = r.schema.partial().parse(body);
  for (const k of Object.keys(input)) if (input[k] === undefined) delete input[k];
  if (r.idCol === "key") delete input.key; // keys are referenced by history
  if (typeof input.publicDescription === "string") await assertNoPrivateTerms(db, input.publicDescription, "The client wording");
  if (r.beforeWrite) input = await r.beforeWrite(db, input, existing);
  const [row] = (await db.update(r.table).set(input).where(idWhere(r, id)).returning()) as any[];
  await audit(db, actor, `${name}.updated`, name, id, redact(existing), redact(row));
  return redact(row);
}

export async function deleteResource(db: DB, actor: Actor, name: string, id: string) {
  const r = RESOURCES[name];
  if (!r) throw notFound("Unknown resource");
  const [existing] = await db.select().from(r.table).where(idWhere(r, id));
  if (!existing) throw notFound();
  if (r.softDelete) {
    if (name === "users") return updateResource(db, actor, name, id, { active: false });
    await db.update(r.table).set({ active: false }).where(idWhere(r, id));
  } else {
    await db.delete(r.table).where(idWhere(r, id));
  }
  await audit(db, actor, `${name}.${r.softDelete ? "deactivated" : "deleted"}`, name, id, redact(existing), null);
  return { ok: true };
}
