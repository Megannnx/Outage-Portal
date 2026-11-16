"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { useState } from "react";
import { AlertTriangle, Moon, Sun, LogOut, Radio } from "lucide-react";
import { api, useApi, useLiveStatus, dateTime } from "@/lib/client";

type Meta = { deliveryMode: "live" | "capture"; workerOk: boolean; workerLastSeen: string | null; alerts: { id: string; severity: string; message: string; key: string }[]; health: { key: string; label: string; lastSuccessAt: string | null; lastErrorAt: string | null; lastError: string | null }[] };
const ROLE_LABEL = { service_desk: "Service Desk", technical: "Technical / NOC", admin: "Administrator" } as const;

export function AppShell({ user, children }: { user: { name: string; role: keyof typeof ROLE_LABEL }; children: React.ReactNode }) {
  const path = usePathname();
  const { data: meta } = useApi<Meta>("/api/meta", { live: true, interval: 30000 });
  const live = useLiveStatus();
  const [showAlerts, setShowAlerts] = useState(false);
  const nav = [
    { href: "/", label: "Operations" },
    { href: "/handover", label: "Handover" },
    ...(user.role === "admin" ? [{ href: "/reports", label: "Reports" }, { href: "/admin", label: "Admin" }] : []),
  ];
  const critical = meta?.alerts.filter((a) => a.severity === "critical") ?? [];
  const netxms = meta?.health.find((h) => h.key === "monitoring:netxms");
  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    document.cookie = `theme=${next}; path=/; max-age=31536000; samesite=lax`;
  }
  return (
    <div className="flex min-h-screen flex-col">
      {meta?.deliveryMode === "capture" && (
        <div className="no-print bg-primary px-4 py-1.5 text-center text-[12px] font-bold uppercase tracking-wider text-white">
          Capture mode — demo/test only. No email or client messages are leaving this system.
        </div>
      )}
      <header className="no-print sticky top-0 z-30 border-b border-line bg-background-alt/95 backdrop-blur">
        <div className="flex h-12 items-center gap-3 px-3 sm:px-4">
          <Link href="/" className="flex items-center gap-2 pr-2"><span className="h-5 w-1.5 rounded bg-primary" /><span className="text-[16px] font-extrabold tracking-tight">ATEC</span><span className="hidden text-[13px] text-ink-muted md:inline">Outage Operations</span></Link>
          <nav className="flex items-center gap-0.5 overflow-x-auto">
            {nav.map((n) => (
              <Link key={n.href} href={n.href} className={clsx("rounded-md px-2.5 py-1.5 text-[13px] font-semibold", (n.href === "/" ? path === "/" : path.startsWith(n.href)) ? "bg-surface-2 text-ink" : "text-ink-secondary hover:text-ink")}>{n.label}</Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <span title={`Live updates ${live ? "connected" : "reconnecting"} · Worker ${meta?.workerOk ? "running" : "NOT RUNNING"} · NetXMS last event ${dateTime(netxms?.lastSuccessAt)}`}
              className={clsx("hidden items-center gap-1.5 rounded-md border px-2 py-1 text-2xs font-semibold uppercase sm:flex", live && meta?.workerOk ? "border-success-edge text-success" : "border-primary-edge text-primary-bright")}>
              <Radio size={12} /> {!meta ? "…" : !meta.workerOk ? "Worker down" : live ? "Live" : "Reconnecting"}
            </span>
            {!!meta?.alerts.length && (
              <button onClick={() => setShowAlerts((v) => !v)} className={clsx("flex items-center gap-1 rounded-md border px-2 py-1 text-2xs font-bold", critical.length ? "border-primary bg-primary text-white" : "border-warning-edge text-warning")}>
                <AlertTriangle size={12} /> {meta.alerts.length}
              </button>
            )}
            <button aria-label="Toggle theme" onClick={toggleTheme} className="rounded-md p-1.5 text-ink-muted hover:text-ink"><Sun size={15} className="hidden [[data-theme=dark]_&]:block" /><Moon size={15} className="[[data-theme=dark]_&]:hidden" /></button>
            <div className="hidden text-right leading-tight sm:block"><div className="text-[12px] font-semibold">{user.name}</div><div className="text-2xs text-ink-muted">{ROLE_LABEL[user.role]}</div></div>
            <button aria-label="Sign out" onClick={async () => { await api("/api/auth/logout", { body: {} }); location.href = "/login"; }} className="rounded-md p-1.5 text-ink-muted hover:text-ink"><LogOut size={15} /></button>
          </div>
        </div>
        {meta && !meta.workerOk && (
          <div className="border-t border-primary bg-primary-tint px-4 py-1.5 text-[12px] font-semibold text-primary-bright">
            The background worker has not reported since {dateTime(meta.workerLastSeen)}. Validation timers, scheduled updates and deliveries are NOT running. Check the worker service.
          </div>
        )}
        {showAlerts && meta && (
          <div className="max-h-72 overflow-y-auto border-t border-line bg-surface px-4 py-2">
            {meta.alerts.map((a) => (
              <div key={a.id} className="flex items-start gap-2 border-b border-line py-1.5 text-[12.5px] last:border-0">
                <span className={clsx("mt-1 h-2 w-2 shrink-0 rounded-full", a.severity === "critical" ? "bg-primary" : a.severity === "warning" ? "bg-warning" : "bg-ink-muted")} />
                <span className="flex-1">{a.message}</span>
                {user.role === "admin" && <button className="text-2xs text-ink-muted hover:text-ink" onClick={() => api(`/api/alerts/${a.id}`, { body: {} })}>Dismiss</button>}
              </div>
            ))}
          </div>
        )}
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
