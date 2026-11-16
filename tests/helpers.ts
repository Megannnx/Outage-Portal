import { sql, eq } from "drizzle-orm";
import { getDb, resetDbForTests, type DB } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { seedReferenceData } from "@/server/domain/seed-data";
import { clock } from "@/server/lib/clock";
import { processEvent } from "@/server/incidents/lifecycle";
import { fromNetxms } from "@/server/ingestion/normalize";
import { getSettings } from "@/server/domain/settings";
import { drain } from "@/server/scheduler/runner";
import { captured, captureControl } from "@/server/comms/adapters/capture";
import type { Actor } from "@/server/audit/audit";

process.env.DELIVERY_MODE = "capture";
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
delete process.env.ANTHROPIC_API_KEY;

export const T0 = new Date("2026-11-16T06:00:00.000Z"); // 08:00 SAST, Monday
let now = new Date(T0);
export const at = () => now;
export function setTime(d: Date) { now = new Date(d); }
export function advance(minutes: number) { now = new Date(now.getTime() + minutes * 60_000); }

export interface World {
  db: DB;
  admin: Actor; desk: Actor; tech: Actor;
  dfa: typeof s.backhaulProviders.$inferSelect;
  dwv: typeof s.sites.$inferSelect; hzd: typeof s.sites.$inferSelect; mdw: typeof s.sites.$inferSelect;
  ispA: string; ispB: string;
}

export async function setup(): Promise<World> {
  await resetDbForTests(process.env.TEST_DATABASE_URL ?? "postgres://portal:portal@localhost:5432/portal_test");
  const db = getDb();
  const tables = (await db.execute(sql`select tablename from pg_tables where schemaname='public'`)).rows.map((r: any) => `"${r.tablename}"`);
  await db.execute(sql.raw(`alter table audit_logs disable trigger audit_logs_no_update; alter table technical_updates disable trigger technical_updates_no_delete;`));
  await db.execute(sql.raw(`truncate ${tables.join(",")} restart identity cascade`));
  await db.execute(sql.raw(`alter table audit_logs enable trigger audit_logs_no_update; alter table technical_updates enable trigger technical_updates_no_delete;`));
  await db.execute(sql`alter sequence incident_reference_seq restart; alter sequence dispatch_reference_seq restart; alter sequence group_reference_seq restart`);
  now = new Date(T0);
  clock.set(() => now);
  captured.length = 0;
  captureControl.failNext = 0;

  await db.insert(s.roles).values([
    { key: "service_desk", name: "Service Desk" }, { key: "technical", name: "Technical" }, { key: "admin", name: "Admin", requiresMfa: true },
  ]).onConflictDoNothing();
  const mk = async (email: string, role: "admin" | "technical" | "service_desk", name: string) =>
    (await db.insert(s.users).values({ email, role, name, passwordHash: "x" }).returning())[0];
  const a = await mk("admin@atec.test", "admin", "Ada Admin");
  const d = await mk("desk@atec.test", "service_desk", "Dee Desk");
  const t = await mk("tech@atec.test", "technical", "Tom Tech");
  await seedReferenceData(db, { publishAs: a.id });

  const [dfa] = await db.insert(s.backhaulProviders).values({ name: "Dark Fibre Africa", publicName: "Dark Fibre Africa", aliases: ["DFA"] }).returning();
  const site = async (code: string, name: string, upstream: string, list: string) =>
    (await db.insert(s.sites).values({ code, name, estate: `${name} Estate`, backhaulProviderId: dfa.id, upstreamRef: upstream, circuitRef: `CCT-${code}`, residentListRef: list, technicalTeam: "NOC" }).returning())[0];
  const dwv = await site("DWV", "Dowerview", "POP-NORTH", "res-dwv");
  const hzd = await site("HZD", "Hazeldean", "POP-NORTH", "res-hzd");
  const mdw = await site("MDW", "Meadowbrook", "POP-SOUTH", "res-mdw");
  await db.insert(s.siteMonitoringIdentifiers).values([
    { siteId: dwv.id, source: "netxms", matchType: "object_id", value: "1001", label: "DWV L3GR10" },
    { siteId: dwv.id, source: "any", matchType: "name_exact", value: "DWV L2ACS24", critical: false, label: "Access switch" },
    { siteId: hzd.id, source: "netxms", matchType: "object_id", value: "2001" },
    { siteId: mdw.id, source: "netxms", matchType: "object_id", value: "3001" },
    { siteId: mdw.id, source: "netxms", matchType: "object_id", value: "3002" },
  ]);
  const [ia] = await db.insert(s.isps).values({ name: "ISP Alpha" }).returning();
  const [ib] = await db.insert(s.isps).values({ name: "ISP Bravo" }).returning();
  await db.insert(s.siteIsps).values([{ siteId: dwv.id, ispId: ia.id }, { siteId: dwv.id, ispId: ib.id }, { siteId: hzd.id, ispId: ia.id }, { siteId: mdw.id, ispId: ib.id }]);
  await db.insert(s.recipients).values([
    { audience: "isp", ispId: ia.id, email: "noc@alpha.test" }, { audience: "isp", ispId: ia.id, email: "ops@alpha.test" },
    { audience: "isp", ispId: ib.id, email: "noc@bravo.test" },
    { audience: "internal", team: "NOC", email: "noc-team@atec.test" },
  ]);
  return {
    db, dfa, dwv, hzd, mdw, ispA: ia.id, ispB: ib.id,
    admin: { id: a.id, label: a.name }, desk: { id: d.id, label: d.name }, tech: { id: t.id, label: t.name },
  };
}


export async function netxms(db: DB, event: string, objectId: string, when = now, extra: Record<string, unknown> = {}) {
  const st = await getSettings(db);
  return processEvent(db, fromNetxms({ event, object_id: objectId, object_name: `node-${objectId}`, timestamp: Math.floor(when.getTime() / 1000), ...extra }, st));
}
export const down = (db: DB, obj: string, when?: Date) => netxms(db, "SYS_NODE_DOWN", obj, when);
export const up = (db: DB, obj: string, when?: Date) => netxms(db, "SYS_NODE_UP", obj, when);

/** Advance the clock minute by minute, running due jobs each step (like a real worker). */
export async function run(db: DB, minutes: number) {
  for (let i = 0; i < minutes; i++) { advance(1); await drain(db); }
}
export async function tick(db: DB) { await drain(db); }

export async function incidentFor(db: DB, siteId: string) {
  const rows = await db.select().from(s.incidents).where(eq(s.incidents.siteId, siteId)).orderBy(s.incidents.createdAt);
  return rows[rows.length - 1];
}
export async function commsFor(db: DB, incidentId: string) {
  return db.select().from(s.communications).where(eq(s.communications.incidentId, incidentId)).orderBy(s.communications.createdAt);
}
export { captured, captureControl, s };
