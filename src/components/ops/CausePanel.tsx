"use client";
import clsx from "clsx";
import { useState } from "react";
import { Zap, Server, PlugZap, HelpCircle } from "lucide-react";
import { api, ApiError } from "@/lib/client";
import type { Detail } from "@/lib/types";
import { Button, Card, ErrorNote, Field, MessagePreview, Modal, inputCls } from "@/components/ui";

type Preview = { cause: { label: string; requiresDispatch: boolean; assignsTechnical: boolean }; willSendNow: boolean; siteName: string; kind: string | null; subject: string; body: string };
const PRIMARY = [
  { key: "power_area", icon: Zap, hint: "Electricity is out in the surrounding area" },
  { key: "power_server_room", icon: Server, hint: "Power problem in the site's server room / cabinet" },
  { key: "power_ok", icon: PlugZap, hint: "Power is available at the site" },
];

export function CausePanel({ d, onDone }: { d: Detail; onDone: () => void }) {
  const [pick, setPick] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = d.incident.causeKey;
  const others = d.causeOptions.filter((c) => !PRIMARY.some((p) => p.key === c.key));

  async function choose(key: string) {
    setPick(key); setPreview(null); setErr(null); setNote("");
    try { setPreview(await api<Preview>(`/api/incidents/${d.incident.id}/cause-preview?causeKey=${key}`)); } catch (e) { setErr((e as Error).message); }
  }
  async function confirm() {
    if (!pick) return;
    setBusy(true); setErr(null);
    try {
      await api(`/api/incidents/${d.incident.id}/cause`, { body: { causeKey: pick, expectedVersion: d.incident.version, note: note || undefined } });
      setPick(null); onDone();
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 409 ? "Someone else updated this incident a moment ago. The latest details have been loaded — check them, then confirm again." : (e as Error).message);
      if (e instanceof ApiError && e.status === 409) onDone();
    } finally { setBusy(false); }
  }
  return (
    <Card title={current ? "Cause (tap to correct)" : "Confirm the cause"} tone={!current && d.incident.phase === "active" ? "danger" : undefined}>
      <div className="grid gap-2">
        {PRIMARY.map(({ key, icon: Icon, hint }) => {
          const c = d.causeOptions.find((x) => x.key === key);
          if (!c) return null;
          return (
            <Button key={key} size="xl" variant={current === key ? "primary" : "secondary"} onClick={() => choose(key)} aria-pressed={current === key}>
              <Icon size={22} className="shrink-0" />
              <span><span className="block text-[14px] font-bold uppercase tracking-wide">{c.label}</span><span className={clsx("block text-[12px] font-normal", current === key ? "text-white/80" : "text-ink-muted")}>{hint}</span></span>
            </Button>
          );
        })}
        {others.length > 0 && (
          <div className="flex items-center gap-2">
            <HelpCircle size={18} className="shrink-0 text-ink-muted" />
            <select aria-label="Other cause" className={inputCls} value={others.some((o) => o.key === current) ? current! : ""} onChange={(e) => e.target.value && choose(e.target.value)}>
              <option value="">Other / unknown cause…</option>
              {others.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>
        )}
      </div>
      <Modal open={!!pick} onClose={() => setPick(null)} wide title={preview ? `${current ? "Correct cause to" : "Confirm"}: ${preview.cause.label}` : "Loading…"}
        footer={<><Button variant="ghost" onClick={() => setPick(null)}>Cancel</Button><Button variant="primary" size="lg" disabled={!preview || busy} onClick={confirm}>{busy ? "Saving…" : preview?.willSendNow ? `Confirm & send to ${preview.siteName}` : "Confirm cause"}</Button></>}>
        <div className="space-y-3">
          <ErrorNote error={err} />
          {preview && (
            <>
              <div className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px]">
                Site: <b>{preview.siteName}</b>. {preview.willSendNow
                  ? <>This approved message will be sent <b>now</b> to this site&apos;s residents and ISPs, and the 2-hour update clock restarts.</>
                  : <>The outage is still validating — this wording will be used for the first message.</>}
                {preview.cause.requiresDispatch && <div className="mt-1 font-bold text-primary-bright">You will then need to log an URGENT technician dispatch.</div>}
                {preview.cause.assignsTechnical && <div className="mt-1">Technical will be notified to investigate.</div>}
              </div>
              {preview.kind ? <MessagePreview label={`Approved template: ${preview.kind.replace(/_/g, " ")}`} subject={preview.subject} body={preview.body} />
                : <ErrorNote error="No published template is available for this cause — an administrator must publish one. The cause will still be recorded." />}
              <Field label="Internal note (optional, not sent to customers)"><input className={inputCls} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Eskom confirmed area outage via app" /></Field>
            </>
          )}
        </div>
      </Modal>
    </Card>
  );
}
