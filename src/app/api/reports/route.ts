import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { buildReport, findings, trend } from "@/server/reports/metrics";
import { parseReportQuery } from "@/server/reports/query";
export const dynamic = "force-dynamic";
export const GET = route({ perm: "reports.view" }, async ({ req }) => {
  const db = getDb();
  const { filters, prevFilters } = parseReportQuery(new URL(req.url));
  const [r, prev, t] = await Promise.all([buildReport(db, filters), buildReport(db, prevFilters), trend(db, filters.to)]);
  return { report: r, previous: prev.summary, findings: findings(r, prev), trend: t };
});
