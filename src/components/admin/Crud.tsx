"use client";
import { useMemo, useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { api, useApi } from "@/lib/client";
import { Badge, Button, Empty, ErrorNote, Field, Modal, inputCls } from "@/components/ui";

export type FieldDef = {
  key: string; label: string; type?: "text" | "number" | "bool" | "select" | "tags" | "textarea" | "password" | "multiselect";
  options?: { value: string; label: string }[]; hint?: string; required?: boolean; createOnly?: boolean; editOnly?: boolean; nullable?: boolean; warn?: string;
};
export type ColDef<T> = { label: string; render: (r: T) => React.ReactNode; className?: string };

/** Generic validated CRUD table for administrator configuration (server re-validates everything). */
export function Crud<T extends Record<string, any>>({ resource, title, fields, columns, idOf, filter, defaults, canDelete = true, deleteLabel = "Deactivate", extraActions, search }: {
  resource: string; title: string; fields: FieldDef[]; columns: ColDef<T>[]; idOf?: (r: T) => string; filter?: (r: T) => boolean;
  defaults?: Partial<T>; canDelete?: boolean; deleteLabel?: string; extraActions?: (r: T, reload: () => void) => React.ReactNode; search?: (r: T) => string;
}) {
  const { data, reload, error } = useApi<{ items: T[] }>(`/api/admin/${resource}`);
  const [edit, setEdit] = useState<{ row: T | null; values: Record<string, any> } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const id = idOf ?? ((r: T) => r.id);
  const rows = useMemo(() => (data?.items ?? []).filter((r) => (!filter || filter(r)) && (!q || !search || search(r).toLowerCase().includes(q.toLowerCase()))), [data, filter, q, search]);

  async function save() {
    if (!edit) return;
    setErr(null);
    const body: Record<string, any> = {};
    for (const f of fields) {
      if (edit.row && f.createOnly) continue;
      if (!edit.row && f.editOnly) continue;
      let v = edit.values[f.key];
      if (f.type === "number") v = v === "" || v == null ? (f.nullable ? null : undefined) : Number(v);
      if (f.type === "tags") v = typeof v === "string" ? v.split(",").map((x: string) => x.trim()).filter(Boolean) : v ?? [];
      if ((f.type === "text" || f.type === "select" || f.type === "password" || f.type === "textarea") && v === "" && f.nullable) v = null;
      if (f.type === "password" && !v) continue;
      if (v !== undefined) body[f.key] = v;
    }
    try {
      if (edit.row) await api(`/api/admin/${resource}/${encodeURIComponent(id(edit.row))}`, { method: "PATCH", body });
      else await api(`/api/admin/${resource}`, { body });
      setEdit(null); reload();
    } catch (e) { setErr((e as Error).message); }
  }
  async function remove(r: T) {
    if (!confirm(`${deleteLabel} this ${title.toLowerCase().replace(/s$/, "")}?`)) return;
    try { await api(`/api/admin/${resource}/${encodeURIComponent(id(r))}`, { method: "DELETE" }); reload(); } catch (e) { alert((e as Error).message); }
  }
  const open = (row: T | null) => {
    const values: Record<string, any> = {};
    for (const f of fields) {
      const v = row ? row[f.key] : (defaults as any)?.[f.key];
      values[f.key] = f.type === "tags" ? (v ?? []).join(", ") : f.type === "bool" ? v ?? (row ? false : true) : f.type === "multiselect" ? v ?? [] : v ?? "";
    }
    setErr(null); setEdit({ row, values });
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-bold">{title}</h3>
        {search && <input className={`${inputCls} h-8 max-w-xs py-1 text-[13px]`} placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />}
        <Button size="sm" variant="primary" className="ml-auto" onClick={() => open(null)}><Plus size={14} /> Add</Button>
      </div>
      <ErrorNote error={error} />
      {data && !rows.length ? <Empty>None yet.</Empty> : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-[13px]">
            <thead className="bg-surface-2 text-left text-2xs uppercase tracking-wide text-ink-muted"><tr>{columns.map((c) => <th key={c.label} className="px-3 py-2 font-semibold">{c.label}</th>)}<th className="w-px" /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={id(r)} className="border-t border-line align-top">
                  {columns.map((c) => <td key={c.label} className={`px-3 py-2 ${c.className ?? ""}`}>{c.render(r)}</td>)}
                  <td className="whitespace-nowrap px-2 py-1.5 text-right">
                    {extraActions?.(r, reload)}
                    <button aria-label="Edit" className="rounded p-1.5 text-ink-muted hover:text-ink" onClick={() => open(r)}><Pencil size={14} /></button>
                    {canDelete && <button aria-label={deleteLabel} className="rounded p-1.5 text-ink-muted hover:text-primary-bright" onClick={() => remove(r)}><Trash2 size={14} /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={`${edit?.row ? "Edit" : "Add"} ${title.toLowerCase().replace(/s$/, "")}`} wide
        footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
        {edit && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2"><ErrorNote error={err} /></div>
            {fields.filter((f) => !(edit.row && f.createOnly) && !(!edit.row && f.editOnly)).map((f) => (
              <div key={f.key} className={f.type === "textarea" || f.type === "multiselect" || f.type === "tags" ? "sm:col-span-2" : ""}>
                {f.type === "bool" ? (
                  <label className="flex items-center gap-2 pt-5 text-[13px]"><input type="checkbox" checked={!!edit.values[f.key]} onChange={(e) => setEdit({ ...edit, values: { ...edit.values, [f.key]: e.target.checked } })} /> {f.label}</label>
                ) : (
                  <Field label={<>{f.label}{f.required && " *"}{f.warn && <Badge tone="amber" className="ml-2">customer-facing</Badge>}</>} hint={f.warn ?? f.hint}>
                    {f.type === "select" ? (
                      <select className={inputCls} value={edit.values[f.key] ?? ""} onChange={(e) => setEdit({ ...edit, values: { ...edit.values, [f.key]: e.target.value } })}>
                        <option value="">—</option>{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    ) : f.type === "multiselect" ? (
                      <div className="flex flex-wrap gap-3">{f.options?.map((o) => (
                        <label key={o.value} className="flex items-center gap-1.5 text-[13px]"><input type="checkbox" checked={(edit.values[f.key] ?? []).includes(o.value)} onChange={(e) => {
                          const cur: string[] = edit.values[f.key] ?? [];
                          setEdit({ ...edit, values: { ...edit.values, [f.key]: e.target.checked ? [...cur, o.value] : cur.filter((x) => x !== o.value) } });
                        }} /> {o.label}</label>))}</div>
                    ) : f.type === "textarea" ? (
                      <textarea className={inputCls} rows={3} value={edit.values[f.key] ?? ""} onChange={(e) => setEdit({ ...edit, values: { ...edit.values, [f.key]: e.target.value } })} />
                    ) : (
                      <input className={inputCls} type={f.type === "number" ? "number" : f.type === "password" ? "password" : "text"} value={edit.values[f.key] ?? ""} step="any"
                        onChange={(e) => setEdit({ ...edit, values: { ...edit.values, [f.key]: e.target.value } })} />
                    )}
                  </Field>
                )}
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
