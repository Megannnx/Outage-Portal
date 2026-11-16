"use client";
import clsx from "clsx";
import { useState } from "react";
import { Mail, Clock } from "lucide-react";
import { dateTime, duration, humanize, useNow } from "@/lib/client";
import type { Detail } from "@/lib/types";
import { Badge, Card, MessagePreview, type Tone } from "@/components/ui";

const TONE: Record<string, Tone> = { sent: "green", sending: "amber", queued: "amber", partially_failed: "red", failed: "red", cancelled: "grey", no_recipients: "red" };

export function CommsPanel({ d }: { d: Detail }) {
  const [open, setOpen] = useState<string | null>(null);
  const now = useNow(1000);
  const s = d.schedule;
  const latest = d.communications.find((c) => c.audience === "resident" && ["sent", "sending", "partially_failed"].includes(c.status));
  return (
    <Card title={<span className="flex items-center gap-1"><Mail size={13} /> Customer communications</span>}>
      <div className="space-y-3">
        <div className={clsx("flex items-center justify-between rounded-lg border px-3 py-2", s?.active && s.nextDueAt && new Date(s.nextDueAt).getTime() < now ? "border-primary bg-primary-tint" : "border-line bg-background")}>
          <div className="flex items-center gap-2 text-[13px]"><Clock size={14} className="text-ink-muted" />
            {s?.active && s.nextDueAt ? <span>Next automatic update <b className="tabular">{dateTime(s.nextDueAt)}</b></span>
              : d.incident.phase === "validating" ? <span>First message after validation</span>
              : <span className="text-ink-secondary">Automatic updates stopped{s?.stoppedReason ? ` — ${s.stoppedReason}` : ""}</span>}
          </div>
          {s?.active && s.nextDueAt && <span className="tabular text-[13px] font-bold">{new Date(s.nextDueAt).getTime() < now ? "OVERDUE" : duration((new Date(s.nextDueAt).getTime() - now) / 1000)}</span>}
        </div>
        {latest && <MessagePreview label={<>Latest sent · {humanize(latest.kind)} · {dateTime(latest.sentAt ?? latest.createdAt)}</>} subject={latest.subject} body={latest.body} />}
        <ul className="divide-y divide-line rounded-lg border border-line">
          {d.communications.length === 0 && <li className="px-3 py-3 text-[13px] text-ink-muted">Nothing sent yet.</li>}
          {d.communications.map((c) => {
            const ok = c.deliveries.filter((x) => ["accepted", "delivered"].includes(x.status)).length;
            const bad = c.deliveries.filter((x) => ["failed", "bounced"].includes(x.status)).length;
            return (
              <li key={c.id}>
                <button className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold">{humanize(c.kind)} <span className="font-normal text-ink-muted">→ {c.audience === "isp" ? "ISPs" : "residents"}</span></span>
                    <span className="block text-2xs text-ink-muted">{dateTime(c.sentAt ?? c.createdAt)} · {humanize(c.purpose)} · {ok}/{c.deliveries.filter((x) => x.status !== "suppressed").length} accepted{bad ? ` · ${bad} failed` : ""}</span>
                  </span>
                  <Badge tone={TONE[c.status] ?? "grey"}>{humanize(c.status)}</Badge>
                </button>
                {open === c.id && (
                  <div className="space-y-2 px-3 pb-3">
                    {c.cancelledReason && <div className="text-2xs text-ink-muted">Cancelled: {c.cancelledReason}</div>}
                    <MessagePreview subject={c.subject} body={c.body} />
                    <table className="w-full text-2xs">
                      <tbody>{c.deliveries.map((x) => (
                        <tr key={x.id} className="border-t border-line"><td className="py-1 pr-2 font-mono">{x.address}</td><td className="pr-2">{humanize(x.status)}{x.attempts > 1 ? ` (${x.attempts} tries)` : ""}</td><td className="text-ink-muted">{x.error}</td></tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}
