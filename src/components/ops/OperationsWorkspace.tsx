"use client";
import clsx from "clsx";
import { useEffect, useMemo, useState } from "react";
import { Search, ArrowLeft, Zap, Clock, Mail, AlertTriangle } from "lucide-react";
import { useApi, useNow, duration, dateTime, time, humanize } from "@/lib/client";
import { Badge, StatusBadge, Empty } from "@/components/ui";
import { IncidentWorkspace } from "./IncidentWorkspace";
import type { IncidentListItem } from "@/server/queries";

type Role = "service_desk" | "technical" | "admin";
type L = Omit<IncidentListItem, "outageStartedAt" | "restoredAt" | "nextCommAt" | "lastComm" | "lastTechnicalUpdateAt"> & {
  outageStartedAt: string; restoredAt: string | null; nextCommAt: string | null; lastTechnicalUpdateAt: string | null;
  lastComm: { kind: string; at: string; status: string } | null;
};

const SCOPES: { key: string; label: string; roles: Role[] }[] = [
  { key: "open", label: "All open", roles: ["service_desk", "technical", "admin"] },
  { key: "mine", label: "Technical queue", roles: ["technical", "admin"] },
  { key: "rfo", label: "Awaiting RFO", roles: ["service_desk", "technical", "admin"] },
  { key: "recent", label: "Last 7 days", roles: ["service_desk", "technical", "admin"] },
];

export function OperationsWorkspace({ role }: { role: Role }) {
  const [scope, setScope] = useState(role === "technical" ? "mine" : "open");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [needsActionOnly, setNeedsActionOnly] = useState(false);
  useEffect(() => { const i = new URLSearchParams(location.search).get("i"); if (i) setSelected(i); }, []);
  useEffect(() => { const u = new URL(location.href); if (selected) u.searchParams.set("i", selected); else u.searchParams.delete("i"); history.replaceState(null, "", u); }, [selected]);
  const { data, loading, error } = useApi<{ incidents: L[] }>(`/api/incidents?scope=${scope}${q ? `&q=${encodeURIComponent(q)}` : ""}`, { live: true, interval: 60000 });
  const now = useNow(1000);
  const all = data?.incidents ?? [];
  const mineActs = (x: L) => x.actions.filter((a) => role === "admin" || a.who === role);
  const list = needsActionOnly ? all.filter((x) => mineActs(x).length) : all;

  const kpi = useMemo(() => ({
    action: all.filter((x) => mineActs(x).some((a) => a.urgency !== "normal")).length,
    active: all.filter((x) => ["active", "restoring"].includes(x.phase)).length,
    validating: all.filter((x) => x.phase === "validating").length,
    rfo: all.filter((x) => x.phase === "awaiting_rfo").length,
    comms: all.filter((x) => x.commHealth !== "ok").length,
    next: all.filter((x) => x.nextCommAt).map((x) => new Date(x.nextCommAt!).getTime()).sort((a, b) => a - b)[0],
  }), [all]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea, select")) return;
      if (e.key === "/") { e.preventDefault(); document.getElementById("incident-search")?.focus(); }
      if (e.key === "Escape") setSelected(null);
      if (e.key === "j" || e.key === "k") {
        const idx = list.findIndex((x) => x.id === selected);
        const n = list[Math.max(0, Math.min(list.length - 1, idx + (e.key === "j" ? 1 : -1)))];
        if (n) setSelected(n.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [list, selected]);

  return (
    <div className="flex h-[calc(100vh-48px)] flex-col">
      <div className={clsx("grid grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-5", selected && "hidden lg:grid")}>
        <Kpi label="Need your action" value={kpi.action} tone={kpi.action ? "red" : undefined} onClick={() => setNeedsActionOnly((v) => !v)} active={needsActionOnly} />
        <Kpi label="Active outages" value={kpi.active} tone={kpi.active ? "red" : undefined} />
        <Kpi label="Validating (< 3 min)" value={kpi.validating} tone={kpi.validating ? "amber" : undefined} />
        <Kpi label="Awaiting RFO" value={kpi.rfo} onClick={() => setScope("rfo")} />
        <Kpi label={kpi.comms ? "Comms problems" : "Next customer update"} value={kpi.comms ? kpi.comms : kpi.next ? duration((kpi.next - now) / 1000, true) : "—"} tone={kpi.comms ? "red" : undefined} />
      </div>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[400px_1fr]">
        <aside className={clsx("flex min-h-0 flex-col border-r border-line", selected && "hidden lg:flex")}>
          <div className="space-y-2 border-b border-line p-3">
            <div className="relative">
              <Search size={15} className="absolute left-2.5 top-2.5 text-ink-muted" />
              <input id="incident-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search site, estate, incident, circuit…  ( / )" aria-label="Search incidents"
                className="w-full rounded-lg border border-line bg-background py-2 pl-8 pr-3 text-[13px] placeholder:text-ink-muted focus:border-ink-muted focus:outline-none" />
            </div>
            <div className="flex flex-wrap gap-1">
              {SCOPES.filter((s) => s.roles.includes(role)).map((s) => (
                <button key={s.key} onClick={() => setScope(s.key)} className={clsx("rounded-md border px-2 py-1 text-[12px] font-semibold", scope === s.key ? "border-ink-muted bg-surface-2 text-ink" : "border-transparent text-ink-secondary hover:text-ink")}>{s.label}</button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Incidents">
            {loading && !data && <div className="p-4 text-[13px] text-ink-muted">Loading incidents…</div>}
            {error && <div className="p-4 text-[13px] text-primary-bright">{error.message}</div>}
            {data && !list.length && <div className="p-4"><Empty>{needsActionOnly ? "Nothing needs your action right now." : scope === "mine" ? "No incidents assigned to Technical." : "No open incidents. All monitored sites are up."}</Empty></div>}
            {list.map((x) => <Row key={x.id} x={x} role={role} now={now} selected={selected === x.id} onSelect={() => setSelected(x.id)} />)}
          </div>
        </aside>
        <section className={clsx("min-h-0 overflow-y-auto", !selected && "hidden lg:block")}>
          {selected ? (
            <>
              <button onClick={() => setSelected(null)} className="flex items-center gap-1 px-3 pt-3 text-[13px] text-ink-secondary lg:hidden"><ArrowLeft size={14} /> All incidents</button>
              <IncidentWorkspace id={selected} role={role} onSelect={setSelected} />
            </>
          ) : (
            <div className="grid h-full place-items-center p-8 text-center text-ink-muted">
              <div className="max-w-sm space-y-2">
                <div className="text-[15px] font-semibold text-ink-secondary">Select an incident</div>
                <p className="text-[13px]">Incidents needing action are at the top. Customer updates are sent automatically — you only confirm causes, enter verified updates and log urgent dispatches.</p>
                <p className="text-2xs">Keys: <kbd>/</kbd> search · <kbd>j</kbd>/<kbd>k</kbd> next/previous · <kbd>Esc</kbd> close</p>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Kpi({ label, value, tone, onClick, active }: { label: string; value: number | string; tone?: "red" | "amber"; onClick?: () => void; active?: boolean }) {
  const C = onClick ? "button" : "div";
  return (
    <C onClick={onClick} className={clsx("bg-background-alt px-4 py-2.5 text-left", onClick && "hover:bg-surface", active && "bg-surface ring-1 ring-inset ring-primary")}>
      <div className="text-2xs font-semibold uppercase tracking-wider text-ink-muted">{label}</div>
      <div className={clsx("tabular text-[22px] font-extrabold leading-tight", tone === "red" ? "text-primary-bright" : tone === "amber" ? "text-warning" : "text-ink")}>{value}</div>
    </C>
  );
}

function Row({ x, role, now, selected, onSelect }: { x: L; role: Role; now: number; selected: boolean; onSelect: () => void }) {
  const acts = x.actions.filter((a) => role === "admin" || a.who === role);
  const urgent = acts.some((a) => a.urgency === "urgent");
  const elapsed = x.restoredAt ? x.downtimeSeconds ?? (new Date(x.restoredAt).getTime() - new Date(x.outageStartedAt).getTime()) / 1000 : (now - new Date(x.outageStartedAt).getTime()) / 1000;
  const next = x.nextCommAt ? (new Date(x.nextCommAt).getTime() - now) / 1000 : null;
  const bar = urgent ? "bg-primary" : x.linkUp ? "bg-success" : x.phase === "validating" ? "bg-warning" : "bg-primary/60";
  return (
    <button role="option" aria-selected={selected} onClick={onSelect} className={clsx("relative block w-full border-b border-line py-2.5 pl-4 pr-3 text-left hover:bg-surface", selected && "bg-surface-2")}>
      <span className={clsx("absolute inset-y-0 left-0 w-1", bar)} />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5"><span className="truncate text-[14px] font-bold">{x.siteName}</span><span className="text-2xs text-ink-muted">{x.siteCode}</span></div>
          <div className="truncate text-[12px] text-ink-secondary">{x.estate || "—"} · <span className="font-mono">{x.reference}</span></div>
        </div>
        <div className="text-right">
          <div className={clsx("tabular text-[14px] font-bold", x.linkUp ? "text-success" : "text-ink")}>{duration(elapsed, true)}</div>
          <div className="text-2xs text-ink-muted">{x.linkUp ? "restored" : "offline"}</div>
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <StatusBadge status={x.status} />
        {x.cause && <Badge>{x.cause}</Badge>}
        {x.flapCount > 0 && <Badge tone="amber">Flapping ×{x.flapCount}</Badge>}
        {x.commHealth !== "ok" && <Badge tone="red"><Mail size={10} /> {x.commHealth}</Badge>}
        {x.openEscalations > 0 && <Badge tone="red"><AlertTriangle size={10} /> {x.openEscalations}</Badge>}
      </div>
      {acts.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {acts.map((a) => (
            <span key={a.label} className={clsx("rounded px-1.5 py-0.5 text-2xs font-bold uppercase", a.urgency === "urgent" ? "pulse-red bg-primary text-white" : a.urgency === "high" ? "bg-primary-tint text-primary-bright" : "bg-surface-2 text-ink-secondary")}>
              <Zap size={9} className="mr-0.5 inline" />{a.label}
            </span>
          ))}
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-3 text-2xs text-ink-muted">
        {x.lastComm && <span title={`Last: ${humanize(x.lastComm.kind)}`}><Mail size={10} className="mr-0.5 inline" />{humanize(x.lastComm.kind)} {time(x.lastComm.at)}</span>}
        {next != null && <span className={clsx(next < 0 && "font-bold text-primary-bright")}><Clock size={10} className="mr-0.5 inline" />next {next < 0 ? `overdue ${duration(-next, true)}` : `in ${duration(next, true)}`}</span>}
        {x.eta && <span>ETA {dateTime(x.eta)}</span>}
      </div>
    </button>
  );
}
