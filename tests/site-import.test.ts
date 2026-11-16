import { beforeEach, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";
import { setup, s, type World } from "./helpers";
import { exportSitesWorkbook, importSitesWorkbook } from "@/server/admin/site-import";

let w: World;
beforeEach(async () => { w = await setup(); });

async function edit(buf: Buffer, fn: (ws: ExcelJS.Worksheet, ic: ExcelJS.Worksheet) => void) {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf as unknown as ArrayBuffer);
  fn(wb.getWorksheet("Sites")!, wb.getWorksheet("ISP contacts")!);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

it("round-trips the sites workbook: preview, then apply identifiers, provider, ISPs and contacts", async () => {
  const out = await exportSitesWorkbook(w.db);
  const buf = await edit(out, (ws, ic) => {
    ws.eachRow((r, n) => {
      if (n > 1 && r.getCell(4).value === "Meadowbrook") {
        r.getCell(3).value = "MBK";                    // corrected code → rename
        r.getCell(5).value = "MBK L3GR10"; r.getCell(6).value = 4711;
        r.getCell(7).value = "Openserve"; r.getCell(10).value = "res-meadowbrook";
        r.getCell(11).value = "ISP Bravo, ISP Charlie";
      }
    });
    ws.addRow(["FMAS", "Gauteng", "NEW", "Brand New Estate", "", "", "", "", "", "", "", "NOC", "Y", "", ""]);
    ic.addRow(["ISP Charlie", "Charlie NOC", "noc@charlie.test", ""]);
  });
  const preview = await importSitesWorkbook(w.db, w.admin, buf, false);
  expect(preview.applied).toBe(false);
  expect(preview.errors).toEqual([]);
  expect(preview.changes.find((c) => c.site === "Meadowbrook")?.action).toBe("rename");
  expect(preview.changes.find((c) => c.site === "Brand New Estate")?.action).toBe("create");
  expect((await w.db.select().from(s.sites).where(eq(s.sites.code, "MBK")))).toHaveLength(0); // nothing saved yet

  const res = await importSitesWorkbook(w.db, w.admin, buf, true);
  expect(res.applied).toBe(true);
  expect(res.contacts.added).toBe(1);
  const [mbk] = await w.db.select().from(s.sites).where(eq(s.sites.code, "MBK"));
  expect(mbk.id).toBe(w.mdw.id);
  expect(mbk.residentListRef).toBe("res-meadowbrook");
  const ids = await w.db.select().from(s.siteMonitoringIdentifiers).where(eq(s.siteMonitoringIdentifiers.siteId, mbk.id));
  expect(ids.filter((i) => i.critical && i.matchType === "object_id").map((i) => i.value)).toEqual(["4711"]);
  const links = await w.db.select({ name: s.isps.name }).from(s.siteIsps).innerJoin(s.isps, eq(s.isps.id, s.siteIsps.ispId)).where(eq(s.siteIsps.siteId, mbk.id));
  expect(links.map((l) => l.name).sort()).toEqual(["ISP Bravo", "ISP Charlie"]);
  const [prov] = await w.db.select().from(s.backhaulProviders).where(eq(s.backhaulProviders.name, "Openserve"));
  expect(mbk.backhaulProviderId).toBe(prov.id);
  expect(await w.db.select().from(s.sites).where(eq(s.sites.code, "NEW"))).toHaveLength(1);
});

it("rejects duplicate codes and bad data without saving anything", async () => {
  const out = await exportSitesWorkbook(w.db);
  const buf = await edit(out, (ws, ic) => {
    ws.eachRow((r, n) => { if (n > 1 && r.getCell(4).value === "Hazeldean") { r.getCell(3).value = "DWV"; r.getCell(6).value = "abc"; } });
    ic.addRow(["ISP X", "", "not-an-email", ""]);
  });
  const res = await importSitesWorkbook(w.db, w.admin, buf, true);
  expect(res.applied).toBe(false);
  expect(res.errors.map((e) => e.message).join(" | ")).toMatch(/already used.*|valid email/);
  expect((await w.db.select().from(s.sites).where(eq(s.sites.id, w.hzd.id)))[0].code).toBe("HZD");
});
