/** Scenario I — monthly reporting traceable to recorded events. */
import { beforeEach, expect, it } from "vitest";
import { setup, down, up, run, incidentFor, captureControl, type World } from "./helpers";
import { confirmCause, submitRfo } from "@/server/incidents/actions";
import { buildReport, findings, trend } from "@/server/reports/metrics";
import { toCsv, toPdf, toXlsx } from "@/server/reports/export";
import { applyDeliveryStatus } from "@/server/comms/delivery-status";
import { s } from "./helpers";
import { eq } from "drizzle-orm";

let w: World;
beforeEach(async () => { w = await setup(); });

it("Scenario I: monthly report matches what happened", async () => {
  // Outage 1: DWV, 2h30, area power, RFO supplied
  await down(w.db, "1001");
  await run(w.db, 5);
  const i1 = await incidentFor(w.db, w.dwv.id);
  await confirmCause(w.db, w.desk, { incidentId: i1.id, causeKey: "power_area" });
  await run(w.db, 145);
  await up(w.db, "1001");
  await run(w.db, 10);
  await submitRfo(w.db, w.tech, { incidentId: i1.id, rfoText: "Municipal power failure in the area; service resumed when power returned." });
  await run(w.db, 1);
  // Short interruption at HZD (2 min)
  await down(w.db, "2001"); await run(w.db, 2); await up(w.db, "2001"); await run(w.db, 2);
  // Outage 2: MDW 40 min, cause never confirmed, one ISP bounce, still awaiting RFO
  await down(w.db, "3001");
  await run(w.db, 40);
  await up(w.db, "3001");
  await run(w.db, 10);
  const [bd] = await w.db.select().from(s.communicationDeliveries).where(eq(s.communicationDeliveries.address, "noc@bravo.test")).limit(1);
  await applyDeliveryStatus(w.db, { providerMessageId: bd.providerMessageId!, status: "bounced", detail: "550", hard: true });

  const r = await buildReport(w.db, { from: new Date("2026-10-31T22:00:00Z"), to: new Date("2026-11-30T22:00:00Z") });
  const S = r.summary;
  expect(S.qualifyingOutages).toBe(2);
  expect(S.affectedSites).toBe(2);
  expect(S.interruptions).toBe(1);
  expect(S.totalDowntimeSec).toBe(150 * 60 + 40 * 60);
  expect(S.longestSec).toBe(150 * 60);
  expect(S.shortestSec).toBe(40 * 60);
  expect(S.medianDowntimeSec).toBe(95 * 60);
  expect(S.awaitingRfo).toBe(1);
  expect(S.noConfirmedCause).toBe(1);
  expect(S.detectionToFirstCommSec).toBe(180);
  expect(S.scheduledUpdates).toBe(1);              // one 2-hourly message during the 2h30 outage
  expect(S.intervalCompliancePct).toBe(100);
  expect(S.failedSends).toBe(1);
  expect(S.deliverySuccessPct).toBeLessThan(100);
  expect(r.byCause.find((c) => c.name === "Power outage — area wide")?.count).toBe(1);
  expect(r.rfoBacklog.map((x) => x.site)).toEqual(["Meadowbrook"]);
  expect(findings(r, null).some((f) => f.text.includes("indicative"))).toBe(true);

  const csv = toCsv(r);
  expect(csv).toContain("Dowerview");
  const t = await trend(w.db, new Date("2026-11-30T22:00:00Z"));
  expect(t.at(-1)).toMatchObject({ outages: 2, interruptions: 1 });
  const x = await toXlsx(r, t, null);
  expect(x.subarray(0, 2).toString()).toBe("PK");
  const p = await toPdf(r, t, null, "Monthly outage report — November 2026");
  expect(p.subarray(0, 4).toString()).toBe("%PDF");
  void captureControl;
});

it("empty period → no fabricated findings", async () => {
  const r = await buildReport(w.db, { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-02-01T00:00:00Z") });
  expect(r.summary.qualifyingOutages).toBe(0);
  expect(findings(r, null)).toEqual([{ level: "info", text: expect.stringContaining("No qualifying outages") }]);
});
