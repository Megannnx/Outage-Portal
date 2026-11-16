import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import type { Report } from "./metrics";
import { findings } from "./metrics";
import { fmtDateTime, fmtDuration } from "../lib/time";

const d = (s: number | null | undefined) => (s == null ? "n/a" : fmtDuration(s));
const pct = (x: number | null | undefined) => (x == null ? "n/a" : `${x.toFixed(1)}%`);
const mins = (x: number | null | undefined) => (x == null ? "n/a" : `${Math.round(x)} min`);

export function keyMetrics(r: Report): [string, string, string][] {
  const s = r.summary;
  return [
    ["Qualifying outages", String(s.qualifyingOutages), "qualifyingOutages"],
    ["Affected sites", String(s.affectedSites), ""],
    ["Short interruptions (< validation)", String(s.interruptions), "interruptions"],
    ["Total downtime", d(s.totalDowntimeSec), "totalDowntime"],
    ["Average / median downtime", `${d(s.avgDowntimeSec)} / ${d(s.medianDowntimeSec)}`, ""],
    ["Longest / shortest qualifying outage", `${d(s.longestSec)} / ${d(s.shortestSec)}`, ""],
    ["MTRS", d(s.mtrsSec), "mtrs"],
    ["MTTR", s.mttrSample ? `${d(s.mttrSec)} (n=${s.mttrSample})` : "Not measurable", "mttr"],
    ["Restoration → RFO received", d(s.restoreToRfoSec), "restoreToRfo"],
    ["RFO → final message", d(s.rfoToFinalSec), "rfoToFinal"],
    ["Awaiting RFO", String(s.awaitingRfo), ""],
    ["Open / unresolved incidents", String(s.activeUnresolved), ""],
    ["Detection → first customer message", d(s.detectionToFirstCommSec), "detectionToFirstComm"],
    ["Initial messages", String(s.initialComms), ""],
    ["Immediate technical updates", String(s.immediateTechnicalUpdates), ""],
    ["Scheduled no-update messages", String(s.scheduledUpdates), ""],
    ["Average / max update interval", `${mins(s.avgIntervalMin)} / ${mins(s.maxIntervalMin)}`, "updateInterval"],
    ["Update interval compliance", pct(s.intervalCompliancePct), "intervalCompliance"],
    ["Missed update deadlines", String(s.missedDeadlines), ""],
    ["Delivery success", pct(s.deliverySuccessPct), "deliverySuccess"],
    ["Failed / bounced deliveries", String(s.failedSends), ""],
    ["Outages with no confirmed cause", String(s.noConfirmedCause), ""],
    ["Time to confirm cause", d(s.causeConfirmationSec), "causeConfirmation"],
    ["Incidents with technician dispatch", String(s.dispatchIncidents), ""],
    ["Server-room confirmation → dispatch", d(s.dispatchCreationSec), "dispatchCreation"],
    ["Dispatch → acknowledgement", d(s.dispatchAckSec), "dispatchAck"],
    ["Validation → first technical update", d(s.firstTechUpdateSec), "firstTechUpdate"],
    ["Technical updates per assigned incident", s.techUpdatesPerIncident == null ? "n/a" : s.techUpdatesPerIncident.toFixed(1), ""],
    ["Overdue technical follow-ups", String(s.overdueTechFollowUps), ""],
    ["Incidents escalated", String(s.escalatedIncidents), ""],
  ];
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
  // Neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(r: Report): string {
  const lines = [["Metric", "Value", "Definition"].join(",")];
  for (const [k, v, def] of keyMetrics(r)) lines.push([k, v, r.definitions[def] ?? ""].map(csvCell).join(","));
  lines.push("", ["Reference", "Site", "Estate", "Provider", "Cause", "Status", "Start (SAST)", "Restored (SAST)", "Downtime (min)", "RFO", "Customer messages", "Flaps", "Retrospective"].join(","));
  for (const i of r.incidents) lines.push([i.reference, i.site, i.estate, i.provider, i.cause, i.status, fmtDateTime(i.start), i.restored ? fmtDateTime(i.restored) : "", i.downtimeSec == null ? "" : Math.round(i.downtimeSec / 60), i.rfo, i.comms, i.flaps, i.retrospective ? "yes" : ""].map(csvCell).join(","));
  return lines.join("\n");
}

export async function toXlsx(r: Report, trendRows: { month: string; outages: number; interruptions: number; downtimeHours: number }[], prev: Report | null): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ATEC Outage Portal"; wb.created = new Date();
  const head = (ws: ExcelJS.Worksheet) => { ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } }; ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF18181B" } }; ws.views = [{ state: "frozen", ySplit: 1 }]; };
  const sum = wb.addWorksheet("Summary");
  sum.columns = [{ header: "Metric", width: 42 }, { header: "Value", width: 24 }, { header: "Definition", width: 90 }];
  for (const [k, v, def] of keyMetrics(r)) sum.addRow([k, v, r.definitions[def] ?? ""]);
  head(sum);
  const fnd = wb.addWorksheet("Findings");
  fnd.columns = [{ header: "Level", width: 12 }, { header: "Finding", width: 120 }];
  for (const f of findings(r, prev)) fnd.addRow([f.level, f.text]);
  head(fnd);
  const inc = wb.addWorksheet("Incidents");
  inc.columns = [
    { header: "Reference", width: 18 }, { header: "Site", width: 20 }, { header: "Estate", width: 22 }, { header: "Provider", width: 20 }, { header: "Cause", width: 28 },
    { header: "Status", width: 22 }, { header: "Start (SAST)", width: 18 }, { header: "Restored (SAST)", width: 18 }, { header: "Downtime (min)", width: 14 },
    { header: "RFO", width: 12 }, { header: "Customer messages", width: 12 }, { header: "Flaps", width: 8 },
  ];
  for (const i of r.incidents) inc.addRow([i.reference, i.site, i.estate, i.provider, i.cause, i.status, fmtDateTime(i.start), i.restored ? fmtDateTime(i.restored) : "", i.downtimeSec == null ? null : Math.round(i.downtimeSec / 60), i.rfo, i.comms, i.flaps]);
  inc.autoFilter = { from: "A1", to: "L1" };
  head(inc);
  for (const [name, rows] of [["By site", r.bySite], ["By provider", r.byProvider], ["By cause", r.byCause], ["By estate", r.byEstate]] as const) {
    const ws = wb.addWorksheet(name);
    ws.columns = [{ header: name.replace("By ", "").replace(/^./, (c) => c.toUpperCase()), width: 30 }, { header: "Outages", width: 10 }, { header: "Downtime (h)", width: 14 }];
    for (const x of rows) ws.addRow([x.name, x.count, Math.round((x.downtime / 3600) * 10) / 10]);
    head(ws);
  }
  const tr = wb.addWorksheet("Trend");
  tr.columns = [{ header: "Month", width: 12 }, { header: "Outages", width: 10 }, { header: "Short interruptions", width: 18 }, { header: "Downtime (h)", width: 14 }];
  for (const t of trendRows) tr.addRow([t.month, t.outages, t.interruptions, t.downtimeHours]);
  head(tr);
  const rb = wb.addWorksheet("RFO backlog");
  rb.columns = [{ header: "Reference", width: 18 }, { header: "Site", width: 20 }, { header: "Waiting", width: 14 }];
  for (const x of r.rfoBacklog) rb.addRow([x.reference, x.site, d(x.ageSec)]);
  head(rb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function toPdf(r: Report, trendRows: { month: string; outages: number; interruptions: number; downtimeHours: number }[], prev: Report | null, title: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: title, Author: "ATEC Outage Portal" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const RED = "#d71920", INK = "#18181b", MUTED = "#52525b";
    doc.rect(0, 0, doc.page.width, 6).fill(RED);
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(20).text(title, 48, 40);
    doc.font("Helvetica").fontSize(10).fillColor(MUTED).text(`Period: ${fmtDateTime(r.period.from)} – ${fmtDateTime(r.period.to)} (SAST) · Generated ${fmtDateTime(r.generatedAt)}`);
    doc.moveDown(1.2);
    const s = r.summary;
    doc.font("Helvetica-Bold").fontSize(13).fillColor(INK).text("Executive summary");
    doc.font("Helvetica").fontSize(10.5).fillColor(INK).moveDown(0.3).text(
      s.qualifyingOutages === 0
        ? "No qualifying outages were recorded in this period."
        : `${s.qualifyingOutages} qualifying outage(s) affected ${s.affectedSites} site(s), with ${d(s.totalDowntimeSec)} of total downtime (mean time to restore ${d(s.mtrsSec)}). ` +
          `The first customer message went out on average ${d(s.detectionToFirstCommSec)} after an outage began. ` +
          `${s.intervalCompliancePct == null ? "" : `${s.intervalCompliancePct.toFixed(1)}% of customer update gaps met the ${r.settings.updateIntervalMinutes}-minute target. `}` +
          `${s.deliverySuccessPct == null ? "" : `Delivery success was ${s.deliverySuccessPct.toFixed(1)}%. `}` +
          `${s.awaitingRfo} incident(s) are awaiting an RFO and ${s.interruptions} short interruption(s) were recorded without customer notification.`,
      { align: "left" });
    doc.moveDown(0.8);
    doc.font("Helvetica-Bold").fontSize(13).text("Findings & recommended actions");
    doc.moveDown(0.3).font("Helvetica").fontSize(10.5);
    for (const f of findings(r, prev)) {
      doc.fillColor(f.level === "action" ? RED : f.level === "attention" ? "#b45309" : MUTED).text(`${f.level.toUpperCase()}  `, { continued: true }).fillColor(INK).text(f.text);
      doc.moveDown(0.2);
    }
    doc.moveDown(0.6);
    const table = (heading: string, rows: string[][], widths: number[]) => {
      if (doc.y > doc.page.height - 160) doc.addPage();
      doc.font("Helvetica-Bold").fontSize(13).fillColor(INK).text(heading, 48);
      doc.moveDown(0.3);
      for (const [idx, row] of rows.entries()) {
        if (doc.y > doc.page.height - 70) doc.addPage();
        const y = doc.y; let x = 48;
        doc.font(idx === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(idx === 0 ? MUTED : INK);
        let h = 0;
        for (const [ci, cell] of row.entries()) { doc.text(cell, x, y, { width: widths[ci] - 6 }); h = Math.max(h, doc.y - y); x += widths[ci]; }
        doc.y = y + h + 3;
        doc.moveTo(48, doc.y - 1).lineTo(48 + widths.reduce((a, b) => a + b, 0), doc.y - 1).strokeColor("#e4e4e7").lineWidth(0.5).stroke();
      }
      doc.moveDown(0.8);
    };
    table("Key metrics", [["Metric", "Value"], ...keyMetrics(r).map(([k, v]) => [k, v])], [300, 200]);
    table("Outages by site (top 15)", [["Site", "Outages", "Downtime"], ...r.bySite.slice(0, 15).map((x) => [x.name, String(x.count), d(x.downtime)])], [260, 80, 160]);
    table("Outages by backhaul provider", [["Provider", "Outages", "Downtime"], ...r.byProvider.map((x) => [x.name, String(x.count), d(x.downtime)])], [260, 80, 160]);
    table("Outages by confirmed cause", [["Cause", "Outages", "Downtime"], ...r.byCause.map((x) => [x.name, String(x.count), d(x.downtime)])], [260, 80, 160]);
    table("Six-month trend", [["Month", "Outages", "Short interruptions", "Downtime (h)"], ...trendRows.map((t) => [t.month, String(t.outages), String(t.interruptions), String(t.downtimeHours)])], [120, 100, 140, 120]);
    if (r.rfoBacklog.length) table("RFO backlog", [["Incident", "Site", "Waiting"], ...r.rfoBacklog.map((x) => [x.reference, x.site, d(x.ageSec)])], [160, 200, 140]);
    doc.addPage();
    doc.font("Helvetica-Bold").fontSize(13).fillColor(INK).text("Metric definitions");
    doc.moveDown(0.3).font("Helvetica").fontSize(9.5);
    for (const [k, v, def] of keyMetrics(r)) if (def && r.definitions[def]) { doc.font("Helvetica-Bold").text(k).font("Helvetica").text(r.definitions[def]).moveDown(0.3); void v; }
    doc.end();
  });
}
