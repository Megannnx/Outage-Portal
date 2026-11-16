"use client";
import clsx from "clsx";
import { Fragment, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { useApi, duration, dateTime } from "@/lib/client";
import { Badge, Button, Card, ErrorNote, inputCls } from "@/components/ui";

type Row = { name: string; count: number; downtime: number };
type R = { report: any; previous: any; findings: { level: string; text: string }[]; trend: { month: string; outages: number; interruptions: number; downtimeHours: number }[] };

function thisMonth() { const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit" }).format(new Date()); return d.slice(0, 7); }

export function Reports() {
  const [month, setMonth] = useState(thisMonth());
  const [f, setF] = useState({ estate: "", siteId: "", providerId: "", causeKey: "", team: "" });
  const sites = useApi<{ items: any[] }>("/api/admin/sites").data?.items ?? [];
  const providers = useApi<{ items: any[] }>("/api/admin/providers").data?.items ?? [];
  const causes = useApi<{ items: any[] }>("/api/admin/causes").data?.items ?? [];
  const qs = useMemo(() => new URLSearchParams({ month, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) }).toString(), [month, f]);
  const { data, error, loading } = useApi<R>(`/api/reports?${qs}`);
  const s = data?.report.summary, p = data?.previous;
  const estates = [...new Set(sites.map((x) => x.estate).filter(Boolean))].sort();
  const teams = [...new Set(sites.map((x) => x.technicalTeam).filter(Boolean))].sort();
  return (
    <div className="mx-auto max-w-[1500px] space-y-4 p-4">
      <div className="flex flex-wrap items-end gap-2">
        <div><div className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">Month</div><input type="month" className={inputCls} value={month} onChange={(e) => setMonth(e.target.value)} /></div>
        <Sel label="Estate" v={f.estate} on={(estate) => setF({ ...f, estate })} opts={estates.map((e) => [e, e])} />
        <Sel label="Site" v={f.siteId} on={(siteId) => setF({ ...f, siteId })} opts={sites.map((x) => [x.id, `${x.code} ${x.name}`])} />
        <Sel label="Backhaul provider" v={f.providerId} on={(providerId) => setF({ ...f, providerId })} opts={providers.map((x) => [x.id, x.name])} />
        <Sel label="Cause" v={f.causeKey} on={(causeKey) => setF({ ...f, causeKey })} opts={causes.map((x) => [x.key, x.label])} />
        <Sel label="Team" v={f.team} on={(team) => setF({ ...f, team })} opts={teams.map((t) => [t, t])} />
        <div className="ml-auto flex gap-2">
          {(["pdf", "xlsx", "csv"] as const).map((fmt) => <a key={fmt} href={`/api/reports/export?format=${fmt}&${qs}`}><Button size="sm"><Download size={13} /> {fmt.toUpperCase()}</Button></a>)}
        </div>
      </div>
      <ErrorNote error={error} />
      {loading && !data && <div className="text-ink-muted">Calculating from recorded events…</div>}
      {data && s && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            <M label="Qualifying outages" v={s.qualifyingOutages} prev={p?.qualifyingOutages} lowerBetter />
            <M label="Affected sites" v={s.affectedSites} />
            <M label="Total downtime" v={duration(s.totalDowntimeSec, true)} />
            <M label="MTRS" v={duration(s.mtrsSec, true)} title={data.report.definitions.mtrs} />
            <M label="First message after" v={duration(s.detectionToFirstCommSec)} title={data.report.definitions.detectionToFirstComm} />
            <M label="2-hour compliance" v={s.intervalCompliancePct == null ? "n/a" : `${s.intervalCompliancePct.toFixed(1)}%`} tone={s.intervalCompliancePct != null && s.intervalCompliancePct < 95 ? "red" : "green"} title={data.report.definitions.intervalCompliance} />
            <M label="Delivery success" v={s.deliverySuccessPct == null ? "n/a" : `${s.deliverySuccessPct.toFixed(1)}%`} tone={s.deliverySuccessPct != null && s.deliverySuccessPct < 98 ? "red" : "green"} title={data.report.definitions.deliverySuccess} />
            <M label="Awaiting RFO" v={s.awaitingRfo} tone={s.awaitingRfo ? "amber" : undefined} />
          </div>
          <Card title="Findings & recommended actions">
            <ul className="space-y-1.5 text-[13.5px]">{data.findings.map((x, i) => <li key={i} className="flex gap-2"><Badge tone={x.level === "action" ? "red" : x.level === "attention" ? "amber" : "grey"}>{x.level}</Badge><span>{x.text}</span></li>)}</ul>
          </Card>
          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            <Card title="Monthly trend (6 months)"><Trend rows={data.trend} /></Card>
            <Card title="Outages by site"><Bars rows={data.report.bySite} /></Card>
            <Card title="Downtime by backhaul provider"><Bars rows={data.report.byProvider} by="downtime" /></Card>
            <Card title="Outage causes"><Bars rows={data.report.byCause} /></Card>
            <Card title="Restoration duration"><Bars rows={data.report.downtimeDistribution.map((d: any) => ({ name: d.label, count: d.count, downtime: 0 }))} /></Card>
            <Card title="Recurring problem sites">
              {data.report.repeatSites.length || data.report.interruptionsBySite.length ? (
                <ul className="space-y-1 text-[13px]">
                  {data.report.repeatSites.map((x: Row) => <li key={x.name}><b>{x.name}</b> — {x.count} outages, {duration(x.downtime, true)}</li>)}
                  {data.report.interruptionsBySite.map((x: any) => <li key={`i-${x.name}`} className="text-ink-secondary">{x.name} — {x.count} short interruption(s)</li>)}
                </ul>
              ) : <div className="text-[13px] text-ink-muted">No repeat outages this period.</div>}
            </Card>
          </div>
          <div className="grid gap-3 lg:grid-cols-3">
            <Card title="Restoration"><Kv rows={[["MTRS", duration(s.mtrsSec, true)], ["MTTR", s.mttrSample ? `${duration(s.mttrSec, true)} (n=${s.mttrSample})` : "Not measurable"], ["Average / median", `${duration(s.avgDowntimeSec, true)} / ${duration(s.medianDowntimeSec, true)}`], ["Longest / shortest", `${duration(s.longestSec, true)} / ${duration(s.shortestSec, true)}`], ["Restore → RFO", duration(s.restoreToRfoSec, true)], ["RFO → final message", duration(s.rfoToFinalSec, true)], ["Short interruptions", s.interruptions]]} /></Card>
            <Card title="Communications"><Kv rows={[["Initial messages", s.initialComms], ["Immediate technical updates", s.immediateTechnicalUpdates], ["Scheduled no-update messages", s.scheduledUpdates], ["Average / max interval", `${s.avgIntervalMin == null ? "n/a" : `${Math.round(s.avgIntervalMin)} min`} / ${s.maxIntervalMin == null ? "n/a" : `${Math.round(s.maxIntervalMin)} min`}`], ["Missed deadlines", s.missedDeadlines], ["Failed deliveries", s.failedSends], ["No confirmed cause", s.noConfirmedCause]]} /></Card>
            <Card title="Workflow"><Kv rows={[["Time to confirm cause", duration(s.causeConfirmationSec, true)], ["Dispatches", s.dispatchIncidents], ["Server-room → dispatch", duration(s.dispatchCreationSec, true)], ["Dispatch → acknowledged", duration(s.dispatchAckSec, true)], ["Validation → first tech update", duration(s.firstTechUpdateSec, true)], ["Tech updates per incident", s.techUpdatesPerIncident?.toFixed(1) ?? "n/a"], ["Escalated incidents", s.escalatedIncidents]]} /></Card>
          </div>
          {data.report.rfoBacklog.length > 0 && <Card title="RFO backlog"><ul className="text-[13px]">{data.report.rfoBacklog.map((x: any) => <li key={x.reference}><span className="font-mono">{x.reference}</span> {x.site} — waiting {duration(x.ageSec, true)}</li>)}</ul></Card>}
          <Card title={`Incidents (${data.report.incidents.length})`}>
            <div className="overflow-x-auto"><table className="w-full text-[12.5px]">
              <thead className="text-left text-2xs uppercase text-ink-muted"><tr>{["Ref", "Site", "Cause", "Status", "Start", "Restored", "Downtime", "Msgs", "RFO"].map((h) => <th key={h} className="px-2 py-1">{h}</th>)}</tr></thead>
              <tbody>{data.report.incidents.map((i: any) => (
                <tr key={i.reference} className="border-t border-line"><td className="px-2 py-1 font-mono">{i.reference}</td><td className="px-2">{i.site}</td><td className="px-2">{i.cause}</td><td className="px-2">{i.status.replace(/_/g, " ")}</td><td className="px-2">{dateTime(i.start)}</td><td className="px-2">{dateTime(i.restored)}</td><td className="px-2">{duration(i.downtimeSec, true)}</td><td className="px-2">{i.comms}</td><td className="px-2">{i.rfo}</td></tr>
              ))}</tbody>
            </table></div>
          </Card>
          <details className="text-[12.5px] text-ink-secondary"><summary className="cursor-pointer font-semibold">How each metric is calculated</summary><dl className="mt-2 space-y-1">{Object.entries(data.report.definitions).map(([k, v]) => <div key={k}><dt className="font-semibold text-ink">{k}</dt><dd>{v as string}</dd></div>)}</dl></details>
        </>
      )}
    </div>
  );
}

function Sel({ label, v, on, opts }: { label: string; v: string; on: (v: string) => void; opts: [string, string][] }) {
  return <div><div className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">{label}</div><select className={clsx(inputCls, "max-w-[200px]")} value={v} onChange={(e) => on(e.target.value)}><option value="">All</option>{opts.map(([a, b]) => <option key={a} value={a}>{b}</option>)}</select></div>;
}
function M({ label, v, prev, tone, title, lowerBetter }: { label: string; v: React.ReactNode; prev?: number; tone?: "red" | "green" | "amber"; title?: string; lowerBetter?: boolean }) {
  const delta = typeof v === "number" && typeof prev === "number" ? v - prev : null;
  return (
    <div title={title} className="rounded-xl border border-line bg-surface px-3 py-2.5">
      <div className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">{label}</div>
      <div className={clsx("tabular text-[22px] font-extrabold", tone === "red" && "text-primary-bright", tone === "green" && "text-success", tone === "amber" && "text-warning")}>{v}</div>
      {delta != null && <div className={clsx("text-2xs", delta === 0 ? "text-ink-muted" : (delta > 0) === !!lowerBetter ? "text-primary-bright" : "text-success")}>{delta > 0 ? "+" : ""}{delta} vs previous</div>}
    </div>
  );
}
function Bars({ rows, by = "count" }: { rows: Row[]; by?: "count" | "downtime" }) {
  if (!rows.length || rows.every((r) => !r[by])) return <div className="text-[13px] text-ink-muted">No data for this period.</div>;
  const max = Math.max(...rows.map((r) => r[by]));
  return (
    <ul className="space-y-1.5">{rows.slice(0, 10).map((r) => (
      <li key={r.name} className="text-[12.5px]">
        <div className="flex justify-between gap-2"><span className="truncate">{r.name}</span><span className="tabular text-ink-secondary">{by === "count" ? r.count : duration(r.downtime, true)}</span></div>
        <div className="mt-0.5 h-1.5 rounded bg-surface-2"><div className="h-1.5 rounded bg-primary" style={{ width: `${(100 * r[by]) / max}%` }} /></div>
      </li>
    ))}</ul>
  );
}
function Trend({ rows }: { rows: R["trend"] }) {
  const max = Math.max(1, ...rows.map((r) => r.outages + r.interruptions));
  return (
    <div>
      <div className="flex h-40 items-end gap-2">{rows.map((r) => (
        <div key={r.month} className="flex flex-1 flex-col items-center gap-1" title={`${r.outages} outages, ${r.interruptions} short interruptions, ${r.downtimeHours} h downtime`}>
          <div className="tabular text-2xs text-ink-secondary">{r.outages}</div>
          <div className="flex w-full flex-col justify-end" style={{ height: 120 }}>
            <div className="w-full rounded-t bg-ink-muted/40" style={{ height: `${(100 * r.interruptions) / max}%` }} />
            <div className="w-full bg-primary" style={{ height: `${(100 * r.outages) / max}%` }} />
          </div>
          <div className="text-2xs text-ink-muted">{r.month.slice(5)}</div>
        </div>
      ))}</div>
      <div className="mt-2 flex gap-3 text-2xs text-ink-muted"><span><span className="mr-1 inline-block h-2 w-2 bg-primary" />Outages</span><span><span className="mr-1 inline-block h-2 w-2 bg-ink-muted/40" />Short interruptions</span></div>
    </div>
  );
}
function Kv({ rows }: { rows: [string, React.ReactNode][] }) {
  return <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-[13px]">{rows.map(([k, v]) => <Fragment key={k}><dt className="text-ink-secondary">{k}</dt><dd className="tabular text-right font-semibold">{v}</dd></Fragment>)}</dl>;
}
