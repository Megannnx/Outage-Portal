"use client";
import { useEffect, useState } from "react";
import { api, dateTime, useApi } from "@/lib/client";
import { Badge, Button, Card, ErrorNote, Field, inputCls } from "@/components/ui";
import { Crud } from "./Crud";

type Opt = { value: string; label: string };
const useOpts = (resource: string, label: (r: any) => string, value: (r: any) => string = (r) => r.id) => {
  const { data } = useApi<{ items: any[] }>(`/api/admin/${resource}`);
  return (data?.items ?? []).map((r) => ({ value: value(r), label: label(r) })) as Opt[];
};
const yes = (b: boolean) => (b ? <Badge tone="green">yes</Badge> : <Badge>no</Badge>);
const active = (r: any) => (r.active === false ? <Badge>inactive</Badge> : null);

export function Sites() {
  const providers = useOpts("providers", (r) => r.name);
  const sites = useOpts("sites", (r) => `${r.code} — ${r.name}`);
  const isps = useOpts("isps", (r) => r.name);
  const { data: links, reload } = useApi<{ items: { siteId: string; ispId: string }[] }>("/api/admin/site-isps");
  const [siteFor, setSiteFor] = useState<string>("");
  return (
    <div className="space-y-8">
      <Crud resource="sites" title="Sites" search={(r) => `${r.code} ${r.name} ${r.estate} ${r.circuitRef}`}
        fields={[
          { key: "code", label: "Site code", required: true, hint: "e.g. DWV — matches NetXMS naming" }, { key: "name", label: "Site name", required: true, warn: "Inserted as {{site_name}} in customer messages." },
          { key: "estate", label: "Estate / area", warn: "Inserted as {{estate_name}}." }, { key: "region", label: "Region" }, { key: "address", label: "Address", type: "textarea" },
          { key: "latitude", label: "Latitude", type: "number", nullable: true }, { key: "longitude", label: "Longitude", type: "number", nullable: true },
          { key: "backhaulProviderId", label: "Backhaul provider", type: "select", options: providers, nullable: true },
          { key: "circuitRef", label: "Circuit / reference" }, { key: "upstreamRef", label: "Upstream point (POP)", hint: "Sites sharing this are suggested as one related outage." },
          { key: "technicalTeam", label: "Technical team" }, { key: "residentListRef", label: "Resident distribution ref (client API)", hint: "Identifies this site's residents in the client communications system." },
          { key: "rfoRequired", label: "RFO required after restoration", type: "bool" }, { key: "active", label: "Active", type: "bool" }, { key: "notes", label: "Notes", type: "textarea" },
        ]}
        defaults={{ technicalTeam: "NOC", rfoRequired: true, active: true } as any}
        columns={[
          { label: "Site", render: (r: any) => <><b>{r.code}</b> {r.name} {active(r)}<div className="text-2xs text-ink-muted">{r.estate}</div></> },
          { label: "Backhaul", render: (r: any) => <>{providers.find((p) => p.value === r.backhaulProviderId)?.label ?? "—"}<div className="font-mono text-2xs text-ink-muted">{r.circuitRef}</div></> },
          { label: "Upstream", render: (r: any) => <span className="font-mono text-[12px]">{r.upstreamRef || "—"}</span> },
          { label: "Residents list", render: (r: any) => r.residentListRef ? <span className="font-mono text-[12px]">{r.residentListRef}</span> : <Badge tone="red">missing</Badge> },
          { label: "ISPs", render: (r: any) => { const n = links?.items.filter((l) => l.siteId === r.id).length ?? 0; return n ? n : <Badge tone="red">none</Badge>; } },
        ]} />
      <Crud resource="identifiers" title="Monitoring identifiers" canDelete deleteLabel="Remove" search={(r) => `${r.value} ${r.label} ${sites.find((s) => s.value === r.siteId)?.label}`}
        fields={[
          { key: "siteId", label: "Site", type: "select", options: sites, required: true },
          { key: "source", label: "Source", type: "select", options: [{ value: "netxms", label: "NetXMS" }, { value: "any", label: "Any (name match, incl. Telegram backup)" }] },
          { key: "matchType", label: "Match", type: "select", options: [{ value: "object_id", label: "NetXMS object ID (recommended)" }, { value: "name_exact", label: "Exact object name" }, { value: "name_prefix", label: "Name starts with" }] },
          { key: "value", label: "Value", required: true, hint: "Object ID (or id/interface for a link), or the device name, e.g. DWV L3GR10" },
          { key: "critical", label: "Critical — this object going down means the SITE is down", type: "bool" }, { key: "label", label: "Label" },
        ]}
        defaults={{ source: "netxms", matchType: "object_id", critical: true } as any}
        columns={[
          { label: "Site", render: (r: any) => sites.find((s) => s.value === r.siteId)?.label ?? "?" },
          { label: "Match", render: (r: any) => <><span className="font-mono">{r.matchType}={r.value}</span> <span className="text-2xs text-ink-muted">({r.source})</span></> },
          { label: "Critical", render: (r: any) => yes(r.critical) }, { label: "Label", render: (r: any) => r.label },
        ]} />
      <Card title="ISPs served by a site">
        <div className="space-y-2">
          <select className={inputCls} value={siteFor} onChange={(e) => setSiteFor(e.target.value)}><option value="">Choose a site…</option>{sites.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select>
          {siteFor && <div className="flex flex-wrap gap-3">{isps.map((i) => {
            const on = !!links?.items.some((l) => l.siteId === siteFor && l.ispId === i.value);
            return <label key={i.value} className="flex items-center gap-1.5 text-[13px]"><input type="checkbox" checked={on} onChange={async () => {
              try { on ? await api(`/api/admin/site-isps/${siteFor}:${i.value}`, { method: "DELETE" }) : await api("/api/admin/site-isps", { body: { siteId: siteFor, ispId: i.value } }); reload(); } catch (e) { alert((e as Error).message); }
            }} /> {i.label}</label>;
          })}</div>}
          <p className="text-2xs text-ink-muted">Only the ISPs ticked here receive outage notices for that site. Each ISP contact is emailed individually — ISPs never see each other.</p>
        </div>
      </Card>
    </div>
  );
}

export function Recipients() {
  const isps = useOpts("isps", (r) => r.name);
  const sites = useOpts("sites", (r) => `${r.code} — ${r.name}`);
  const { data: q } = useApi<any>("/api/admin/recipient-quality");
  return (
    <div className="space-y-8">
      {q && (q.problem.length || q.ispsWithoutContacts.length || q.ispFailures.length || q.sitesWithoutIsps.length || q.duplicates.length) ? (
        <Card title="Delivery & data-quality problems" tone="danger">
          <div className="space-y-3 text-[13px]">
            {q.ispsWithoutContacts.map((i: any) => <div key={i.id}><Badge tone="red">no working contact</Badge> <b>{i.name}</b> will not receive outage notices.</div>)}
            {q.sitesWithoutIsps.map((s: any) => <div key={s.id}><Badge tone="amber">no ISPs</Badge> Site <b>{s.code} {s.name}</b> has no ISPs linked.</div>)}
            {q.ispFailures.map((f: any) => <div key={f.address}><Badge tone="red">{f.failed}/{f.total} failed</Badge> {f.name} — <span className="font-mono">{f.address}</span> (last {dateTime(f.last)})</div>)}
            {q.problem.map((r: any) => <div key={r.id}><Badge tone={r.status === "active" ? "amber" : "red"}>{r.status}</Badge> <span className="font-mono">{r.email}</span> {r.isp_name && `(${r.isp_name})`} — {r.bounce_count} bounce(s){r.status_reason && `: ${r.status_reason}`}</div>)}
            {q.duplicates.map((d: any) => <div key={d.email}><Badge>duplicate</Badge> <span className="font-mono">{d.email}</span> appears {d.n}× ({d.audiences.join(", ")})</div>)}
          </div>
        </Card>
      ) : q ? <div className="rounded-lg border border-success-edge bg-success-tint px-3 py-2 text-[13px]">No recipient problems detected.</div> : null}
      <Crud resource="isps" title="ISPs" fields={[{ key: "name", label: "ISP name", required: true }, { key: "active", label: "Active", type: "bool" }]}
        columns={[{ label: "ISP", render: (r: any) => <>{r.name} {active(r)}</> }]} />
      <Crud resource="recipients" title="Contacts" search={(r) => `${r.email} ${r.name} ${isps.find((i) => i.value === r.ispId)?.label ?? ""} ${r.team ?? ""}`}
        fields={[
          { key: "audience", label: "Type", type: "select", options: [{ value: "isp", label: "ISP outage contact" }, { value: "internal", label: "Internal (team / escalation)" }, { value: "resident", label: "Direct resident contact (optional)" }] },
          { key: "ispId", label: "ISP", type: "select", options: isps, nullable: true }, { key: "siteId", label: "Site (residents)", type: "select", options: sites, nullable: true },
          { key: "team", label: "Team (internal)", nullable: true }, { key: "name", label: "Name" }, { key: "email", label: "Email", required: true },
          { key: "status", label: "Status", type: "select", options: [{ value: "active", label: "Active" }, { value: "suppressed", label: "Suppressed" }, { value: "invalid", label: "Invalid" }], editOnly: true },
          { key: "statusReason", label: "Status reason", nullable: true, editOnly: true },
        ]}
        defaults={{ audience: "isp" } as any} deleteLabel="Delete"
        columns={[
          { label: "Email", render: (r: any) => <><span className="font-mono">{r.email}</span><div className="text-2xs text-ink-muted">{r.name}</div></> },
          { label: "Type", render: (r: any) => r.audience === "isp" ? isps.find((i) => i.value === r.ispId)?.label ?? "ISP" : r.audience === "internal" ? `Internal · ${r.team}` : `Resident · ${sites.find((s) => s.value === r.siteId)?.label}` },
          { label: "Status", render: (r: any) => <><Badge tone={r.status === "active" ? (r.bounceCount ? "amber" : "green") : "red"}>{r.status}</Badge>{r.bounceCount > 0 && <span className="ml-1 text-2xs text-ink-muted">{r.bounceCount} bounce(s)</span>}</> },
          { label: "Last delivered", render: (r: any) => <span className="text-2xs">{dateTime(r.lastDeliveredAt)}</span> },
        ]} />
    </div>
  );
}

type S = Record<string, any>;
export function Policies() {
  const { data, reload } = useApi<{ settings: S }>("/api/admin/settings");
  const [s, setS] = useState<S | null>(null); const [err, setErr] = useState<string | null>(null); const [ok, setOk] = useState(false);
  useEffect(() => { if (data) setS(data.settings); }, [data]);
  const kinds = useApi<{ kinds: { kind: string; label: string }[]; templates: { kind: string }[] }>("/api/admin/templates").data;
  const kindOpts = [...(kinds?.kinds ?? []), ...(kinds?.templates.filter((t) => t.kind.startsWith("custom_")).map((t) => ({ kind: t.kind, label: t.kind })) ?? [])].map((k) => ({ value: k.kind, label: k.label }));
  async function save() {
    setErr(null); setOk(false);
    try { await api("/api/admin/settings", { method: "PATCH", body: s }); setOk(true); reload(); } catch (e) { setErr((e as Error).message); }
  }
  const num = (k: string, label: string, hint?: string) => <Field label={label} hint={hint}><input type="number" className={inputCls} value={s?.[k] ?? ""} onChange={(e) => setS({ ...s!, [k]: Number(e.target.value) })} /></Field>;
  return (
    <div className="space-y-8">
      {s && (
        <Card title="Automation policy" actions={<Button size="sm" variant="primary" onClick={save}>Save policy</Button>}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="sm:col-span-full"><ErrorNote error={err} />{ok && <div className="text-[13px] text-success">Saved.</div>}</div>
            {num("validationMinutes", "Outage validation (minutes)", "Down at least this long before customers are told. Spec: 3.")}
            {num("updateIntervalMinutes", "Maximum update interval (minutes)", "Spec: 120.")}
            {num("restorationStabilityMinutes", "Restoration stability period (minutes)", "Link must stay up this long before 'restored' is sent.")}
            <label className="flex items-center gap-2 pt-5 text-[13px]"><input type="checkbox" checked={s.resetIntervalOnImmediate} onChange={(e) => setS({ ...s, resetIntervalOnImmediate: e.target.checked })} /> Restart the 2-hour clock after an immediate technical update</label>
            {num("relatedIncidentWindowMinutes", "Link repeat outages within (minutes)")}
            {num("correlationWindowMinutes", "Correlate multi-site outages within (minutes)")}
            {num("businessHoursStart", "Business hours start (hour)")}{num("businessHoursEnd", "Business hours end (hour)")}
            {num("bounceInvalidThreshold", "Hard bounces before a contact is marked invalid")}
            {num("monitoringSilenceAlertMinutes", "Alert if NetXMS is silent for (minutes)", "Set up the NetXMS heartbeat so quiet periods don't false-alarm.")}
            <Field label="Support contact line ({{support_contact}})"><input className={inputCls} value={s.supportContact} onChange={(e) => setS({ ...s, supportContact: e.target.value })} /></Field>
            <Field label="NetXMS 'down' events" hint="Comma-separated"><input className={inputCls} value={s.downEvents.join(", ")} onChange={(e) => setS({ ...s, downEvents: e.target.value.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean) })} /></Field>
            <Field label="NetXMS 'up' events"><input className={inputCls} value={s.upEvents.join(", ")} onChange={(e) => setS({ ...s, upEvents: e.target.value.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean) })} /></Field>
            <Field label="Delivery retry backoff (minutes)"><input className={inputCls} value={s.deliveryRetryMinutes.join(", ")} onChange={(e) => setS({ ...s, deliveryRetryMinutes: e.target.value.split(",").map((x) => Number(x.trim())).filter((x) => x > 0) })} /></Field>
          </div>
        </Card>
      )}
      <Crud resource="escalation-rules" title="Escalation rules"
        fields={[
          { key: "trigger", label: "Trigger", type: "select", options: ["cause_overdue", "dispatch_not_created", "dispatch_unacknowledged", "technical_update_overdue", "eta_passed", "rfo_overdue", "communication_overdue", "delivery_failed"].map((v) => ({ value: v, label: v.replace(/_/g, " ") })) },
          { key: "level", label: "Level", type: "number" }, { key: "afterMinutes", label: "After (minutes)", type: "number" },
          { key: "window", label: "When", type: "select", options: [{ value: "always", label: "Always" }, { value: "business_hours", label: "Business hours only" }, { value: "after_hours", label: "After hours only" }] },
          { key: "notifyRoles", label: "Notify roles", type: "multiselect", options: [{ value: "service_desk", label: "Service Desk" }, { value: "technical", label: "Technical" }, { value: "admin", label: "Administrators" }] },
          { key: "notifyTeam", label: "Notify the site's technical team mailbox", type: "bool" }, { key: "notifyEmails", label: "Also email", type: "tags" },
          { key: "description", label: "Description" }, { key: "active", label: "Active", type: "bool" },
        ]}
        columns={[
          { label: "Trigger", render: (r: any) => <>{r.trigger.replace(/_/g, " ")} {active(r)}<div className="text-2xs text-ink-muted">{r.description}</div></> },
          { label: "Level", render: (r: any) => `L${r.level}` }, { label: "After", render: (r: any) => `${r.afterMinutes} min` },
          { label: "Notify", render: (r: any) => [...r.notifyRoles, r.notifyTeam ? "site team" : null, ...r.notifyEmails].filter(Boolean).join(", ") },
          { label: "When", render: (r: any) => r.window.replace("_", " ") },
        ]} />
      <Crud resource="causes" title="Service Desk cause options" idOf={(r: any) => r.key}
        fields={[
          { key: "key", label: "Key", createOnly: true, hint: "lowercase_with_underscores" }, { key: "label", label: "Button label" },
          { key: "publicDescription", label: "Customer wording ({{confirmed_cause}})", warn: "Inserted verbatim into customer messages — word carefully." },
          { key: "category", label: "Category", type: "select", options: [{ value: "power_area", label: "Power — area" }, { value: "power_server_room", label: "Power — server room" }, { value: "power_ok", label: "Power confirmed" }, { value: "other", label: "Other" }] },
          { key: "templateKind", label: "Message to send", type: "select", options: kindOpts }, { key: "periodicKind", label: "2-hourly no-update message", type: "select", options: kindOpts },
          { key: "requiresDispatch", label: "Requires URGENT technician dispatch", type: "bool" }, { key: "assignsTechnical", label: "Assign to Technical", type: "bool" },
          { key: "sort", label: "Order", type: "number" }, { key: "active", label: "Active", type: "bool" },
        ]}
        columns={[
          { label: "Option", render: (r: any) => <>{r.label} {active(r)}<div className="text-2xs text-ink-muted">“{r.publicDescription}”</div></> },
          { label: "Sends", render: (r: any) => <span className="font-mono text-[12px]">{r.templateKind}</span> },
          { label: "Dispatch", render: (r: any) => yes(r.requiresDispatch) }, { label: "Technical", render: (r: any) => yes(r.assignsTechnical) },
        ]} />
      <Crud resource="faults" title="Fault vocabulary (for technical updates)" idOf={(r: any) => r.key}
        fields={[
          { key: "key", label: "Key", createOnly: true }, { key: "label", label: "Label" },
          { key: "publicDescription", label: "Customer wording ({{fault_description}})", warn: "Inserted verbatim into customer messages." },
          { key: "templateKind", label: "Message when confirmed", type: "select", options: kindOpts }, { key: "keywords", label: "Recognised phrases", type: "tags", hint: "Comma-separated phrases the extractor looks for" }, { key: "active", label: "Active", type: "bool" },
        ]}
        columns={[{ label: "Fault", render: (r: any) => <>{r.label} {active(r)}<div className="text-2xs text-ink-muted">“{r.publicDescription}”</div></> }, { label: "Phrases", render: (r: any) => <span className="text-2xs">{r.keywords.join(", ")}</span> }]} />
      <Crud resource="providers" title="Backhaul providers"
        fields={[
          { key: "name", label: "Name" }, { key: "publicName", label: "Name used in messages ({{provider_name}})", warn: "Inserted verbatim into customer messages." },
          { key: "aliases", label: "Other spellings (for extraction)", type: "tags" }, { key: "supportEmail", label: "Support email", nullable: true }, { key: "supportPhone", label: "Support phone", nullable: true },
          { key: "slaRestoreMinutes", label: "Restore SLA (minutes)", type: "number", nullable: true }, { key: "active", label: "Active", type: "bool" },
        ]}
        columns={[{ label: "Provider", render: (r: any) => <>{r.name} {active(r)}<div className="text-2xs text-ink-muted">{r.aliases.join(", ")}</div></> }, { label: "NOC", render: (r: any) => <>{r.supportPhone}<div className="text-2xs">{r.supportEmail}</div></> }, { label: "SLA", render: (r: any) => (r.slaRestoreMinutes ? `${r.slaRestoreMinutes} min` : "—") }]} />
    </div>
  );
}

export function Users() {
  return (
    <Crud resource="users" title="Users" search={(r) => `${r.email} ${r.name}`}
      fields={[
        { key: "name", label: "Name", required: true }, { key: "email", label: "Email", required: true },
        { key: "role", label: "Role", type: "select", options: [{ value: "service_desk", label: "Service Desk" }, { value: "technical", label: "Technical / NOC" }, { value: "admin", label: "Administrator" }] },
        { key: "password", label: "Password", type: "password", hint: "Minimum 12 characters. Leave blank to keep the current password." },
        { key: "active", label: "Active", type: "bool" }, { key: "resetMfa", label: "Reset two-factor (user re-enrols)", type: "bool", editOnly: true },
      ]}
      defaults={{ role: "service_desk", active: true } as any}
      columns={[
        { label: "User", render: (r: any) => <>{r.name} {active(r)}<div className="text-2xs text-ink-muted">{r.email}</div></> },
        { label: "Role", render: (r: any) => r.role.replace("_", " ") },
        { label: "2FA", render: (r: any) => (r.mfaEnabled ? <Badge tone="green">on</Badge> : <Badge tone={r.role === "admin" ? "red" : "grey"}>off</Badge>) },
        { label: "Last sign-in", render: (r: any) => <span className="text-2xs">{dateTime(r.lastLoginAt)}</span> },
      ]} />
  );
}

export function System() {
  const { data, reload } = useApi<any>("/api/admin/system", { live: true });
  const [audit, setAudit] = useState<any[] | null>(null);
  useEffect(() => { api<{ items: any[] }>("/api/admin/audit").then((r) => setAudit(r.items)).catch(() => {}); }, []);
  if (!data) return <div className="text-ink-muted">Loading…</div>;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Card title="Delivery mode"><div className={data.deliveryMode === "live" ? "text-[18px] font-bold text-success" : "text-[18px] font-bold text-primary-bright"}>{data.deliveryMode.toUpperCase()}</div><div className="text-2xs text-ink-muted">{data.deliveryMode === "live" ? "Messages are delivered to real recipients." : "Capture mode: nothing leaves the system."}</div></Card>
        <Card title="Worker"><div className={data.workerOk ? "text-[18px] font-bold text-success" : "text-[18px] font-bold text-primary-bright"}>{data.workerOk ? "Running" : "NOT RUNNING"}</div><div className="text-2xs text-ink-muted">Last heartbeat {dateTime(data.workerLastSeen)}</div></Card>
        <Card title="Job queue"><div className="text-[13px]">{data.queue.map((q: any) => <div key={q.status}>{q.status}: <b>{q.n}</b></div>)}{!data.queue.length && "Idle"}</div><div className="text-2xs text-ink-muted">Dead-letter: {data.deadJobs.length}</div></Card>
        <Card title="Audit log integrity"><div className={data.auditChain.ok ? "text-[18px] font-bold text-success" : "text-[18px] font-bold text-primary-bright"}>{data.auditChain.ok ? "Verified" : `BROKEN at #${data.auditChain.brokenAt}`}</div><div className="text-2xs text-ink-muted">{data.auditChain.checked} entries checked</div></Card>
      </div>
      <Card title="Integrations">
        <table className="w-full text-[13px]"><tbody>{data.health.filter((h: any) => h.key !== "sweep_lease").map((h: any) => (
          <tr key={h.key} className="border-t border-line first:border-0"><td className="py-1.5 pr-3 font-semibold">{h.label}</td><td className="pr-3">last OK {dateTime(h.lastSuccessAt)}</td><td className="text-2xs text-ink-muted">{h.lastErrorAt && <>last error {dateTime(h.lastErrorAt)}: {h.lastError}</>}</td></tr>
        ))}</tbody></table>
      </Card>
      <Tokens />
      {data.deliveryMode === "capture" && <Simulator />}
      {data.unmatchedEvents.length > 0 && <Card title="Unmatched monitoring events (add identifiers in Sites)"><ul className="space-y-1 text-[12.5px]">{data.unmatchedEvents.map((e: any) => <li key={e.id}><span className="font-mono">{e.objectRef || "—"}</span> {e.objectName} · {e.eventName} · {dateTime(e.receivedAt)}</li>)}</ul></Card>}
      {data.deadJobs.length > 0 && <Card title="Dead-letter jobs"><ul className="space-y-1 text-[12.5px]">{data.deadJobs.map((j: any) => <li key={j.id} className="flex items-center gap-2"><span className="font-mono">#{j.id} {j.kind}</span><span className="flex-1 truncate text-ink-muted">{j.lastError}</span><Button size="sm" onClick={async () => { await api(`/api/admin/jobs/${j.id}`, { body: {} }); reload(); }}>Retry</Button></li>)}</ul></Card>}
      <Card title="Audit log (latest 100)">
        <div className="max-h-[480px] overflow-y-auto">
          <table className="w-full text-[12px]"><tbody>{audit?.map((a) => (
            <tr key={a.id} className="border-t border-line align-top first:border-0"><td className="whitespace-nowrap py-1 pr-2 text-ink-muted">{dateTime(a.at)}</td><td className="pr-2">{a.actorLabel}</td><td className="pr-2 font-mono">{a.action}</td><td className="truncate text-ink-muted">{a.entityType} {String(a.entityId).slice(0, 8)}</td></tr>
          ))}</tbody></table>
        </div>
      </Card>
    </div>
  );
}

function Tokens() {
  const [d, setD] = useState<{ tokens: { name: string; source: string; value: string }[]; encryptionKeySource: string } | null>(null);
  const [show, setShow] = useState<string | null>(null);
  const load = () => api<any>("/api/admin/secrets").then(setD).catch(() => {});
  const LABEL: Record<string, string> = { ingestNetxms: "NetXMS ingestion token (Authorization: Bearer …)", ingestGeneric: "Generic monitoring ingestion token", bounceWebhook: "Bounce processor token" };
  return (
    <Card title="Integration tokens" actions={!d && <Button size="sm" onClick={load}>Show</Button>}>
      {!d ? <div className="text-[13px] text-ink-muted">Tokens NetXMS and other systems use to send events to the portal. Viewing them is recorded in the audit log.</div> : (
        <div className="space-y-2 text-[13px]">
          {d.tokens.map((t) => (
            <div key={t.name} className="flex flex-wrap items-center gap-2">
              <span className="w-72 font-semibold">{LABEL[t.name]}</span>
              <code className="flex-1 break-all rounded bg-background px-2 py-1 font-mono text-[12px]">{show === t.name ? t.value : "•".repeat(24)}</code>
              <Button size="sm" variant="ghost" onClick={() => setShow(show === t.name ? null : t.name)}>{show === t.name ? "Hide" : "Reveal"}</Button>
              {t.source === "database" && <Button size="sm" variant="ghost" onClick={async () => { if (confirm("Rotate this token? The old one stops working immediately.")) { await api("/api/admin/secrets", { body: { name: t.name } }); load(); } }}>Rotate</Button>}
              {t.source === "environment" && <Badge>set in environment</Badge>}
            </div>
          ))}
          {d.encryptionKeySource === "database" && <div className="text-2xs text-warning">The MFA encryption key is stored in the database. For production, set APP_ENCRYPTION_KEY in the hosting environment.</div>}
        </div>
      )}
    </Card>
  );
}

function Simulator() {
  const { data } = useApi<{ items: any[] }>("/api/admin/sites");
  const [site, setSite] = useState(""); const [msg, setMsg] = useState<string | null>(null);
  async function fire(state: "down" | "up") {
    setMsg(null);
    try { const r = await api<any>("/api/admin/simulate", { body: { siteId: site, state } }); setMsg(`${state.toUpperCase()} sent → ${r.result}${r.note ? ` (${r.note})` : ""}. Watch it on the Operations screen.`); }
    catch (e) { setMsg((e as Error).message); }
  }
  return (
    <Card title="Outage simulator (capture mode only)">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <select className={`${inputCls} max-w-xs`} value={site} onChange={(e) => setSite(e.target.value)}><option value="">Choose a site…</option>{data?.items.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select>
        <Button size="sm" variant="danger" disabled={!site} onClick={() => fire("down")}>Site goes DOWN</Button>
        <Button size="sm" variant="success" disabled={!site} onClick={() => fire("up")}>Site comes UP</Button>
      </div>
      <p className="mt-2 text-2xs text-ink-muted">Sends the same event NetXMS would. Down for 3+ minutes → first message (captured, not sent). Up within 3 minutes → short interruption.</p>
      {msg && <div className="mt-2 text-[13px]">{msg}</div>}
    </Card>
  );
}
