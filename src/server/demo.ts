/**
 * DEMO / PILOT ONLY (capture mode): example sites, providers, ISPs and contacts using
 * .invalid addresses, so the portal can be explored end to end with the outage simulator.
 */
import type { DB } from "./db/client";
import * as s from "./db/schema";

export async function seedDemoSites(db: DB) {
  const prov = async (name: string, aliases: string[], phone: string) =>
    (await db.insert(s.backhaulProviders).values({ name, publicName: name, aliases, supportPhone: phone }).onConflictDoNothing().returning())[0];
  const dfa = await prov("Dark Fibre Africa", ["DFA"], "+27 12 000 0000");
  const vuma = await prov("Vumatel", ["Vuma"], "+27 87 000 0000");
  const [ispA] = await db.insert(s.isps).values({ name: "Demo ISP Alpha" }).onConflictDoNothing().returning();
  const [ispB] = await db.insert(s.isps).values({ name: "Demo ISP Bravo" }).onConflictDoNothing().returning();
  const sites: [string, string, string, string | undefined, string][] = [
    ["DWV", "Dowerview", "Dowerview Estate", dfa?.id, "POP-NORTH"], ["HZD", "Hazeldean", "Hazeldean Country Estate", dfa?.id, "POP-NORTH"],
    ["MDW", "Meadowbrook", "Meadowbrook Village", vuma?.id, "POP-SOUTH"], ["SLV", "Silver Lakes", "Silver Lakes Golf Estate", dfa?.id, "POP-EAST"],
    ["WLW", "Willow Acres", "Willow Acres Estate", vuma?.id, "POP-EAST"], ["KRK", "Kraalkop", "Kraalkop Lifestyle Estate", dfa?.id, "POP-WEST"],
  ];
  let obj = 1000;
  for (const [code, name, estate, providerId, upstream] of sites) {
    obj++;
    const [site] = await db.insert(s.sites).values({ code, name, estate, backhaulProviderId: providerId ?? null, upstreamRef: upstream, circuitRef: `DEMO-CCT-${obj}`, residentListRef: `demo-${code.toLowerCase()}`, address: `${name} main gate (demo)`, technicalTeam: "NOC", notes: "DEMO SITE" }).onConflictDoNothing().returning();
    if (!site) continue;
    await db.insert(s.siteMonitoringIdentifiers).values({ siteId: site.id, source: "netxms", matchType: "object_id", value: String(obj), label: `${code} L3GR10 (demo)`, critical: true }).onConflictDoNothing();
    if (ispA) await db.insert(s.siteIsps).values({ siteId: site.id, ispId: ispA.id }).onConflictDoNothing();
    if (ispB && ["DWV", "MDW", "SLV"].includes(code)) await db.insert(s.siteIsps).values({ siteId: site.id, ispId: ispB.id }).onConflictDoNothing();
  }
  if (ispA) await db.insert(s.recipients).values([{ audience: "isp", ispId: ispA.id, email: "noc@alpha.demo.invalid", name: "Alpha NOC (demo)" }, { audience: "isp", ispId: ispA.id, email: "support@alpha.demo.invalid" }]).onConflictDoNothing();
  if (ispB) await db.insert(s.recipients).values({ audience: "isp", ispId: ispB.id, email: "ops@bravo.demo.invalid", name: "Bravo Ops (demo)" }).onConflictDoNothing();
  await db.insert(s.recipients).values({ audience: "internal", team: "NOC", email: "noc-team@demo.invalid", name: "NOC team mailbox (demo)" }).onConflictDoNothing();
}
