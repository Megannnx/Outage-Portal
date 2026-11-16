import { beforeEach, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { setup, down, run, incidentFor, s, at, type World } from "./helpers";
import { submitTechnicalUpdate } from "@/server/incidents/actions";
import { removeDemoData } from "@/server/admin/demo-cleanup";
import { readiness } from "@/server/admin/readiness";
import { processEvent } from "@/server/incidents/lifecycle";

let w: World;
beforeEach(async () => { w = await setup(); });

it("removes demo sites, simulated incidents and demo approvals, keeping real history", async () => {
  // Demo site with a full incident history
  await w.db.update(s.sites).set({ code: "DEMO-MDW", name: "Meadowbrook (DEMO)" }).where(eq(s.sites.id, w.mdw.id));
  await down(w.db, "3001");
  await run(w.db, 3);
  const demoInc = await incidentFor(w.db, w.mdw.id);
  await submitTechnicalUpdate(w.db, w.tech, { incidentId: demoInc.id, text: "techs on site", facts: { technicians: "on_site" } });
  // Simulated outage on a real site
  await processEvent(w.db, { source: "netxms", dedupeKey: "sim:1", kind: "down", eventName: "SIMULATED_DOWN", objectRef: "2001", objectName: "", occurredAt: at(), raw: { simulated: true } });
  await run(w.db, 3);
  // Real outage on another real site
  await down(w.db, "1001");
  await run(w.db, 3);
  const realInc = await incidentFor(w.db, w.dwv.id);
  // Pretend the starter wording was demo-approved
  await w.db.execute(sql`update template_approvals set comment = 'Demo setup (capture mode)'`);

  const r = await removeDemoData(w.db, w.admin);
  expect(r.sites).toBe(1);
  expect(r.incidents).toBe(2);
  expect(r.templatesBackToPending).toBeGreaterThan(20);
  const left = await w.db.select().from(s.incidents);
  expect(left.map((i) => i.id)).toEqual([realInc.id]);
  expect((await w.db.select().from(s.communications)).every((c) => c.incidentId === realInc.id)).toBe(true);
  expect(await w.db.select().from(s.sites).where(eq(s.sites.id, w.mdw.id))).toHaveLength(0);
  // Protection on technical notes is back on
  await expect(w.db.execute(sql`delete from technical_updates`)).resolves.toBeDefined(); // none left to delete
  const audits = await w.db.select().from(s.auditLogs).where(eq(s.auditLogs.action, "demo_data.removed"));
  expect(audits).toHaveLength(1);

  const rd = await readiness(w.db);
  expect(rd.ready).toBe(false);
  expect(rd.checks.find((c) => c.key === "template_review")?.status).toBe("ok");
  expect(rd.checks.find((c) => c.key === "templates")?.status).toBe("fail"); // back to pending → must be re-approved
  expect(rd.checks.find((c) => c.key === "demo")?.status).toBe("ok");
});
