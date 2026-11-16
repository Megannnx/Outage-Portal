import { TZDate } from "@date-fns/tz";
import { DISPLAY_TZ } from "../lib/time";
import type { ReportFilters } from "./metrics";

/** ?month=2026-11  or  ?from=2026-11-01&to=2026-11-30 (inclusive, SAST) + optional filters. */
export function parseReportQuery(u: URL) {
  const p = u.searchParams;
  let from: Date, to: Date, label: string;
  const month = p.get("month");
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split("-").map(Number);
    from = new Date(new TZDate(y, m - 1, 1, 0, 0, 0, DISPLAY_TZ).getTime());
    to = new Date(new TZDate(y, m, 1, 0, 0, 0, DISPLAY_TZ).getTime());
    label = month;
  } else {
    const f = p.get("from"), t = p.get("to");
    const parse = (s: string | null, endOfDay: boolean) => {
      if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
      const [y, m, d] = s.split("-").map(Number);
      return new Date(new TZDate(y, m - 1, d + (endOfDay ? 1 : 0), 0, 0, 0, DISPLAY_TZ).getTime());
    };
    const now = new Date();
    from = parse(f, false) ?? new Date(now.getTime() - 30 * 86400_000);
    to = parse(t, true) ?? now;
    label = `${f ?? "last-30-days"}_${t ?? "now"}`;
  }
  const filters: ReportFilters = {
    from, to,
    estate: p.get("estate") || undefined, siteId: p.get("siteId") || undefined, providerId: p.get("providerId") || undefined,
    causeKey: p.get("causeKey") || undefined, team: p.get("team") || undefined, status: p.get("status") || undefined,
  };
  const span = to.getTime() - from.getTime();
  const prevFilters: ReportFilters = { ...filters, from: new Date(from.getTime() - span), to: from };
  return { filters, prevFilters, label };
}
