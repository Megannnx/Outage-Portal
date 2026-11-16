/**
 * Go-live readiness: every condition that must hold before DELIVERY_MODE=live,
 * computed from the database and configuration (never from memory or guesses).
 */
import { sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { getAdapter, deliveryMode } from "../comms/adapters";
import { KINDS } from "../domain/catalog";
import { secretSource } from "../lib/secrets";

export interface Check { key: string; label: string; status: "ok" | "warn" | "fail"; detail: string; fix?: string }

const n = async (db: DB, q: ReturnType<typeof sql>) => Number(((await db.execute(q)).rows[0] as { n: number | string }).n);

export async function readiness(db: DB): Promise<{ mode: string; ready: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  const real = sql`code not like 'DEMO-%' and active`;
  const sitesTotal = await n(db, sql`select count(*) as n from sites where ${real}`);
  const noIdent = await n(db, sql`select count(*) as n from sites s where ${real} and not exists (select 1 from site_monitoring_identifiers i where i.site_id = s.id and i.critical)`);
  const noRes = await n(db, sql`select count(*) as n from sites where ${real} and resident_list_ref = ''`);
  const noIsp = await n(db, sql`select count(*) as n from sites s where ${real} and not exists (select 1 from site_isps x where x.site_id = s.id)`);
  const ispNoContact = await n(db, sql`select count(*) as n from isps i where i.active and i.name not like '%(DEMO)' and not exists (select 1 from recipients r where r.isp_id = i.id and r.status = 'active')`);
  add({ key: "sites", label: "Sites loaded", status: sitesTotal ? "ok" : "fail", detail: `${sitesTotal} active site(s)`, fix: "Admin › Sites & monitoring › Bulk update from a spreadsheet" });
  add({ key: "netxms_ids", label: "Every site linked to a NetXMS device", status: !sitesTotal ? "fail" : noIdent === 0 ? "ok" : noIdent === sitesTotal ? "fail" : "warn",
    detail: noIdent ? `${noIdent} of ${sitesTotal} site(s) have no critical NetXMS device — outages there will not be detected` : "All sites linked", fix: "Fill in 'NetXMS object ID' in the sites spreadsheet" });
  add({ key: "residents", label: "Every site has a residents list reference", status: noRes === 0 && sitesTotal ? "ok" : noRes === sitesTotal ? "fail" : "warn",
    detail: noRes ? `${noRes} site(s) have no residents list — residents there will not be notified` : "All sites have one", fix: "Fill in 'Residents list reference' in the sites spreadsheet" });
  add({ key: "isps", label: "Every site has its ISPs", status: noIsp === 0 && sitesTotal ? "ok" : noIsp === sitesTotal ? "fail" : "warn",
    detail: noIsp ? `${noIsp} site(s) have no ISPs linked` : "All sites have ISPs", fix: "Fill in 'ISPs on this site' in the sites spreadsheet" });
  add({ key: "isp_contacts", label: "Every ISP has a working contact", status: ispNoContact ? "fail" : "ok",
    detail: ispNoContact ? `${ispNoContact} ISP(s) have no active contact email` : "All ISPs have contacts", fix: "ISP contacts tab of the spreadsheet, or Admin › ISPs & contacts" });

  // Templates: published, and approved by a person (not by the demo/test setup)
  const kinds = KINDS.map((k) => k.kind);
  const published = (await db.execute(sql`select t.kind, tv.id, (select string_agg(a.comment, '|') from template_approvals a where a.template_version_id = tv.id) as comments
    from template_versions tv join communication_templates t on t.id = tv.template_id where tv.status = 'published'`)).rows as { kind: string; id: string; comments: string | null }[];
  const missing = kinds.filter((k) => !published.some((p) => p.kind === k));
  const demoApproved = published.filter((p) => /Demo setup|Seeded for demo/i.test(p.comments ?? "")).length;
  add({ key: "templates", label: "All message templates published", status: missing.length ? "fail" : "ok",
    detail: missing.length ? `Not published: ${missing.join(", ")}` : `${published.length} published`, fix: "Admin › Communication templates" });
  add({ key: "template_review", label: "Wording reviewed and approved by an administrator", status: demoApproved ? "fail" : "ok",
    detail: demoApproved ? `${demoApproved} template(s) were auto-approved by the demo setup and have not been reviewed` : "All published wording was approved by an administrator",
    fix: "Use 'Remove demo data' (it returns demo-approved wording to pending approval), then review and approve" });

  // People
  const admins = (await db.execute(sql`select count(*) filter (where active) as n, count(*) filter (where active and mfa_enabled) as m from users where role = 'admin'`)).rows[0] as { n: number; m: number };
  add({ key: "admins", label: "Two administrators with two-factor", status: Number(admins.n) >= 2 && Number(admins.m) >= 2 ? "ok" : "fail",
    detail: `${admins.n} admin(s), ${admins.m} with two-factor — wording changes need a second administrator to approve`, fix: "Admin › Users" });
  const staff = await n(db, sql`select count(*) as n from users where active and role in ('service_desk','technical')`);
  add({ key: "staff", label: "Service Desk and Technical users", status: staff ? "ok" : "warn", detail: `${staff} user(s)`, fix: "Admin › Users" });

  // Integrations
  const smtp = getAdapter("smtp"); const capi = getAdapter("client_api");
  const smtpErr = deliveryMode() === "capture" ? (process.env.SMTP_HOST ? null : "SMTP_HOST is not set") : smtp.configError();
  const capiErr = deliveryMode() === "capture" ? (process.env.CLIENT_API_URL ? null : "CLIENT_API_URL is not set") : capi.configError();
  add({ key: "smtp", label: "Email (SMTP) configured — ISPs & internal", status: smtpErr ? "fail" : "ok", detail: smtpErr ?? `Relay ${process.env.SMTP_HOST}`, fix: "Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM in the hosting environment" });
  add({ key: "client_api", label: "Residents' communications API configured", status: capiErr ? "fail" : "ok", detail: capiErr ?? "Configured", fix: "Set CLIENT_API_URL and CLIENT_API_TOKEN (see docs/INTEGRATIONS.md)" });
  const nx = (await db.execute(sql`select last_success_at from integration_health where key = 'monitoring:netxms'`)).rows[0] as { last_success_at: string | null } | undefined;
  const realEvents = await n(db, sql`select count(*) as n from monitoring_events where source = 'netxms' and raw->>'simulated' is null`);
  add({ key: "netxms", label: "NetXMS is sending events", status: realEvents ? "ok" : "fail",
    detail: realEvents ? `Last contact ${nx?.last_success_at ? new Date(nx.last_success_at).toISOString() : "—"}` : "No real NetXMS events received yet", fix: "docs/NETXMS_SETUP.md — token in Integration tokens below" });
  const worker = (await db.execute(sql`select last_success_at from integration_health where key = 'worker'`)).rows[0] as { last_success_at: string } | undefined;
  const workerOk = !!worker && Date.now() - new Date(worker.last_success_at).getTime() < 3 * 60_000;
  add({ key: "scheduler", label: "Scheduler running", status: workerOk ? "ok" : "fail", detail: workerOk ? "Heartbeat within the last 3 minutes" : "No recent heartbeat", fix: "Check the worker / Supabase cron" });
  add({ key: "encryption", label: "Encryption key held outside the database", status: secretSource("appEncryptionKey") === "environment" ? "ok" : "warn",
    detail: secretSource("appEncryptionKey") === "environment" ? "APP_ENCRYPTION_KEY is set" : "The two-factor encryption key is stored in the database (the self-hosted installer sets it in the environment)" });
  const demo = await n(db, sql`select count(*) as n from sites where code like 'DEMO-%'`);
  add({ key: "demo", label: "Demo data removed", status: demo ? "fail" : "ok", detail: demo ? `${demo} demo site(s) still present` : "No demo data", fix: "Remove demo data (below)" });
  add({ key: "mode", label: "Delivery mode", status: deliveryMode() === "live" ? "ok" : "warn", detail: deliveryMode() === "live" ? "LIVE — messages are being sent" : "Capture mode — switch DELIVERY_MODE to live when everything above is green" });

  const ready = checks.filter((c) => c.key !== "mode").every((c) => c.status !== "fail");
  return { mode: deliveryMode(), ready, checks };
}
