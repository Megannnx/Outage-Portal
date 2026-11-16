/**
 * Site-details spreadsheet round trip.
 *
 *   exportSitesWorkbook()  → the "ATEC Outage Portal — Site details" workbook (Sites + ISP contacts tabs)
 *   importSitesWorkbook()  → reads the same layout back; dry-run returns a preview, apply commits in one transaction
 *
 * Rows are matched on the site's database id (hidden column), then code, then exact name, so a
 * corrected site code is treated as a rename rather than a new site. Blank cells mean "leave as is".
 */
import ExcelJS from "exceljs";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { backhaulProviders, isps, recipients, siteIsps, siteMonitoringIdentifiers, sites } from "../db/schema";
import { audit, type Actor } from "../audit/audit";
import { badRequest } from "../lib/errors";

const COLS = [
  "Network", "Province", "Site code", "Site name", "NetXMS device (critical)", "NetXMS object ID", "Backhaul provider",
  "Circuit / reference", "Upstream POP", "Residents list reference", "ISPs on this site", "Technical team", "RFO required (Y/N)",
  "Address", "Notes", "Headend IP", "Portal ID (do not edit)",
] as const;
const FILL_IN = new Set([5, 6, 7, 8, 9, 10, 11, 14, 16]);

const networkOf = (notes: string) => /Network:\s*(\w+)/.exec(notes)?.[1] ?? "";

export async function exportSitesWorkbook(db: DB): Promise<Buffer> {
  const [ss, ids, provs, links, ispRows, contacts] = await Promise.all([
    db.select().from(sites).where(sql`${sites.code} not like 'DEMO-%'`).orderBy(sites.region, sites.name),
    db.select().from(siteMonitoringIdentifiers),
    db.select().from(backhaulProviders),
    db.select().from(siteIsps),
    db.select().from(isps),
    db.select().from(recipients).where(eq(recipients.audience, "isp")),
  ]);
  const wb = new ExcelJS.Workbook();
  wb.creator = "ATEC Outage Portal";
  const font = { name: "Arial", size: 10 };
  const head = (ws: ExcelJS.Worksheet) => {
    ws.getRow(1).eachCell((c) => { c.font = { ...font, bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF18181B" } }; c.alignment = { wrapText: true, vertical: "middle" }; });
    ws.getRow(1).height = 30;
    ws.views = [{ state: "frozen", xSplit: 4, ySplit: 1 }];
  };
  const ws = wb.addWorksheet("Sites");
  ws.columns = COLS.map((h, i) => ({ header: h, key: String(i), width: [8, 14, 10, 30, 24, 16, 20, 20, 16, 22, 28, 12, 12, 28, 40, 16, 38][i] }));
  for (const s of ss) {
    const crit = ids.filter((i) => i.siteId === s.id && i.critical);
    const oid = crit.find((i) => i.matchType === "object_id");
    const ip = crit.find((i) => i.matchType === "ip");
    const dev = crit.find((i) => i.matchType === "name_exact" || i.matchType === "name_prefix")?.value ?? oid?.label ?? "";
    const ispNames = links.filter((l) => l.siteId === s.id).map((l) => ispRows.find((x) => x.id === l.ispId)?.name).filter(Boolean).join(", ");
    ws.addRow([s.network || networkOf(s.notes), s.region, s.code, s.name, dev, oid?.value ?? "", provs.find((p) => p.id === s.backhaulProviderId)?.name ?? "",
      s.circuitRef, s.upstreamRef, s.residentListRef, ispNames, s.technicalTeam, s.rfoRequired ? "Y" : "N", s.address, s.notes, ip?.value ?? "", s.id]);
  }
  ws.eachRow((row, n) => {
    if (n === 1) return;
    row.eachCell({ includeEmpty: true }, (c, col) => {
      c.font = font;
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL_IN.has(col) ? "FFFFF2CC" : col === 17 ? "FFE4E4E7" : "FFF1F1F4" } };
    });
  });
  for (let r = 2; r <= ss.length + 1; r++) ws.getCell(`M${r}`).dataValidation = { type: "list", allowBlank: true, formulae: ['"Y,N"'] };
  head(ws);
  ws.autoFilter = { from: "A1", to: `Q${ss.length + 1}` };

  const ic = wb.addWorksheet("ISP contacts");
  ic.columns = [{ header: "ISP name", width: 24 }, { header: "Contact name", width: 24 }, { header: "Outage notice email", width: 34 }, { header: "Notes", width: 40 }];
  for (const c of contacts) {
    const isp = ispRows.find((x) => x.id === c.ispId);
    if (isp && !isp.name.includes("(DEMO)")) ic.addRow([isp.name, c.name, c.email, c.status === "active" ? "" : `Status: ${c.status}`]);
  }
  for (let i = 0; i < 20; i++) ic.addRow([]);
  ic.eachRow((row, n) => { if (n > 1) for (let col = 1; col <= 4; col++) { const c = row.getCell(col); c.font = font; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } }; } });
  head(ic);
  ic.views = [{ state: "frozen", ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ───────────────────────────── Import ─────────────────────────────

export interface ImportChange { row: number; site: string; action: "update" | "rename" | "create"; changes: string[] }
export interface ImportResult { applied: boolean; changes: ImportChange[]; errors: { row: number; message: string }[]; warnings: string[]; contacts: { added: number; skipped: number } }

const str = (v: unknown) => {
  if (v == null) return "";
  if (typeof v === "object" && v && "text" in v) return String((v as { text: unknown }).text).trim();
  if (typeof v === "object" && v && "result" in v) return String((v as { result: unknown }).result ?? "").trim();
  return String(v).trim();
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function importSitesWorkbook(db: DB, actor: Actor, file: Buffer, apply: boolean): Promise<ImportResult> {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(file as unknown as ArrayBuffer); } catch { throw badRequest("That file could not be read as an Excel workbook (.xlsx)"); }
  const ws = wb.getWorksheet("Sites");
  if (!ws) throw badRequest('The workbook needs a "Sites" tab (use the workbook downloaded from this page)');
  const header = (ws.getRow(1).values as unknown[]).slice(1).map(str);
  const col = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase()) + 1;
  const C = Object.fromEntries(COLS.map((c) => [c, col(c)])) as Record<(typeof COLS)[number], number>;
  if (!C["Site name"] || !C["Site code"]) throw badRequest('The "Sites" tab must have "Site code" and "Site name" columns');

  const existing = await db.select().from(sites);
  const provs = await db.select().from(backhaulProviders);
  const ispRows = await db.select().from(isps);
  const result: ImportResult = { applied: false, changes: [], errors: [], warnings: [], contacts: { added: 0, skipped: 0 } };
  const usedCodes = new Map(existing.map((s) => [s.code, s.id]));

  type Plan = { row: number; siteId: string | null; patch: Partial<typeof sites.$inferInsert>; providerName?: string; objectId?: string; device?: string; ip?: string; ispNames?: string[] };
  const plans: Plan[] = [];
  const cell = (r: ExcelJS.Row, k: (typeof COLS)[number]) => (C[k] ? str(r.getCell(C[k]).value) : "");

  ws.eachRow((r, n) => {
    if (n === 1) return;
    const name = cell(r, "Site name"), code = cell(r, "Site code").toUpperCase();
    if (!name && !code) return;
    const pid = cell(r, "Portal ID (do not edit)");
    const site = existing.find((s) => s.id === pid) ?? existing.find((s) => s.code === code) ?? existing.find((s) => s.name.toLowerCase() === name.toLowerCase());
    const label = name || code;
    if (!name) { result.errors.push({ row: n, message: "Site name is empty" }); return; }
    if (!/^[A-Z0-9_-]{2,16}$/.test(code)) { result.errors.push({ row: n, message: `"${code}" is not a valid site code (2–16 letters, digits, - or _)` }); return; }
    const owner = usedCodes.get(code);
    if (owner && owner !== site?.id) { result.errors.push({ row: n, message: `Site code ${code} is already used by another site` }); return; }
    usedCodes.set(code, site?.id ?? `new:${n}`);

    const patch: Partial<typeof sites.$inferInsert> = {};
    const changes: string[] = [];
    const set = <K extends keyof typeof sites.$inferInsert>(k: K, v: (typeof sites.$inferInsert)[K], label: string) => {
      if (!site || (site as Record<string, unknown>)[k] !== v) { patch[k] = v; changes.push(label); }
    };
    if (site && site.code !== code) set("code", code, `code ${site.code} → ${code}`);
    if (!site) patch.code = code;
    set("name", name, "name");
    if (!site) set("estate", name, "estate");
    const region = cell(r, "Province"); if (region) set("region", region, "province");
    const network = cell(r, "Network").toUpperCase(); if (network) set("network", network, "network");
    for (const [k, c, l] of [["circuitRef", "Circuit / reference", "circuit"], ["upstreamRef", "Upstream POP", "upstream POP"], ["residentListRef", "Residents list reference", "residents list"], ["technicalTeam", "Technical team", "team"], ["address", "Address", "address"]] as const) {
      const v = cell(r, c); if (v) set(k, v, l);
    }
    // Notes: a full notes cell (as exported) replaces; a short addition is appended so the network tag is kept.
    const notes = cell(r, "Notes");
    if (notes && !(site?.notes ?? "").includes(notes)) set("notes", !site || /Network:/.test(notes) ? notes : `${site.notes} ${notes}`.trim(), "notes");
    const rfo = cell(r, "RFO required (Y/N)").toUpperCase();
    if (rfo === "Y" || rfo === "N") set("rfoRequired", rfo === "Y", "RFO required");
    else if (rfo) result.warnings.push(`Row ${n}: RFO required "${rfo}" ignored — use Y or N`);

    const plan: Plan = { row: n, siteId: site?.id ?? null, patch };
    const prov = cell(r, "Backhaul provider");
    if (prov) {
      const p = provs.find((x) => x.name.toLowerCase() === prov.toLowerCase() || x.aliases.some((a) => a.toLowerCase() === prov.toLowerCase()));
      if (!p || p.id !== site?.backhaulProviderId) { plan.providerName = p?.name ?? prov; changes.push(p ? "backhaul provider" : `backhaul provider (new: ${prov})`); }
    }
    const oid = cell(r, "NetXMS object ID").replace(/\.0$/, "");
    if (oid) { if (!/^\d+(\/[\w.\-:]+)?$/.test(oid)) result.errors.push({ row: n, message: `NetXMS object ID "${oid}" should be a number` }); else { plan.objectId = oid; changes.push("NetXMS object ID"); } }
    const dev = cell(r, "NetXMS device (critical)"); if (dev) { plan.device = dev; if (!oid) changes.push("NetXMS device name"); }
    const ip = cell(r, "Headend IP");
    if (ip) {
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) result.errors.push({ row: n, message: `Headend IP "${ip}" is not a valid IPv4 address` });
      else { plan.ip = ip; changes.push(`headend IP ${ip}`); }
    }
    const ispCell = cell(r, "ISPs on this site");
    if (ispCell) { plan.ispNames = ispCell.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean); changes.push(`ISPs: ${plan.ispNames.join(", ")}`); }
    plans.push(plan);
    if (changes.length) result.changes.push({ row: n, site: label, action: !site ? "create" : patch.code ? "rename" : "update", changes });
  });

  // ISP contacts tab (optional)
  const contactRows: { row: number; isp: string; name: string; email: string }[] = [];
  const ic = wb.getWorksheet("ISP contacts");
  if (ic) ic.eachRow((r, n) => {
    if (n === 1) return;
    const isp = str(r.getCell(1).value), name = str(r.getCell(2).value), email = str(r.getCell(3).value).toLowerCase();
    if (!isp && !email) return;
    if (!isp || !EMAIL.test(email)) { result.errors.push({ row: n, message: `ISP contacts tab: needs an ISP name and a valid email (got "${isp}", "${email}")` }); return; }
    contactRows.push({ row: n, isp, name, email });
  });
  const knownIsps = new Set([...ispRows.map((i) => i.name.toLowerCase()), ...contactRows.map((c) => c.isp.toLowerCase())]);
  for (const p of plans) for (const nm of p.ispNames ?? []) if (!knownIsps.has(nm.toLowerCase())) result.warnings.push(`Row ${p.row}: ISP "${nm}" has no contacts yet — it will be created, but add its email on the ISP contacts tab`);
  result.warnings = [...new Set(result.warnings)];

  if (!apply || result.errors.length) return result;

  await db.transaction(async (tx) => {
    const ispByName = new Map(ispRows.map((i) => [i.name.toLowerCase(), i.id]));
    const ensureIsp = async (name: string) => {
      const k = name.toLowerCase();
      if (ispByName.has(k)) return ispByName.get(k)!;
      const [row] = await tx.insert(isps).values({ name }).onConflictDoNothing().returning();
      const id = row?.id ?? (await tx.select().from(isps).where(eq(isps.name, name)))[0].id;
      ispByName.set(k, id); return id;
    };
    for (const p of plans) {
      if (p.providerName) {
        let prov = provs.find((x) => x.name === p.providerName);
        if (!prov) { [prov] = await tx.insert(backhaulProviders).values({ name: p.providerName, publicName: p.providerName }).returning(); provs.push(prov); }
        p.patch.backhaulProviderId = prov.id;
      }
      let siteId = p.siteId;
      if (siteId && Object.keys(p.patch).length) await tx.update(sites).set(p.patch).where(eq(sites.id, siteId));
      if (!siteId) siteId = (await tx.insert(sites).values(p.patch as typeof sites.$inferInsert).returning())[0].id;
      if (p.objectId) {
        await tx.delete(siteMonitoringIdentifiers).where(and(eq(siteMonitoringIdentifiers.siteId, siteId), eq(siteMonitoringIdentifiers.matchType, "object_id"), eq(siteMonitoringIdentifiers.critical, true)));
        await tx.insert(siteMonitoringIdentifiers).values({ siteId, source: "netxms", matchType: "object_id", value: p.objectId, critical: true, label: p.device ?? "" })
          .onConflictDoUpdate({ target: [siteMonitoringIdentifiers.source, siteMonitoringIdentifiers.matchType, siteMonitoringIdentifiers.value], set: { siteId, critical: true, label: p.device ?? "" } });
      } else if (p.device) {
        await tx.insert(siteMonitoringIdentifiers).values({ siteId, source: "any", matchType: "name_exact", value: p.device, critical: true, label: "From spreadsheet" })
          .onConflictDoUpdate({ target: [siteMonitoringIdentifiers.source, siteMonitoringIdentifiers.matchType, siteMonitoringIdentifiers.value], set: { siteId, critical: true } });
      }
      if (p.ip) {
        await tx.delete(siteMonitoringIdentifiers).where(and(eq(siteMonitoringIdentifiers.siteId, siteId), eq(siteMonitoringIdentifiers.matchType, "ip")));
        await tx.insert(siteMonitoringIdentifiers).values({ siteId, source: "netxms", matchType: "ip", value: p.ip, critical: true, label: "Headend IP" })
          .onConflictDoUpdate({ target: [siteMonitoringIdentifiers.source, siteMonitoringIdentifiers.matchType, siteMonitoringIdentifiers.value], set: { siteId, critical: true } });
      }
      if (p.ispNames) {
        const ids = [];
        for (const nm of p.ispNames) ids.push(await ensureIsp(nm));
        await tx.delete(siteIsps).where(eq(siteIsps.siteId, siteId));
        if (ids.length) await tx.insert(siteIsps).values([...new Set(ids)].map((ispId) => ({ siteId: siteId!, ispId })));
      }
    }
    for (const c of contactRows) {
      const ispId = await ensureIsp(c.isp);
      const r = await tx.insert(recipients).values({ audience: "isp", ispId, name: c.name, email: c.email }).onConflictDoNothing().returning();
      if (r.length) result.contacts.added++; else result.contacts.skipped++;
    }
    await audit(tx, actor, "sites.imported_from_spreadsheet", "sites", "bulk", null,
      { sitesChanged: result.changes.length, created: result.changes.filter((c) => c.action === "create").length, contactsAdded: result.contacts.added });
  });
  result.applied = true;
  void inArray;
  return result;
}
