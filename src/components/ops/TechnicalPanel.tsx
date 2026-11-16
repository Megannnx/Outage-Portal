"use client";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { Wand2, ShieldAlert } from "lucide-react";
import { api, ApiError, dateTime, fromLocalInput, toLocalInput, humanize } from "@/lib/client";
import type { Detail } from "@/lib/types";
import { Badge, Button, Card, ErrorNote, MessagePreview, inputCls } from "@/components/ui";

type Fact<T> = { value: T; confidence: number; evidence: string; note?: string };
type Facts = {
  providerId?: string | null; faultType?: string | null; technicians?: "dispatched" | "on_site" | null;
  repairStatus?: "investigating" | "underway" | "delayed" | "completed" | null; eta?: string | null; etaUnavailable?: boolean;
  providerRef?: string | null; nextProviderUpdate?: string | null; furtherInvestigation?: boolean;
};
type Extraction = Record<string, Fact<any> | any> & { conflicts: { field: string; reason: string }[]; warnings: string[]; extractor: string };
type PreviewResp = {
  extraction: Extraction | null; facts: Facts; phase: string; version: number;
  plan: { changes: string[]; requestedKind: string | null; errors: string[] };
  preview: { audience: string; kind: string | null; subject: string; body: string; tried: string[] }[];
};

export function TechnicalPanel({ d, onDone }: { d: Detail; onDone: () => void }) {
  const [text, setText] = useState("");
  const [ex, setEx] = useState<Extraction | null>(null);
  const [facts, setFacts] = useState<Facts>({});
  const [plan, setPlan] = useState<PreviewResp | null>(null);
  const [ack, setAck] = useState<Set<string>>(new Set());
  const [applyToGroup, setApplyToGroup] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const ts = d.incident.techState as Record<string, any>;

  async function analyse() {
    setErr(null); setBusy(true); setSent(null);
    try {
      const r = await api<PreviewResp>(`/api/incidents/${d.incident.id}/technical-preview`, { body: { text } });
      setEx(r.extraction); setFacts(r.facts); setPlan(r); setAck(new Set());
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  // Re-plan whenever the technician adjusts a fact.
  useEffect(() => {
    if (!ex) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try { setPlan(await api<PreviewResp>(`/api/incidents/${d.incident.id}/technical-preview`, { body: { facts: clean(facts) } })); } catch (e) { setErr((e as Error).message); }
    }, 300);
    return () => clearTimeout(timer.current);
  }, [facts]); // eslint-disable-line react-hooks/exhaustive-deps

  const conflicts = ex?.conflicts ?? [];
  const unacked = conflicts.filter((c) => !ack.has(c.field) && (clean(facts) as any)[c.field === "eta" ? "eta" : c.field] !== undefined);
  async function submit(internalOnly: boolean) {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ results: { communications: unknown[] }[] }>(`/api/incidents/${d.incident.id}/technical`, {
        body: { text, facts: clean(facts), expectedVersion: d.incident.version, acknowledgedConflicts: [...ack], internalOnly, applyToGroup: !!d.group && applyToGroup },
      });
      const n = r.results.reduce((a, x) => a + x.communications.length, 0);
      setSent(n ? `Update saved and ${n} approved message(s) queued for sending.` : "Update saved. No customer message was needed.");
      setText(""); setEx(null); setFacts({}); setPlan(null); onDone();
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 409 ? "Someone else updated this incident. Latest details loaded — check and submit again." : (e as Error).message);
      if (e instanceof ApiError && e.status === 409) onDone();
    } finally { setBusy(false); }
  }
  const set = <K extends keyof Facts>(k: K, v: Facts[K]) => setFacts((f) => ({ ...f, [k]: v }));
  const resident = plan?.preview.find((p) => p.audience === "resident");

  return (
    <Card title="Technical update" tone={d.incident.technicalAssigned && !d.incident.lastTechnicalUpdateAt ? "danger" : undefined}>
      <div className="space-y-3">
        <CurrentFacts ts={ts} d={d} />
        <textarea aria-label="Provider or technician update" className={clsx(inputCls, "min-h-[96px] font-mono text-[12.5px]")} value={text} onChange={(e) => { setText(e.target.value); setEx(null); setPlan(null); }}
          placeholder={'Paste exactly what the provider / technician said, e.g.\n"DFA confirmed a fibre break. Repair team dispatched. Estimated restoration 16:30."'} />
        <Button variant="primary" className="w-full" disabled={!text.trim() || busy} onClick={analyse}><Wand2 size={15} /> {busy && !ex ? "Reading…" : "Read update"}</Button>
        {sent && <div className="rounded-lg border border-success-edge bg-success-tint px-3 py-2 text-[13px]">{sent}</div>}
        <ErrorNote error={err} />

        {ex && (
          <div className="space-y-3">
            {conflicts.length > 0 && (
              <div className="space-y-1 rounded-lg border border-primary bg-primary-tint p-2.5 text-[12.5px]">
                <div className="flex items-center gap-1 font-bold text-primary-bright"><ShieldAlert size={14} /> Contradictory information — confirm before sending</div>
                {conflicts.map((c) => (
                  <label key={c.field} className="flex items-start gap-2"><input type="checkbox" checked={ack.has(c.field)} onChange={(e) => setAck((s) => { const n = new Set(s); e.target.checked ? n.add(c.field) : n.delete(c.field); return n; })} className="mt-0.5" /><span>{c.reason}. <b>I&apos;ve checked the {c.field} value below.</b></span></label>
                ))}
              </div>
            )}
            {ex.warnings.map((w: string) => <div key={w} className="rounded-md bg-warning-tint px-2 py-1 text-2xs text-warning">{w}</div>)}
            <div className="text-2xs font-bold uppercase tracking-wider text-ink-muted">Verified facts (check each one) · {ex.extractor === "rules+llm" ? "rules + AI cross-check" : "rules"}</div>
            <div className="grid gap-2">
              <Row label="Provider" fact={ex.provider} changed={facts.providerId !== undefined}>
                <select className={inputCls} value={facts.providerId ?? ""} onChange={(e) => set("providerId", e.target.value || undefined)}>
                  <option value="">— no change —</option>{d.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Row>
              <Row label="Confirmed fault" fact={ex.faultType} changed={facts.faultType !== undefined}>
                <select className={inputCls} value={facts.faultType ?? ""} onChange={(e) => set("faultType", e.target.value || undefined)}>
                  <option value="">— not confirmed / no change —</option>{d.faultTypes.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
              </Row>
              <Row label="Technicians" fact={ex.technicians} changed={facts.technicians !== undefined}>
                <select className={inputCls} value={facts.technicians ?? ""} onChange={(e) => set("technicians", (e.target.value || undefined) as Facts["technicians"])}>
                  <option value="">— no change —</option><option value="dispatched">Dispatched / en route</option><option value="on_site">On site</option>
                </select>
              </Row>
              <Row label="Repair status" fact={ex.repairStatus} changed={facts.repairStatus !== undefined}>
                <select className={inputCls} value={facts.repairStatus ?? ""} onChange={(e) => set("repairStatus", (e.target.value || undefined) as Facts["repairStatus"])}>
                  <option value="">— no change —</option><option value="investigating">Investigating</option><option value="underway">Repairs underway</option><option value="delayed">Repair delayed</option><option value="completed">Repair work completed</option>
                </select>
              </Row>
              <Row label="ETA (SAST)" fact={ex.eta ?? ex.etaUnavailable} changed={facts.eta !== undefined || !!facts.etaUnavailable}>
                <div className="flex items-center gap-2">
                  <input type="datetime-local" className={clsx(inputCls, "min-w-0")} value={toLocalInput(facts.eta)} disabled={facts.etaUnavailable} onChange={(e) => set("eta", fromLocalInput(e.target.value) ?? undefined)} />
                  <label className="flex shrink-0 items-center gap-1 text-[12px]"><input type="checkbox" checked={!!facts.etaUnavailable} onChange={(e) => setFacts((f) => ({ ...f, etaUnavailable: e.target.checked || undefined, eta: e.target.checked ? undefined : f.eta }))} /> No ETA</label>
                </div>
              </Row>
              <div className="grid grid-cols-2 gap-2">
                <Row label="Provider ref" fact={ex.providerRef} changed={facts.providerRef !== undefined}><input className={inputCls} value={facts.providerRef ?? ""} onChange={(e) => set("providerRef", e.target.value || undefined)} /></Row>
                <Row label="Provider's next update" fact={ex.nextProviderUpdate} changed={facts.nextProviderUpdate !== undefined}><input type="datetime-local" className={inputCls} value={toLocalInput(facts.nextProviderUpdate)} onChange={(e) => set("nextProviderUpdate", fromLocalInput(e.target.value) ?? undefined)} /></Row>
              </div>
            </div>

            {plan?.plan.errors.length ? <ErrorNote error={plan.plan.errors.join(". ")} /> : null}
            {plan && plan.plan.requestedKind && plan.phase === "active" && resident?.kind ? (
              <MessagePreview label={<>Will send now to residents & ISPs · template <b>{humanize(resident.kind)}</b>{resident.kind !== plan.plan.requestedKind && ` (fallback from ${humanize(plan.plan.requestedKind)})`}</>} subject={resident.subject} body={resident.body} />
            ) : plan ? (
              <div className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[12.5px] text-ink-secondary">
                {plan.phase !== "active" ? "The link is restored or restoring — this will be saved without a customer message." : plan.plan.changes.length ? `Internal only: ${plan.plan.changes.join(", ").replace(/_/g, " ")}. No customer-relevant change, so no message is sent (the 2-hourly update continues).` : "No change to verified facts — will be saved as an internal note."}
              </div>
            ) : null}
            {d.group && <label className="flex items-center gap-2 text-[12.5px]"><input type="checkbox" checked={applyToGroup} onChange={(e) => setApplyToGroup(e.target.checked)} /> Apply to all {d.group.members.length} linked sites in {d.group.reference} (one combined ISP message)</label>}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" size="lg" className="flex-1" disabled={busy || unacked.length > 0 || !!plan?.plan.errors.length} onClick={() => submit(false)}>
                {busy ? "Saving…" : plan?.plan.requestedKind && plan.phase === "active" ? "Confirm & send update" : "Save update"}
              </Button>
              {plan?.plan.requestedKind && plan.phase === "active" && <Button size="lg" disabled={busy || !!plan?.plan.errors.length} onClick={() => submit(true)}>Internal note only</Button>}
            </div>
          </div>
        )}
        {d.technicalUpdates.length > 0 && (
          <details className="text-[12.5px]">
            <summary className="cursor-pointer text-ink-secondary">Previous updates ({d.technicalUpdates.length})</summary>
            <ul className="mt-2 space-y-2">
              {d.technicalUpdates.map((u) => (
                <li key={u.id} className="rounded-md border border-line p-2">
                  <div className="text-2xs text-ink-muted">{dateTime(u.createdAt)} · {u.author} · {u.meaningful ? "customer update sent" : "internal"}</div>
                  <pre className="mt-1 whitespace-pre-wrap font-mono text-[12px]">{u.originalText}</pre>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Card>
  );
}

function clean(f: Facts): Facts { const o: any = {}; for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== "") o[k] = v; return o; }

function Row({ label, fact, changed, children }: { label: string; fact?: Fact<any>; changed: boolean; children: React.ReactNode }) {
  return (
    <div className={clsx("min-w-0 rounded-lg border p-2", changed ? "border-ink-muted" : "border-line")}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[12px] font-semibold text-ink-secondary">{label}</span>
        {fact && <Badge tone={fact.confidence >= 0.8 ? "green" : "amber"} title={`Evidence: "${fact.evidence}"`}>{fact.confidence >= 0.8 ? "found" : "check"} {Math.round(fact.confidence * 100)}%</Badge>}
      </div>
      {children}
      {fact && <div className="mt-1 truncate text-2xs text-ink-muted" title={fact.evidence}>“{fact.evidence}”{fact.note && <span className="block text-warning">{fact.note}</span>}</div>}
    </div>
  );
}

function CurrentFacts({ ts, d }: { ts: Record<string, any>; d: Detail }) {
  const items = [
    ts.providerName && ["Provider", ts.providerName], ts.faultDescription && ["Fault", d.faultTypes.find((f) => f.key === ts.faultType)?.label ?? ts.faultType],
    ts.technicians && ["Technicians", humanize(ts.technicians)], ts.repairStatus && ["Repair", humanize(ts.repairStatus)],
    ts.eta && !ts.etaUnavailable ? ["ETA", dateTime(ts.eta)] : ts.etaUnavailable ? ["ETA", "None given"] : null, ts.providerRef && ["Ref", ts.providerRef],
  ].filter(Boolean) as [string, string][];
  if (!items.length) return <div className="text-[12.5px] text-ink-muted">No verified technical facts yet.</div>;
  return <div className="flex flex-wrap gap-1">{items.map(([k, v]) => <Badge key={k}>{k}: {v}</Badge>)}</div>;
}
