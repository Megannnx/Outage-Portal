"use client";
import clsx from "clsx";
import { useState } from "react";
import { Activity, MessageSquare, Radio, Truck, Wrench, Settings2, AlertTriangle, FileText, Send } from "lucide-react";
import { dateTime } from "@/lib/client";
import type { Detail } from "@/lib/types";
import { Card } from "@/components/ui";

const KINDS: Record<string, { label: string; icon: typeof Activity; cls: string }> = {
  monitoring: { label: "Monitoring", icon: Radio, cls: "text-warning" },
  cause: { label: "Service Desk", icon: MessageSquare, cls: "text-ink" },
  technical: { label: "Technical", icon: Wrench, cls: "text-ink" },
  communication: { label: "Communications", icon: Send, cls: "text-success" },
  delivery: { label: "Delivery", icon: Send, cls: "text-success" },
  dispatch: { label: "Dispatch", icon: Truck, cls: "text-primary-bright" },
  escalation: { label: "Escalations", icon: AlertTriangle, cls: "text-primary-bright" },
  rfo: { label: "RFO", icon: FileText, cls: "text-ink" },
  system: { label: "System", icon: Settings2, cls: "text-ink-muted" },
};

export function Timeline({ d }: { d: Detail }) {
  const [filter, setFilter] = useState<string | null>(null);
  const items = d.timeline.filter((t) => !filter || t.kind === filter || (filter === "communication" && t.kind === "delivery"));
  const present = [...new Set(d.timeline.map((t) => (t.kind === "delivery" ? "communication" : t.kind)))];
  return (
    <Card title="Live timeline" actions={
      <div className="flex flex-wrap gap-1">
        <Chip on={!filter} onClick={() => setFilter(null)}>All</Chip>
        {present.map((k) => <Chip key={k} on={filter === k} onClick={() => setFilter(k)}>{KINDS[k]?.label ?? k}</Chip>)}
      </div>}>
      <ol className="relative space-y-3 before:absolute before:bottom-1 before:left-[9px] before:top-1 before:w-px before:bg-line">
        {items.map((t) => {
          const k = KINDS[t.kind] ?? KINDS.system;
          const Icon = k.icon;
          const text = (t.data as { text?: string })?.text;
          return (
            <li key={t.id} className="relative pl-7">
              <span className={clsx("absolute left-0 top-0.5 grid h-5 w-5 place-items-center rounded-full border border-line bg-surface", k.cls)}><Icon size={11} /></span>
              <div className="flex flex-wrap items-baseline gap-x-2 text-2xs text-ink-muted"><span className="tabular font-semibold text-ink-secondary">{dateTime(t.at)}</span><span>{t.actorLabel}</span></div>
              <div className="text-[13px]">{t.summary}</div>
              {text && <pre className="mt-1 whitespace-pre-wrap rounded-md border border-line bg-background px-2 py-1.5 font-mono text-[12px] text-ink-secondary">{text}</pre>}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className={clsx("rounded px-1.5 py-0.5 text-2xs font-semibold", on ? "bg-surface-2 text-ink" : "text-ink-muted hover:text-ink")}>{children}</button>;
}
