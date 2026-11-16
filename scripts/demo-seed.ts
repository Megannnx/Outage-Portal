/**
 * DEMO ENVIRONMENT ONLY. Creates clearly-labelled demo sites, ISPs, users and
 * published templates, then plays a realistic morning of NetXMS events so every
 * screen has something to show. Refuses to run against a database with real incidents
 * unless DEMO_FORCE=true. Delivery must be in capture mode.
 */
import { sql } from "drizzle-orm";
import { getDb, getPool } from "../src/server/db/client";
import { runMigrations } from "../src/server/db/migrate";
import * as s from "../src/server/db/schema";
import { seedReferenceData } from "../src/server/domain/seed-data";
import { clock } from "../src/server/lib/clock";
import { processEvent } from "../src/server/incidents/lifecycle";
import { fromNetxms } from "../src/server/ingestion/normalize";
import { getSettings } from "../src/server/domain/settings";
import { drain } from "../src/server/scheduler/runner";
import { confirmCause, createDispatch, submitTechnicalUpdate, submitRfo } from "../src/server/incidents/actions";
import { runEscalationSweep } from "../src/server/escalations/engine";
import { healthOk } from "../src/server/lib/alerts";
import { hashPasswordRaw } from "./util";

async function main() {
  if (process.env.DELIVERY_MODE === "live") throw new Error("Refusing to seed demo data with DELIVERY_MODE=live");
  await runMigrations();
  const db = getDb();
  const [{ n }] = (await db.execute(sql`select count(*)::int as n from incidents`)).rows as { n: number }[];
  if (n > 0 && process.env.DEMO_FORCE !== "true") throw new Error("Database already has incidents; set DEMO_FORCE=true to add demo data anyway");
  const pw = await hashPasswordRaw(process.env.DEMO_PASSWORD ?? "demo-password-123");
  await db.insert(s.roles).values([{ key: "service_desk", name: "Service Desk" }, { key: "technical", name: "Technical / NOC" }, { key: "admin", name: "Administrator", requiresMfa: process.env.DEMO_ADMIN_MFA === "true" }]).onConflictDoNothing();
  const mk = async (email: string, name: string, role: "admin" | "technical" | "service_desk") => {
    const [existing] = await db.select().from(s.users).where(sql`lower(email) = ${email}`);
    return existing ?? (await db.insert(s.users).values({ email, name, role, passwordHash: pw }).returning())[0];
  };
  const admin = await mk("admin@demo.atec", "Demo Admin", "admin");
  const admin2 = await mk("manager@demo.atec", "Demo Manager", "admin");
  const desk = await mk("desk@demo.atec", "Thandi (Service Desk)", "service_desk");
  const tech = await mk("noc@demo.atec", "Pieter (NOC)", "technical");
  void admin2;
  await seedReferenceData(db, { publishAs: admin.id });

  const prov = async (name: string, aliases: string[], phone: string) => (await db.insert(s.backhaulProviders).values({ name, publicName: name, aliases, supportPhone: phone }).onConflictDoNothing().returning())[0];
  const dfa = await prov("Dark Fibre Africa", ["DFA"], "+27 12 000 0000");
  const vuma = await prov("Vumatel", ["Vuma"], "+27 87 000 0000");
  const sites = [
    ["DWV", "Dowerview", "Dowerview Estate", dfa?.id, "POP-NORTH", "DFA-CCT-1001"], ["HZD", "Hazeldean", "Hazeldean Country Estate", dfa?.id, "POP-NORTH", "DFA-CCT-1002"],
    ["MDW", "Meadowbrook", "Meadowbrook Village", vuma?.id, "POP-SOUTH", "VUMA-7781"], ["SLV", "Silver Lakes", "Silver Lakes Golf Estate", dfa?.id, "POP-EAST", "DFA-CCT-2040"],
    ["WLW", "Willow Acres", "Willow Acres Estate", vuma?.id, "POP-EAST", "VUMA-7790"], ["KRK", "Kraalkop", "Kraalkop Lifestyle Estate", dfa?.id, "POP-WEST", "DFA-CCT-3301"],
  ] as const;
  const ispA = (await db.insert(s.isps).values({ name: "Demo ISP Alpha" }).onConflictDoNothing().returning())[0];
  const ispB = (await db.insert(s.isps).values({ name: "Demo ISP Bravo" }).onConflictDoNothing().returning())[0];
  let obj = 1000;
  for (const [code, name, estate, providerId, upstream, cct] of sites) {
    const [site] = await db.insert(s.sites).values({ code, name, estate, backhaulProviderId: providerId ?? null, upstreamRef: upstream, circuitRef: cct, residentListRef: `demo-${code.toLowerCase()}`, address: `${name} main gate, Pretoria East`, technicalTeam: "NOC" }).onConflictDoNothing().returning();
    if (!site) continue;
    obj += 1;
    await db.insert(s.siteMonitoringIdentifiers).values([
      { siteId: site.id, source: "netxms", matchType: "object_id", value: String(obj), label: `${code} L3GR10`, critical: true },
      { siteId: site.id, source: "any", matchType: "name_prefix", value: `${code} L2`, label: "Access switches", critical: false },
    ]);
    if (ispA) await db.insert(s.siteIsps).values({ siteId: site.id, ispId: ispA.id }).onConflictDoNothing();
    if (ispB && ["DWV", "MDW", "SLV"].includes(code)) await db.insert(s.siteIsps).values({ siteId: site.id, ispId: ispB.id }).onConflictDoNothing();
  }
  if (ispA) await db.insert(s.recipients).values([{ audience: "isp", ispId: ispA.id, email: "noc@alpha.demo.invalid", name: "Alpha NOC" }, { audience: "isp", ispId: ispA.id, email: "support@alpha.demo.invalid" }]).onConflictDoNothing();
  if (ispB) await db.insert(s.recipients).values([{ audience: "isp", ispId: ispB.id, email: "ops@bravo.demo.invalid", name: "Bravo Ops" }]).onConflictDoNothing();
  await db.insert(s.recipients).values({ audience: "internal", team: "NOC", email: "noc-team@demo.atec.invalid", name: "NOC team mailbox" }).onConflictDoNothing();

  // ── Play a realistic morning, compressed, using a virtual clock ──
  const st = await getSettings(db);
  const real = Date.now();
  let t = real - 5.5 * 3600_000;
  clock.set(() => new Date(t));
  const ev = (event: string, id: number) => processEvent(db, fromNetxms({ event, object_id: id, object_name: `node-${id}`, timestamp: Math.floor(t / 1000) }, st));
  const step = async (min: number) => { const end = t + min * 60_000; while (t < end) { t = Math.min(end, t + 60_000); await drain(db); } };
  const actor = (u: typeof desk) => ({ id: u.id, label: u.name });
  const inc = async (code: string) => (await db.execute(sql`select i.id, i.version from incidents i join sites s on s.id=i.site_id where s.code=${code} order by (i.phase in ('validating','active','restoring','awaiting_rfo')) desc, i.created_at desc limit 1`)).rows[0] as { id: string; version: number };

  // Earlier this month: a resolved outage, so reports have history
  t = real - 9 * 86400_000;
  await ev("SYS_NODE_DOWN", 1006); await step(5);
  await confirmCause(db, actor(desk), { incidentId: (await inc("KRK")).id, causeKey: "power_area" }); await step(150);
  await ev("SYS_NODE_UP", 1006); await step(10);
  await submitRfo(db, actor(tech), { incidentId: (await inc("KRK")).id, rfoText: "Municipal power failure affecting the Kraalkop area. Service resumed automatically when power was restored." }); await step(2);
  t = real - 5.5 * 3600_000;
  await ev("SYS_NODE_DOWN", 1003); await step(4);                  // MDW: 5h+ outage, provider fibre break
  await confirmCause(db, actor(desk), { incidentId: (await inc("MDW")).id, causeKey: "power_ok" }); await step(50);
  await submitTechnicalUpdate(db, actor(tech), { incidentId: (await inc("MDW")).id, text: "Vumatel confirmed a fibre break on the Lynnwood route. Splicing team dispatched. No ETA yet. Ref VUMA-INC-55821", facts: { providerId: vuma!.id, faultType: "fibre_break", technicians: "dispatched", etaUnavailable: true, providerRef: "VUMA-INC-55821" } });
  await step(60);
  await ev("SYS_NODE_DOWN", 1006); await step(2); await ev("SYS_NODE_UP", 1006); await step(30); // KRK: short flap
  await ev("SYS_NODE_DOWN", 1004); await step(5);                   // SLV: restored later, awaiting RFO
  await confirmCause(db, actor(desk), { incidentId: (await inc("SLV")).id, causeKey: "equipment_failure" }); await step(70);
  await ev("SYS_NODE_UP", 1004); await step(10);
  await submitTechnicalUpdate(db, actor(tech), { incidentId: (await inc("MDW")).id, text: "Vuma techs on site, splicing in progress. ETA 3 hours.", facts: { technicians: "on_site", repairStatus: "underway", eta: new Date(real + 2.5 * 3600_000).toISOString() } });
  await step(40);
  await ev("SYS_NODE_DOWN", 1005); await step(4);                   // WLW: server room power, dispatch acknowledged later
  await confirmCause(db, actor(desk), { incidentId: (await inc("WLW")).id, causeKey: "power_server_room" });
  await createDispatch(db, actor(desk), { incidentId: (await inc("WLW")).id, notes: "Guard at gate has the cabinet key" }); await step(20);
  await ev("SYS_NODE_DOWN", 1001); await ev("SYS_NODE_DOWN", 1002); await step(4);  // DWV + HZD: shared POP, cause not yet confirmed
  await step(Math.max(0, (real - t) / 60_000 - 1));
  clock.reset();
  await drain(db);
  await runEscalationSweep(db);
  await healthOk(db, "monitoring:netxms", "NetXMS events", { demo: true });
  console.log("[demo] ready. Sign in with admin@demo.atec / desk@demo.atec / noc@demo.atec — password:", process.env.DEMO_PASSWORD ?? "demo-password-123");
  await getPool().end();
}
main().catch(async (e) => { console.error(e); await getPool().end(); process.exit(1); });
