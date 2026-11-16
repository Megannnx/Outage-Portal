"use client";
import clsx from "clsx";
import { useEffect, useMemo, useState } from "react";
import { api, dateTime, useApi } from "@/lib/client";
import { Badge, Button, ErrorNote, Field, MessagePreview, inputCls, type Tone } from "@/components/ui";

type Version = { id: string; version: number; subject: string; body: string; status: string; changeNote: string; createdBy: string | null; createdByName: string; createdAt: string; publishedAt: string | null; approvals: { approverName: string; decision: string; comment: string; at: string }[] };
type Tpl = { id: string; kind: string; audience: string; name: string; builtIn: boolean; versions: Version[] };
type Data = { kinds: { kind: string; label: string; required: string[] }[]; placeholders: Record<string, string>; templates: Tpl[] };
const VT: Record<string, Tone> = { published: "green", pending_approval: "amber", draft: "grey", retired: "grey", rejected: "red" };

export function Templates({ me }: { me: string }) {
  const { data, reload, error } = useApi<Data>("/api/admin/templates");
  const [sel, setSel] = useState<string | null>(null);
  const [subject, setSubject] = useState(""); const [body, setBody] = useState(""); const [note, setNote] = useState("");
  const [preview, setPreview] = useState<{ ok: boolean; subject?: string; body?: string; withoutOptional?: string; errors?: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [newT, setNewT] = useState({ kind: "", audience: "isp", name: "" });
  const tpl = data?.templates.find((t) => t.id === sel) ?? null;
  const published = tpl?.versions.find((v) => v.status === "published");
  const draft = tpl?.versions.find((v) => v.status === "draft");
  const pending = data?.templates.flatMap((t) => t.versions.filter((v) => v.status === "pending_approval").map((v) => ({ t, v }))) ?? [];
  useEffect(() => { if (!tpl) return; const base = draft ?? published ?? tpl.versions[0]; setSubject(base?.subject ?? ""); setBody(base?.body ?? ""); setNote(draft?.changeNote ?? ""); setErr(null); }, [sel, tpl?.versions.length]); // eslint-disable-line
  useEffect(() => {
    if (!tpl) return;
    const t = setTimeout(() => api("/api/admin/template-preview", { body: { kind: tpl.kind, subject, body } }).then(setPreview).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [subject, body, tpl]);
  const kindLabel = (k: string) => data?.kinds.find((x) => x.kind === k)?.label ?? k;
  const grouped = useMemo(() => data?.templates ?? [], [data]);

  async function act(fn: () => Promise<unknown>) { setErr(null); try { await fn(); reload(); } catch (e) { setErr((e as Error).message); } }
  const saveDraft = () => act(async () => {
    if (draft) await api(`/api/admin/template-versions/${draft.id}`, { body: { action: "update", subject, body, changeNote: note } });
    else await api(`/api/admin/templates/${tpl!.id}`, { body: { subject, body, changeNote: note } });
  });
  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <div className="space-y-3">
        {pending.length > 0 && (
          <div className="rounded-lg border border-warning-edge bg-warning-tint p-2.5 text-[13px]">
            <div className="mb-1 font-bold">Awaiting approval ({pending.length})</div>
            {pending.map(({ t, v }) => <button key={v.id} className="block w-full truncate text-left underline" onClick={() => setSel(t.id)}>{t.name} v{v.version}{t.audience !== "all" && ` (${t.audience})`}</button>)}
          </div>
        )}
        <ErrorNote error={error} />
        <ul className="divide-y divide-line rounded-lg border border-line">
          {grouped.map((t) => {
            const p = t.versions.find((v) => v.status === "published");
            return (
              <li key={t.id}><button onClick={() => setSel(t.id)} className={clsx("flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2", sel === t.id && "bg-surface-2")}>
                <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-semibold">{t.name}</span><span className="block text-2xs text-ink-muted">{t.kind} · {t.audience === "all" ? "residents & ISPs" : t.audience}</span></span>
                {p ? <Badge tone="green">v{p.version}</Badge> : <Badge tone="red">not live</Badge>}
              </button></li>
            );
          })}
        </ul>
        <details className="rounded-lg border border-line p-3 text-[13px]">
          <summary className="cursor-pointer font-semibold">Add audience-specific or custom template</summary>
          <div className="mt-2 space-y-2">
            <Field label="Kind" hint="A built-in kind (e.g. initial_outage) for ISP-specific wording, or custom_<name> for a new scenario attached to a cause option.">
              <input className={inputCls} list="kinds" value={newT.kind} onChange={(e) => setNewT({ ...newT, kind: e.target.value })} />
              <datalist id="kinds">{data?.kinds.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}</datalist>
            </Field>
            <Field label="Audience"><select className={inputCls} value={newT.audience} onChange={(e) => setNewT({ ...newT, audience: e.target.value })}><option value="isp">ISPs only</option><option value="resident">Residents only</option><option value="all">Residents & ISPs</option></select></Field>
            <Field label="Name"><input className={inputCls} value={newT.name} onChange={(e) => setNewT({ ...newT, name: e.target.value })} /></Field>
            <Button size="sm" onClick={() => act(() => api("/api/admin/templates", { body: newT }))}>Create</Button>
          </div>
        </details>
      </div>

      {tpl ? (
        <div className="min-w-0 space-y-3">
          <div>
            <h3 className="text-[16px] font-bold">{tpl.name}</h3>
            <div className="text-[12px] text-ink-muted">{kindLabel(tpl.kind)} · {tpl.audience === "all" ? "residents & ISPs (unless an audience-specific version exists)" : `${tpl.audience} only`} · required: {data?.kinds.find((k) => k.kind === tpl.kind)?.required.map((r) => `{{${r}}}`).join(", ") || "none"}</div>
          </div>
          <ErrorNote error={err} />
          <div className="grid gap-3 xl:grid-cols-2">
            <div className="space-y-2">
              <Field label="Subject"><input className={inputCls} value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
              <Field label="Body" hint="{{name}} inserts a verified value (the message will NOT send if it is missing — use a fallback). {{#name}}…{{/name}} shows text only when the value exists; {{^name}}…{{/name}} only when it doesn't.">
                <textarea className={`${inputCls} min-h-[300px] font-mono text-[12.5px]`} value={body} onChange={(e) => setBody(e.target.value)} />
              </Field>
              <div className="flex flex-wrap gap-1">{Object.entries(data!.placeholders).map(([k, d]) => (
                <button key={k} title={d} onClick={() => setBody((b) => `${b}{{${k}}}`)} className="rounded border border-line px-1.5 py-0.5 font-mono text-2xs text-ink-secondary hover:text-ink">{`{{${k}}}`}</button>
              ))}</div>
              <Field label="Change note"><input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why is the wording changing?" /></Field>
              <div className="flex flex-wrap gap-2">
                <Button onClick={saveDraft} disabled={!!preview && !preview.ok}>{draft ? "Save draft" : "Save as new draft"}</Button>
                {draft && <Button variant="primary" onClick={() => act(() => api(`/api/admin/template-versions/${draft.id}`, { body: { action: "submit" } }))}>Submit for approval</Button>}
                {published && <Button variant="ghost" onClick={() => confirm("Disable this template? The engine will fall back to the next template in its chain.") && act(() => api(`/api/admin/templates/${tpl.id}?reason=disabled`, { method: "DELETE" }))}>Disable</Button>}
              </div>
            </div>
            <div className="space-y-2">
              {preview && !preview.ok ? <ErrorNote error={preview.errors?.join("; ") ?? "Invalid"} /> : preview && (
                <>
                  <MessagePreview label="Preview with sample data (all facts known)" subject={preview.subject} body={preview.body} />
                  <MessagePreview label="Preview with optional facts unknown" body={preview.withoutOptional} />
                </>
              )}
            </div>
          </div>
          <h4 className="pt-2 text-[13px] font-bold">Version history</h4>
          <ul className="space-y-2">
            {tpl.versions.map((v) => (
              <li key={v.id} className="rounded-lg border border-line p-3 text-[13px]">
                <div className="flex flex-wrap items-center gap-2"><b>v{v.version}</b><Badge tone={VT[v.status] ?? "grey"}>{v.status.replace("_", " ")}</Badge>
                  <span className="text-2xs text-ink-muted">by {v.createdByName} {dateTime(v.createdAt)}{v.publishedAt && ` · published ${dateTime(v.publishedAt)}`}</span>
                  <span className="ml-auto flex gap-1">
                    {v.status === "pending_approval" && (v.createdBy !== me
                      ? <><Button size="sm" variant="success" onClick={() => act(() => api(`/api/admin/template-versions/${v.id}`, { body: { action: "approve" } }))}>Approve & publish</Button>
                          <Button size="sm" onClick={() => { const c = prompt("Reason for rejecting?"); if (c) void act(() => api(`/api/admin/template-versions/${v.id}`, { body: { action: "reject", comment: c } })); }}>Reject</Button></>
                      : <span className="text-2xs text-ink-muted">another administrator must approve</span>)}
                    {["retired", "rejected"].includes(v.status) && <Button size="sm" variant="ghost" onClick={() => act(() => api(`/api/admin/template-versions/${v.id}`, { body: { action: "rollback" } }))}>Roll back to this</Button>}
                  </span>
                </div>
                {v.changeNote && <div className="mt-1 text-2xs text-ink-muted">{v.changeNote}</div>}
                {v.approvals.map((a, i) => <div key={i} className="text-2xs text-ink-muted">{a.decision} by {a.approverName} {dateTime(a.at)}{a.comment && ` — ${a.comment}`}</div>)}
                <details className="mt-1"><summary className="cursor-pointer text-2xs text-ink-secondary">Show wording</summary><MessagePreview subject={v.subject} body={v.body} /></details>
              </li>
            ))}
          </ul>
        </div>
      ) : <div className="text-[13px] text-ink-muted">Select a template. Only <b>published</b> versions are ever sent; every change needs approval by a second administrator.</div>}
    </div>
  );
}
