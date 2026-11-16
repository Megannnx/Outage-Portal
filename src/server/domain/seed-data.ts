/**
 * Reference data shipped with the portal. Template wording here is a STARTING
 * POINT: in production it is loaded as "pending approval" and nothing is sent
 * until an administrator approves and publishes each template.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../db/client";
import { causeOptions, communicationTemplates, escalationRules, faultTypes, roles, templateApprovals, templateVersions } from "../db/schema";
import { clock } from "../lib/clock";

export const ROLE_ROWS = [
  { key: "service_desk" as const, name: "Service Desk", description: "Confirms causes, logs urgent dispatches, follows incidents.", requiresMfa: false },
  { key: "technical" as const, name: "Technical / NOC", description: "Enters supplier and technician updates, ETAs and RFOs.", requiresMfa: false },
  { key: "admin" as const, name: "Administrator", description: "Templates, policies, sites, recipients, users, reports, audit.", requiresMfa: true },
];

export const CAUSE_ROWS = [
  { key: "power_area", label: "Power outage — area wide", publicDescription: "an electricity outage affecting the area", category: "power_area", templateKind: "power_area", requiresDispatch: false, assignsTechnical: false, periodicKind: "power_still_unavailable", sort: 10 },
  { key: "power_server_room", label: "Power outage — server room", publicDescription: "a power interruption at the site's network equipment room", category: "power_server_room", templateKind: "power_server_room", requiresDispatch: true, assignsTechnical: true, periodicKind: "no_update", sort: 20 },
  { key: "power_ok", label: "Power confirmed on site", publicDescription: "a network fault that is under investigation", category: "power_ok", templateKind: "power_ok_investigating", requiresDispatch: false, assignsTechnical: true, periodicKind: "awaiting_backhaul", sort: 30 },
  { key: "fibre_break", label: "Fibre break", publicDescription: "a fibre break", category: "other", templateKind: "fibre_break", requiresDispatch: false, assignsTechnical: true, periodicKind: "no_update", sort: 40 },
  { key: "backhaul_failure", label: "Backhaul failure", publicDescription: "a fault on our backhaul provider's network", category: "other", templateKind: "backhaul_failure", requiresDispatch: false, assignsTechnical: true, periodicKind: "awaiting_backhaul", sort: 50 },
  { key: "equipment_failure", label: "Equipment failure", publicDescription: "a network equipment failure", category: "other", templateKind: "equipment_failure", requiresDispatch: false, assignsTechnical: true, periodicKind: "no_update", sort: 60 },
  { key: "config_issue", label: "Network configuration issue", publicDescription: "a network configuration issue", category: "other", templateKind: "unknown_cause", requiresDispatch: false, assignsTechnical: true, periodicKind: "no_update", sort: 70 },
  { key: "unknown", label: "Unknown / still investigating", publicDescription: "a fault that is still being investigated", category: "other", templateKind: "unknown_cause", requiresDispatch: false, assignsTechnical: true, periodicKind: "no_update", sort: 80 },
];

export const FAULT_ROWS = [
  { key: "fibre_break", label: "Fibre break", publicDescription: "a fibre break on their network", templateKind: "fibre_break",
    keywords: ["fibre break", "fiber break", "fibre cut", "fiber cut", "cable cut", "fibre damage", "fiber damage", "cable damage", "break on the fibre", "dug up", "cable theft"] },
  { key: "backhaul_failure", label: "Backhaul failure", publicDescription: "a fault on their network", templateKind: "backhaul_failure",
    keywords: ["backhaul", "upstream outage", "upstream fault", "core network", "transit outage", "provider outage", "link down on their side"] },
  { key: "equipment_failure", label: "Equipment failure", publicDescription: "an equipment failure", templateKind: "equipment_failure",
    keywords: ["faulty equipment", "equipment failure", "hardware failure", "failed switch", "faulty switch", "router failure", "faulty router", "faulty sfp", "psu failure", "faulty card", "olt failure"] },
  { key: "power_provider", label: "Power at provider site", publicDescription: "a power outage affecting their equipment", templateKind: "backhaul_failure",
    keywords: ["load shedding", "loadshedding", "no power at the pop", "power outage at the pop", "power failure at their site", "utility power"] },
];

const SIG = "\n\nReference: {{incident_reference}}\n{{support_contact}}";
const NEXT = "{{#next_update_time}} We will send a further update by {{next_update_time}}.{{/next_update_time}}";

export const TEMPLATE_ROWS: { kind: string; name: string; subject: string; body: string }[] = [
  { kind: "initial_outage", name: "Initial outage detected", subject: "Network interruption – {{estate_name}} [{{incident_reference}}]",
    body: `Dear Client,\n\nWe are aware of a network interruption currently affecting {{estate_name}}.\n\nOur technical team is investigating the cause of the outage.${NEXT}\n\nWe apologise for the inconvenience.${SIG}` },
  { kind: "power_area", name: "Area-wide power outage", subject: "Update: power outage affecting {{estate_name}} [{{incident_reference}}]",
    body: `Dear Client,\n\nWe have confirmed that the network interruption affecting {{estate_name}} is caused by an electricity outage in the area.\n\nService will be restored once power returns and our equipment comes back online. We are monitoring the site continuously.${NEXT}\n\nWe apologise for the inconvenience.${SIG}` },
  { kind: "power_server_room", name: "Server-room power outage", subject: "Update: network interruption – {{estate_name}} [{{incident_reference}}]",
    body: `Dear Client,\n\nThe network interruption affecting {{estate_name}} has been traced to a power interruption at the site's network equipment room.\n\nA technician is being dispatched to attend to the problem on site.${NEXT}\n\nWe apologise for the inconvenience.${SIG}` },
  { kind: "power_ok_investigating", name: "Power confirmed — network investigation", subject: "Update: network interruption – {{estate_name}} [{{incident_reference}}]",
    body: `Dear Client,\n\nWe have confirmed that power is available at {{estate_name}}. The interruption remains under technical investigation and our team is working to identify the cause.${NEXT}\n\nWe apologise for the inconvenience.${SIG}` },
  { kind: "unknown_cause", name: "Unknown cause / still investigating", subject: "Update: network interruption – {{estate_name}} [{{incident_reference}}]",
    body: `Dear Client,\n\nOur technical team is continuing to investigate the network interruption affecting {{estate_name}}.{{#confirmed_cause}} The interruption is being caused by {{confirmed_cause}}.{{/confirmed_cause}}${NEXT}\n\nWe apologise for the inconvenience.${SIG}` },
  { kind: "backhaul_failure", name: "Backhaul failure", subject: "Update: network interruption – {{estate_name}} [{{incident_reference}}]",
    body: `Dear Client,\n\nWe would like to provide an update regarding the network interruption affecting {{site_name}}.\n\n{{#provider_name}}Our backhaul provider, {{provider_name}}, has confirmed{{/provider_name}}{{^provider_name}}Our backhaul provider has confirmed{{/provider_name}} {{#fault_description}}{{fault_description}}{{/fault_description}}{{^fault_description}}a fault on their network{{/fault_description}}.\n\n{{#eta}}The current estimated restoration time is {{eta}}.{{/eta}}{{^eta}}No estimated restoration time has been confirmed yet.{{/eta}}${NEXT}\n\nWe apologise for the inconvenience.${SIG}` },
  { kind: "fibre_break", name: "Fibre break confirmed", subject: "Update: fibre break affecting {{estate_name}} [{{incident_reference}}]",
    body: `Dear Client,\n\nWe would like to provide an update regarding the network interruption affecting {{site_name}}.\n\n{{#provider_name}}Our backhaul provider, {{provider_name}}, has{{/provider_name}}{{^provider_name}}We have{{/provider_name}} confirmed a fibre break.\n\n{{#eta}}The current estimated restoration time is {{eta}}.{{/eta}}{{^eta}}No estimated restoration time has been confirmed yet.{{/eta}}${NEXT}\n\nWe apologise for the inconvenience.${SIG}` },
  { kind: "equipment_failure", name: "Equipment failure", subject: "Update: network interruption – {{estate_name}} [{{incident_reference}}]",
    body: `Dear Client,\n\nThe network interruption affecting {{site_name}} has been traced to {{#fault_description}}{{fault_description}}{{/fault_description}}{{^fault_description}}an equipment failure{{/fault_description}}. Our team is working on the replacement or repair.\n\n{{#eta}}The current estimated restoration time is {{eta}}.{{/eta}}{{^eta}}No estimated restoration time has been confirmed yet.{{/eta}}${NEXT}\n\nWe apologise for the inconvenience.${SIG}` },
  { kind: "technicians_dispatched", name: "Technicians dispatched", subject: "Update: technicians dispatched – {{estate_name}} [{{incident_reference}}]",
    body: `Dear Client,\n\nTechnicians have been dispatched to attend to the network interruption affecting {{site_name}}.{{#fault_description}} The cause has been confirmed as {{fault_description}}.{{/fault_description}}\n\n{{#eta}}The current estimated restoration time is {{eta}}.{{/eta}}{{^eta}}No estimated restoration time has been confirmed yet.{{/eta}}${NEXT}\n\nWe apologise for the inconvenience.${SIG}` },
  { kind: "technicians_on_site", name: "Technicians on site", subject: "Update: technicians on site – {{estate_name}} [{{incident_reference}}]",
    body: `Dear Client,\n\nTechnicians are now on site attending to the network interruption affecting {{site_name}}.{{#fault_description}} The cause has been confirmed as {{fault_description}}.{{/fault_description}}\n\n{{#eta}}The current estimated restoration time is {{eta}}.{{/eta}}{{^eta}}No estimated restoration time has been confirmed yet.{{/eta}}${NEXT}\n\nWe apologise for the inconvenience.${SIG}` },
  { kind: "repairs_underway", name: "Repairs underway", subject: "Update: repairs in progress – {{estate_name}} [{{incident_reference}}]",
    body: `Dear Client,\n\nRepairs are now in progress on the fault affecting {{site_name}}.{{#fault_description}} The cause has been confirmed as {{fault_description}}.{{/fault_description}}\n\n{{#eta}}The current estimated restoration time is {{eta}}.{{/eta}}{{^eta}}No estimated restoration time has been confirmed yet.{{/eta}}${NEXT}\n\nWe apologise for the inconvenience.${SIG}` },
  { kind: "repair_delayed", name: "Repair delay confirmed", subject: "Update: repair delayed – {{estate_name}} [{{incident_reference}}]",
    body: `Dear Client,\n\nUnfortunately the repair of the fault affecting {{site_name}} has been delayed.\n\n{{#eta}}The revised estimated restoration time is {{eta}}.{{/eta}}{{^eta}}A revised restoration time has not yet been confirmed.{{/eta}}${NEXT}\n\nWe apologise for the inconvenience.${SIG}` },
  { kind: "repairs_completed", name: "Repair work completed — monitoring", subject: "Update: repair work completed – {{estate_name}} [{{incident_reference}}]",
    body: `Dear Client,\n\nRepair work on the fault affecting {{site_name}} has been completed and we are waiting for the service to come back online. We are monitoring the site and will confirm as soon as service is restored.${SIG}` },
  { kind: "eta_available", name: "ETA available", subject: "Update: estimated restoration {{eta}} – {{estate_name}} [{{incident_reference}}]",
    body: `Dear Client,\n\nWe would like to provide an update regarding the network interruption affecting {{site_name}}.{{#fault_description}}\n\n{{#provider_name}}Our backhaul provider, {{provider_name}}, has confirmed{{/provider_name}}{{^provider_name}}It has been confirmed that the cause is{{/provider_name}} {{fault_description}}.{{/fault_description}}\n\nThe current estimated restoration time is {{eta}}.\n\nWe will continue monitoring the situation and provide further updates.\n\nWe apologise for the inconvenience.${SIG}` },
  { kind: "eta_changed", name: "ETA changed", subject: "Update: revised restoration time {{eta}} – {{estate_name}} [{{incident_reference}}]",
    body: `Dear Client,\n\nThe estimated restoration time for the network interruption affecting {{site_name}} has been revised.\n\nThe new estimated restoration time is {{eta}}.${NEXT}\n\nWe apologise for the inconvenience.${SIG}` },
  { kind: "eta_unavailable", name: "ETA unavailable", subject: "Update: network interruption – {{estate_name}} [{{incident_reference}}]",
    body: `Dear Client,\n\nOur technical team is continuing to investigate the network interruption affecting {{estate_name}}.\n\nAt this stage, no estimated restoration time has been confirmed.${NEXT}\n\nWe will provide further communication as soon as additional information becomes available.${SIG}` },
  { kind: "no_update", name: "No update available", subject: "Update: network interruption – {{estate_name}} [{{incident_reference}}]",
    body: `Dear Client,\n\nThe network interruption affecting {{estate_name}} is still being worked on.{{#repair_status}} Current status: {{repair_status}}.{{/repair_status}}\n\n{{#eta}}The estimated restoration time remains {{eta}}.{{/eta}}{{^eta}}No estimated restoration time has been confirmed yet.{{/eta}}${NEXT}\n\nWe apologise for the inconvenience.${SIG}` },
  { kind: "awaiting_backhaul", name: "Awaiting backhaul feedback", subject: "Update: network interruption – {{estate_name}} [{{incident_reference}}]",
    body: `Dear Client,\n\nWe are still awaiting feedback from our backhaul provider regarding the network interruption affecting {{estate_name}}. We are following up with them and will share their response as soon as we receive it.${NEXT}\n\nWe apologise for the inconvenience.${SIG}` },
  { kind: "power_still_unavailable", name: "Power still unavailable", subject: "Update: power outage affecting {{estate_name}} [{{incident_reference}}]",
    body: `Dear Client,\n\nPower remains unavailable in the area affecting {{estate_name}}. Service will be restored automatically once power returns and our equipment comes back online.${NEXT}\n\nWe apologise for the inconvenience.${SIG}` },
  { kind: "restored_awaiting_rfo", name: "Link restored — awaiting RFO", subject: "Restored: network service – {{estate_name}} [{{incident_reference}}]",
    body: `Dear Client,\n\nNetwork service to {{estate_name}} was restored at {{restored_time}}.\n\nWe are awaiting the formal reason for the outage and will share it with you once received.\n\nThank you for your patience.${SIG}` },
  { kind: "final_rfo", name: "Final RFO / resolution", subject: "Resolved: reason for outage – {{estate_name}} [{{incident_reference}}]",
    body: `Dear Client,\n\nFurther to the network interruption affecting {{estate_name}} from {{outage_start_time}} to {{restored_time}}, the reason for the outage was:\n\n{{rfo}}\n\nThis incident is now resolved. Thank you for your patience.${SIG}` },
  { kind: "final_no_rfo", name: "Final resolution (RFO not required)", subject: "Resolved: network service – {{estate_name}} [{{incident_reference}}]",
    body: `Dear Client,\n\nThe network interruption affecting {{estate_name}} from {{outage_start_time}} has been resolved{{#restored_time}} and service was restored at {{restored_time}}{{/restored_time}}.\n\nThank you for your patience.${SIG}` },
];

export const ESCALATION_ROWS = [
  { trigger: "cause_overdue", level: 1, afterMinutes: 10, notifyRoles: ["service_desk"], notifyTeam: false, description: "Remind the Service Desk to confirm the cause" },
  { trigger: "cause_overdue", level: 2, afterMinutes: 20, notifyRoles: ["admin"], notifyTeam: false, description: "Supervisor: cause still unconfirmed" },
  { trigger: "dispatch_not_created", level: 1, afterMinutes: 5, notifyRoles: ["service_desk", "admin"], notifyTeam: false, description: "Server-room power: dispatch not logged" },
  { trigger: "dispatch_unacknowledged", level: 1, afterMinutes: 15, notifyRoles: ["technical"], notifyTeam: true, description: "Dispatch not acknowledged" },
  { trigger: "dispatch_unacknowledged", level: 2, afterMinutes: 30, notifyRoles: ["admin"], notifyTeam: false, description: "Dispatch still not acknowledged" },
  { trigger: "technical_update_overdue", level: 1, afterMinutes: 60, notifyRoles: ["technical"], notifyTeam: true, description: "Chase backhaul provider for an update" },
  { trigger: "technical_update_overdue", level: 2, afterMinutes: 120, notifyRoles: ["admin"], notifyTeam: false, description: "No technical update for 2 hours" },
  { trigger: "eta_passed", level: 1, afterMinutes: 15, notifyRoles: ["technical"], notifyTeam: true, description: "ETA passed — obtain a new one" },
  { trigger: "rfo_overdue", level: 1, afterMinutes: 1440, notifyRoles: ["technical"], notifyTeam: true, description: "RFO outstanding 24h" },
  { trigger: "rfo_overdue", level: 2, afterMinutes: 4320, notifyRoles: ["admin"], notifyTeam: false, description: "RFO outstanding 3 days" },
  { trigger: "communication_overdue", level: 1, afterMinutes: 10, notifyRoles: ["admin"], notifyTeam: false, description: "Customer update overdue — scheduler problem" },
  { trigger: "delivery_failed", level: 1, afterMinutes: 0, notifyRoles: ["admin"], notifyTeam: false, description: "Customer communication failed" },
];

/**
 * Idempotent. `publishAs` = user id → templates are published with a recorded approval
 * (demo/test). Otherwise they await administrator approval.
 */
export async function seedReferenceData(db: Tx, opts: { publishAs?: string | null } = {}) {
  for (const r of ROLE_ROWS) await db.insert(roles).values(r).onConflictDoNothing();
  for (const c of CAUSE_ROWS) await db.insert(causeOptions).values(c).onConflictDoNothing();
  for (const f of FAULT_ROWS) await db.insert(faultTypes).values(f).onConflictDoNothing();
  for (const e of ESCALATION_ROWS) await db.insert(escalationRules).values({ ...e, notifyEmails: [] }).onConflictDoNothing();
  for (const t of TEMPLATE_ROWS) {
    const [tpl] = await db.insert(communicationTemplates).values({ kind: t.kind, audience: "all", name: t.name, builtIn: true })
      .onConflictDoNothing().returning();
    if (!tpl) continue;
    const [v] = await db.insert(templateVersions).values({
      templateId: tpl.id, version: 1, subject: t.subject, body: t.body, changeNote: "Initial wording supplied with the portal",
      status: opts.publishAs ? "published" : "pending_approval", submittedAt: clock.now(), publishedAt: opts.publishAs ? clock.now() : null,
      createdBy: opts.publishAs ?? null,
    }).returning();
    if (opts.publishAs) await db.insert(templateApprovals).values({ templateVersionId: v.id, approverId: opts.publishAs, decision: "approved", comment: "Seeded for demo/test environment" });
  }
  void and; void eq; void sql;
}
