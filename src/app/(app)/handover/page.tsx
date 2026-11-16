"use client";
import { useApi, dateTime, duration, humanize } from "@/lib/client";
import { Badge, Button, Card, StatusBadge } from "@/components/ui";

export default function Handover() {
  const { data } = useApi<any>("/api/handover", { live: true });
  if (!data) return <div className="p-6 text-ink-muted">Preparing handover…</div>;
  const row = (x: any) => (
    <tr key={x.id} className="border-t border-line align-top">
      <td className="py-1.5 pr-3"><a href={`/?i=${x.id}`} className="font-semibold underline">{x.siteName}</a><div className="font-mono text-2xs text-ink-muted">{x.reference}</div></td>
      <td className="pr-3"><StatusBadge status={x.status} /></td>
      <td className="tabular pr-3">{duration(x.restoredAt ? x.downtimeSeconds : (Date.now() - new Date(x.outageStartedAt).getTime()) / 1000, true)}</td>
      <td className="pr-3">{x.cause ?? <span className="text-primary-bright">not confirmed</span>}</td>
      <td className="pr-3 text-[12px]">{x.actions.map((a: any) => <div key={a.label}>{a.label}</div>)}</td>
      <td className="text-[12px]">{x.nextCommAt ? dateTime(x.nextCommAt) : "—"}{x.eta && <div>ETA {dateTime(x.eta)}</div>}</td>
    </tr>
  );
  const table = (rows: any[]) => rows.length ? (
    <table className="w-full text-[13px]"><thead className="text-left text-2xs uppercase text-ink-muted"><tr><th>Site</th><th>Status</th><th>Duration</th><th>Cause</th><th>Outstanding</th><th>Next update</th></tr></thead><tbody>{rows.map(row)}</tbody></table>
  ) : <div className="text-[13px] text-ink-muted">None.</div>;
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div><h1 className="text-[20px] font-extrabold">Shift handover</h1><div className="text-[12px] text-ink-muted">Live as of {dateTime(data.generatedAt)} — updates automatically</div></div>
        <Button className="no-print" onClick={() => window.print()}>Print</Button>
      </div>
      {data.alerts.length > 0 && <Card title="System alerts" tone="danger"><ul className="space-y-1 text-[13px]">{data.alerts.map((a: any) => <li key={a.id}><Badge tone={a.severity === "critical" ? "red" : "amber"}>{a.severity}</Badge> {a.message}</li>)}</ul></Card>}
      <Card title={`Needs action (${data.needsAction.length})`}>{table(data.needsAction)}</Card>
      <Card title={`Active outages (${data.active.length})`}>{table(data.active)}</Card>
      <Card title={`Technician dispatches open (${data.dispatches.length})`}>
        {data.dispatches.length ? <ul className="space-y-1 text-[13px]">{data.dispatches.map((d: any) => <li key={d.id}><b className="font-mono">{d.reference}</b> {d.siteName} ({d.incidentReference}) — {humanize(d.status)}{d.acknowledgedBy && ` by ${d.acknowledgedBy}`} · logged {dateTime(d.requestedAt)}</li>)}</ul> : <div className="text-[13px] text-ink-muted">None.</div>}
      </Card>
      <Card title={`Communication problems (${data.commProblems.length})`}>{table(data.commProblems)}</Card>
      <Card title={`Awaiting RFO (${data.awaitingRfo.length})`}>{table(data.awaitingRfo)}</Card>
    </div>
  );
}
