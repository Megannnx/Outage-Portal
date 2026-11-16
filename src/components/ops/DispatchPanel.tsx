"use client";
import clsx from "clsx";
import { useState } from "react";
import { Truck } from "lucide-react";
import { api, dateTime, duration, humanize, useNow } from "@/lib/client";
import type { Detail, Role } from "@/lib/types";
import { Badge, Button, Card, ErrorNote, Field, Modal, inputCls } from "@/components/ui";

export function DispatchPanel({ d, role, onDone }: { d: Detail; role: Role; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(""); const [ext, setExt] = useState("");
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [ackUrl, setAckUrl] = useState<string | null>(null);
  const now = useNow(15000);
  const i = d.incident;
  const cause = d.causeOptions.find((c) => c.key === i.causeKey);
  const active = d.dispatches.find((x) => !["cancelled", "completed"].includes(x.status));
  const needs = cause?.requiresDispatch && !active && i.phase === "active";
  const isOpen = ["validating", "active", "restoring"].includes(i.phase);
  if (!needs && !d.dispatches.length && !(isOpen && role !== "technical")) return null;

  async function create() {
    setBusy(true); setErr(null);
    try { const r = await api<{ ackUrl: string }>(`/api/incidents/${i.id}/dispatch`, { body: { notes: notes || undefined, externalRef: ext || undefined } }); setAckUrl(r.ackUrl); onDone(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function setStatus(id: string, status: string) {
    try { await api(`/api/dispatches/${id}`, { body: { status } }); onDone(); } catch (e) { alert((e as Error).message); }
  }
  return (
    <Card title={<span className="flex items-center gap-1"><Truck size={13} /> Technician dispatch</span>} tone={needs ? "danger" : undefined}>
      {needs && (
        <Button variant="danger" size="xl" className="pulse-red mb-2 w-full justify-center text-center" onClick={() => { setOpen(true); setAckUrl(null); }}>
          <span className="text-[15px] font-extrabold uppercase tracking-wide">URGENT: Log a technician to investigate on site</span>
        </Button>
      )}
      {!needs && !active && isOpen && role !== "technical" && <Button size="sm" onClick={() => { setOpen(true); setAckUrl(null); }}>Log technician dispatch</Button>}
      <ul className="space-y-2">
        {d.dispatches.map((x) => {
          const waiting = ["requested", "sent"].includes(x.status);
          return (
            <li key={x.id} className={clsx("rounded-lg border p-2.5 text-[13px]", waiting ? "border-primary-edge bg-primary-tint" : "border-line")}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono font-bold">{x.reference}</span>
                <Badge tone={waiting ? "red" : x.status === "cancelled" ? "grey" : "green"}>{humanize(x.status === "sent" ? "sent — not acknowledged" : x.status)}</Badge>
              </div>
              <div className="mt-1 text-2xs text-ink-muted">
                Logged {dateTime(x.requestedAt)} · {x.sentAt ? `team notified ${dateTime(x.sentAt)}` : "notification pending"}
                {waiting && <> · <b className="text-primary-bright">unacknowledged {duration((now - new Date(x.requestedAt).getTime()) / 1000, true)}</b></>}
                {x.acknowledgedAt && <> · acknowledged by {x.acknowledgedBy} {dateTime(x.acknowledgedAt)}</>}
                {x.onSiteAt && <> · on site {dateTime(x.onSiteAt)}</>}
              </div>
              {!["completed", "cancelled"].includes(x.status) && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {waiting && <Button size="sm" onClick={() => setStatus(x.id, "acknowledged")}>Mark acknowledged</Button>}
                  {x.status !== "on_site" && <Button size="sm" onClick={() => setStatus(x.id, "on_site")}>On site</Button>}
                  <Button size="sm" onClick={() => setStatus(x.id, "completed")}>Completed</Button>
                  <Button size="sm" variant="ghost" onClick={() => confirm("Cancel this dispatch?") && setStatus(x.id, "cancelled")}>Cancel</Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <Modal open={open} onClose={() => setOpen(false)} title="URGENT technician dispatch" wide
        footer={ackUrl ? <Button variant="primary" onClick={() => setOpen(false)}>Done</Button> : <><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="danger" size="lg" disabled={busy} onClick={create}>{busy ? "Logging…" : "Log dispatch & notify team"}</Button></>}>
        {ackUrl ? (
          <div className="space-y-2 text-[13px]">
            <div className="font-semibold text-success">Dispatch logged. The technical team is being emailed now.</div>
            <p>The technician acknowledges using the link in the email. If nobody acknowledges in time, the portal escalates automatically.</p>
            <code className="block break-all rounded bg-background p-2 text-2xs">{ackUrl}</code>
          </div>
        ) : (
          <div className="space-y-3">
            <ErrorNote error={err} />
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-line bg-background p-3 text-[13px] sm:grid-cols-3">
              <W k="Site" v={`${d.site.name} (${d.site.code})`} /><W k="Incident" v={i.reference} /><W k="Priority" v="URGENT" />
              <W k="Location" v={d.site.address || "—"} /><W k="Confirmed issue" v={cause?.label ?? "Not confirmed"} /><W k="Outage start" v={dateTime(i.outageStartedAt)} />
              <W k="Current downtime" v={duration((now - new Date(i.outageStartedAt).getTime()) / 1000, true)} /><W k="Team" v={i.assignedTeam ?? d.site.technicalTeam} /><W k="Circuit" v={d.site.circuitRef || "—"} />
            </dl>
            <Field label="Technical notes for the technician"><textarea className={inputCls} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Access details, what was checked, contact on site…" /></Field>
            <Field label="Existing ticket / work-order number (optional)" hint="If the job was also logged in another system, record its number here."><input className={inputCls} value={ext} onChange={(e) => setExt(e.target.value)} /></Field>
          </div>
        )}
      </Modal>
    </Card>
  );
}
const W = ({ k, v }: { k: string; v: string }) => <div><dt className="text-2xs uppercase tracking-wide text-ink-muted">{k}</dt><dd className="font-semibold">{v}</dd></div>;
