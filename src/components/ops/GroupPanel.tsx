"use client";
import { api, humanize } from "@/lib/client";
import type { Detail, Role } from "@/lib/types";
import { Badge, Button, Card } from "@/components/ui";
import { Link2 } from "lucide-react";

export function GroupPanel({ d, role, onSelect, onDone }: { d: Detail; role: Role; onSelect: (id: string) => void; onDone: () => void }) {
  if (!d.group && !d.suggestions.length) return null;
  const decide = async (id: string, accept: boolean) => { try { await api(`/api/correlations/${id}`, { body: { accept } }); onDone(); } catch (e) { alert((e as Error).message); } };
  return (
    <Card title={<span className="flex items-center gap-1"><Link2 size={13} /> Related outages</span>}>
      {d.group && (
        <div className="space-y-1 text-[13px]">
          <div><b>{d.group.reference}</b> · {d.group.label}</div>
          <div className="flex flex-wrap gap-1">{d.group.members.map((m) => <button key={m.id} onClick={() => onSelect(m.id)}><Badge tone={m.id === d.incident.id ? "solid" : "grey"}>{m.siteName} · {humanize(m.phase)}</Badge></button>)}</div>
          <div className="text-2xs text-ink-muted">Each site keeps its own downtime and residents. ISPs receive one combined message for technical updates.</div>
        </div>
      )}
      {d.suggestions.map((s) => (
        <div key={s.id} className="mt-2 rounded-lg border border-warning-edge bg-warning-tint p-2.5 text-[13px]">
          <div className="font-semibold">Possible common cause: {s.reason}</div>
          <div className="my-1 flex flex-wrap gap-1">{s.members.map((m) => <Badge key={m.id}>{m.siteName}</Badge>)}</div>
          {role !== "service_desk" && <div className="flex gap-2"><Button size="sm" variant="primary" onClick={() => decide(s.id, true)}>Link these outages</Button><Button size="sm" variant="ghost" onClick={() => decide(s.id, false)}>Not related</Button></div>}
        </div>
      ))}
    </Card>
  );
}
