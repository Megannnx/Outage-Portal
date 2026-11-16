"use client";
import { useEffect, useState } from "react";
import { api, ApiError, dateTime, duration, fromLocalInput, toLocalInput, useNow } from "@/lib/client";
import type { Detail, Role } from "@/lib/types";
import { Button, Card, ErrorNote, Field, MessagePreview, Modal, inputCls } from "@/components/ui";

export function RfoPanel({ d, role, onDone }: { d: Detail; role: Role; onDone: () => void }) {
  const i = d.incident;
  const [text, setText] = useState(""); const [ref, setRef] = useState(""); const [received, setReceived] = useState(toLocalInput(new Date().toISOString()));
  const [notes, setNotes] = useState("");
  const [preview, setPreview] = useState<{ kind: string | null; subject: string; body: string } | null>(null);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [waive, setWaive] = useState(false); const [reason, setReason] = useState(""); const [sendFinal, setSendFinal] = useState(true);
  const now = useNow(60000);
  useEffect(() => {
    if (text.trim().length < 10) { setPreview(null); return; }
    const t = setTimeout(() => api(`/api/incidents/${i.id}/rfo-preview`, { body: { rfoText: text } }).then(setPreview).catch(() => {}), 350);
    return () => clearTimeout(t);
  }, [text, i.id]);
  if (role === "service_desk") return (
    <Card title="Reason for outage (RFO)"><div className="text-[13px]">{i.rfoStatus === "awaiting" ? `Awaiting RFO from Technical — outstanding ${duration((now - new Date(i.restorationConfirmedAt ?? i.updatedAt).getTime()) / 1000, true)}.` : `RFO ${i.rfoStatus}.`}</div></Card>
  );
  if (i.rfoStatus !== "awaiting") return (
    <Card title="Reason for outage (RFO)">
      <div className="text-[13px]">{i.rfoStatus === "sent" ? "Final RFO message is being delivered. The incident resolves automatically once delivery completes." : i.rfoStatus === "waived" ? `Closed without RFO: ${i.rfoWaiverReason}` : "—"}</div>
      {d.rfo[0] && <pre className="mt-2 whitespace-pre-wrap rounded bg-background p-2 text-[12.5px]">{d.rfo[0].rfoText}</pre>}
    </Card>
  );
  async function submit() {
    setBusy(true); setErr(null);
    try { await api(`/api/incidents/${i.id}/rfo`, { body: { rfoText: text, providerRef: ref || undefined, receivedAt: fromLocalInput(received) ?? undefined, internalNotes: notes || undefined, expectedVersion: i.version } }); onDone(); }
    catch (e) { setErr((e as Error).message); if (e instanceof ApiError && e.status === 409) onDone(); } finally { setBusy(false); }
  }
  async function doWaive() {
    setBusy(true); setErr(null);
    try { await api(`/api/incidents/${i.id}/rfo-waive`, { body: { reason, sendFinal, expectedVersion: i.version } }); setWaive(false); onDone(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Card title="Reason for outage (RFO)" tone="danger">
      <div className="space-y-3">
        <div className="text-[12.5px] text-ink-secondary">Restored {dateTime(i.restoredAt)} · RFO outstanding <b className="text-ink">{duration((now - new Date(i.restorationConfirmedAt ?? i.updatedAt).getTime()) / 1000, true)}</b></div>
        <Field label="Verified RFO — this exact text goes to residents and ISPs" hint="Write it for customers. Do not paste internal notes or supplier ticket chatter here.">
          <textarea className={inputCls} rows={4} maxLength={1500} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. A third-party contractor damaged the fibre route on Main Road. Our provider re-spliced the cable and service was restored." />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Provider reference"><input className={inputCls} value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
          <Field label="RFO received (SAST)"><input type="datetime-local" className={inputCls} value={received} onChange={(e) => setReceived(e.target.value)} /></Field>
        </div>
        <Field label="Internal notes (not sent)"><textarea className={inputCls} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        {preview && (preview.kind ? <MessagePreview label="Final message preview" subject={preview.subject} body={preview.body} /> : <ErrorNote error="No published 'Final RFO' template — ask an administrator to publish one." />)}
        <ErrorNote error={err} />
        <Button variant="primary" size="lg" className="w-full" disabled={busy || text.trim().length < 10 || !preview?.kind} onClick={() => confirm("Send this RFO to all residents and ISPs of this site?") && submit()}>Send final RFO to residents & ISPs</Button>
        {role === "admin" && <Button variant="ghost" size="sm" onClick={() => setWaive(true)}>Close without RFO (administrator)…</Button>}
      </div>
      <Modal open={waive} onClose={() => setWaive(false)} title="Close without an RFO"
        footer={<><Button variant="ghost" onClick={() => setWaive(false)}>Cancel</Button><Button variant="danger" disabled={busy || reason.trim().length < 10} onClick={doWaive}>Authorise & close</Button></>}>
        <div className="space-y-3">
          <p className="text-[13px] text-ink-secondary">Use only when a formal RFO will not be provided. Your name and reason are recorded in the audit log.</p>
          <Field label="Authorised reason"><textarea className={inputCls} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={sendFinal} onChange={(e) => setSendFinal(e.target.checked)} /> Send the approved &ldquo;resolved (no RFO)&rdquo; message</label>
          <ErrorNote error={err} />
        </div>
      </Modal>
    </Card>
  );
}
