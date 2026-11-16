/**
 * Database schema — the single source of truth for incident state, schedules
 * and communications. Nothing operational lives in application memory or in
 * the browser: if it is not in these tables it did not happen.
 *
 * All timestamps are `timestamptz` and are written in UTC. Display conversion
 * to Africa/Johannesburg happens only at the edges (UI, templates, exports).
 */
import { sql } from "drizzle-orm";
import {
  bigserial, boolean, doublePrecision, index, integer, jsonb, pgEnum, pgTable, primaryKey,
  text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => ts("created_at").notNull().defaultNow();

// ───────────────────────────── Enums ─────────────────────────────

export const roleKey = pgEnum("role_key", ["service_desk", "technical", "admin"]);

/** Engine phase — drives automation. */
export const incidentPhase = pgEnum("incident_phase", [
  "validating",     // inside the 3-minute window, no external comms yet
  "active",         // validated outage, communications running
  "restoring",      // monitoring says up; waiting out the stability period
  "awaiting_rfo",   // restored and communicated; RFO outstanding
  "resolved",       // closed (RFO sent or waived by an administrator)
  "interruption",   // restored inside the validation window — internal only
]);

/** Human-facing status shown on dashboards (derived from phase + facts). */
export const incidentStatus = pgEnum("incident_status", [
  "validating",
  "awaiting_cause",
  "power_area",
  "technician_required",
  "technician_investigating",
  "awaiting_backhaul",
  "under_investigation",
  "restoring",
  "restored_awaiting_rfo",
  "resolved",
  "interruption",
]);

export const audience = pgEnum("audience", ["all", "resident", "isp"]);
export const templateVersionStatus = pgEnum("template_version_status", [
  "draft", "pending_approval", "published", "retired", "rejected",
]);
export const commStatus = pgEnum("comm_status", [
  "queued", "sending", "sent", "partially_failed", "failed", "cancelled", "no_recipients",
]);
export const deliveryStatus = pgEnum("delivery_status", [
  "pending", "sending", "accepted", "delivered", "deferred", "bounced", "failed", "suppressed", "cancelled",
]);
export const jobStatus = pgEnum("job_status", ["pending", "running", "done", "cancelled", "dead"]);
export const dispatchStatus = pgEnum("dispatch_status", [
  "requested", "sent", "acknowledged", "on_site", "completed", "cancelled",
]);
export const recipientStatus = pgEnum("recipient_status", ["active", "suppressed", "invalid"]);
export const rfoStatus = pgEnum("rfo_status", ["not_applicable", "awaiting", "sent", "waived"]);
export const eventKind = pgEnum("event_kind", ["down", "up", "heartbeat", "unknown"]);
export const eventProcessing = pgEnum("event_processing", [
  "processed", "duplicate", "unmatched", "stale", "ignored", "error",
]);

// ───────────────────────────── Identity & access ─────────────────────────────

export const roles = pgTable("roles", {
  key: roleKey("key").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  requiresMfa: boolean("requires_mfa").notNull().default(false),
});

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  role: roleKey("role").notNull().references(() => roles.key),
  passwordHash: text("password_hash").notNull(),
  mfaSecretEnc: text("mfa_secret_enc"),
  mfaEnabled: boolean("mfa_enabled").notNull().default(false),
  active: boolean("active").notNull().default(true),
  failedLogins: integer("failed_logins").notNull().default(0),
  lockedUntil: ts("locked_until"),
  lastLoginAt: ts("last_login_at"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("users_email_uq").on(sql`lower(${t.email})`)]);

export const sessions = pgTable("sessions", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  mfaVerified: boolean("mfa_verified").notNull().default(false),
  createdAt: createdAt(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  revokedAt: ts("revoked_at"),
  ip: text("ip"),
  userAgent: text("user_agent"),
});

// ───────────────────────────── Network inventory ─────────────────────────────

export const backhaulProviders = pgTable("backhaul_providers", {
  id: id(),
  name: text("name").notNull().unique(),
  /** Wording used in customer communications (admin-controlled). */
  publicName: text("public_name").notNull(),
  /** Extra spellings the extraction engine should recognise, e.g. "DFA", "Dark Fibre Africa". */
  aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
  supportEmail: text("support_email"),
  supportPhone: text("support_phone"),
  slaRestoreMinutes: integer("sla_restore_minutes"),
  active: boolean("active").notNull().default(true),
});

export const sites = pgTable("sites", {
  id: id(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  estate: text("estate").notNull().default(""),
  region: text("region").notNull().default(""),
  address: text("address").notNull().default(""),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  backhaulProviderId: uuid("backhaul_provider_id").references(() => backhaulProviders.id),
  circuitRef: text("circuit_ref").notNull().default(""),
  /** Common upstream point (POP, aggregation switch) used to correlate multi-site outages. */
  upstreamRef: text("upstream_ref").notNull().default(""),
  technicalTeam: text("technical_team").notNull().default("NOC"),
  /** Distribution reference in the client communications API (resident list). */
  residentListRef: text("resident_list_ref").notNull().default(""),
  rfoRequired: boolean("rfo_required").notNull().default(true),
  active: boolean("active").notNull().default(true),
  notes: text("notes").notNull().default(""),
  createdAt: createdAt(),
});

export const siteMonitoringIdentifiers = pgTable("site_monitoring_identifiers", {
  id: id(),
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  source: text("source").notNull(),          // netxms | telegram | generic
  matchType: text("match_type").notNull(),   // object_id | name_exact | name_prefix
  value: text("value").notNull(),
  /** Only critical objects (headend/uplink) decide whether the SITE is down. */
  critical: boolean("critical").notNull().default(true),
  label: text("label").notNull().default(""),
}, (t) => [uniqueIndex("smi_uq").on(t.source, t.matchType, t.value)]);

/** Last known state of each monitored object — protects against out-of-order events. */
export const monitoredObjectState = pgTable("monitored_object_state", {
  identifierId: uuid("identifier_id").primaryKey().references(() => siteMonitoringIdentifiers.id, { onDelete: "cascade" }),
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  state: text("state").notNull(), // up | down
  lastEventAt: ts("last_event_at").notNull(),
  lastEventId: uuid("last_event_id"),
  /** Time of the down that preceded the current state (for out-of-order pairing). */
  lastDownAt: ts("last_down_at"),
  lastUpAt: ts("last_up_at"),
});

export const isps = pgTable("isps", {
  id: id(),
  name: text("name").notNull().unique(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const siteIsps = pgTable("site_isps", {
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  ispId: uuid("isp_id").notNull().references(() => isps.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.siteId, t.ispId] })]);

/**
 * People and mailboxes that receive communications.
 *  - audience=isp:       ISP NOC contacts (linked to an ISP, reached via SMTP individually)
 *  - audience=resident:  optional direct resident contacts for a site (most residents
 *                        are reached through the client API list on the site)
 *  - audience=internal:  escalation / technical team contacts (team or site scoped)
 */
export const recipients = pgTable("recipients", {
  id: id(),
  audience: text("audience").notNull(), // isp | resident | internal
  ispId: uuid("isp_id").references(() => isps.id, { onDelete: "cascade" }),
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "cascade" }),
  team: text("team"),
  name: text("name").notNull().default(""),
  email: text("email").notNull(),
  status: recipientStatus("status").notNull().default("active"),
  statusReason: text("status_reason"),
  bounceCount: integer("bounce_count").notNull().default(0),
  lastBounceAt: ts("last_bounce_at"),
  lastDeliveredAt: ts("last_delivered_at"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  index("recipients_isp_idx").on(t.ispId),
  uniqueIndex("recipients_uq").on(t.audience, sql`coalesce(${t.ispId}::text,'')`, sql`coalesce(${t.siteId}::text,'')`, sql`coalesce(${t.team},'')`, sql`lower(${t.email})`),
]);

// ───────────────────────────── Configuration ─────────────────────────────

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: uuid("updated_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Service Desk cause options (admin-configured). */
export const causeOptions = pgTable("cause_options", {
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  /** Wording inserted as {{confirmed_cause}} in communications. */
  publicDescription: text("public_description").notNull(),
  category: text("category").notNull(), // power_area | power_server_room | power_ok | other
  templateKind: text("template_kind").notNull(),
  requiresDispatch: boolean("requires_dispatch").notNull().default(false),
  assignsTechnical: boolean("assigns_technical").notNull().default(false),
  /** Default template kind for 2-hourly no-update messages under this cause. */
  periodicKind: text("periodic_kind").notNull().default("no_update"),
  sort: integer("sort").notNull().default(100),
  active: boolean("active").notNull().default(true),
});

/** Controlled vocabulary for faults — customer wording is admin-approved, never free text. */
export const faultTypes = pgTable("fault_types", {
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  publicDescription: text("public_description").notNull(),
  templateKind: text("template_kind").notNull(),
  keywords: text("keywords").array().notNull().default(sql`'{}'::text[]`),
  active: boolean("active").notNull().default(true),
});

// ───────────────────────────── Incidents ─────────────────────────────

export const incidentGroups = pgTable("incident_groups", {
  id: id(),
  reference: text("reference").notNull().unique(),
  label: text("label").notNull(),
  reason: text("reason").notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
  closedAt: ts("closed_at"),
});

export const correlationSuggestions = pgTable("correlation_suggestions", {
  id: id(),
  incidentIds: uuid("incident_ids").array().notNull(),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("open"), // open | accepted | dismissed
  createdAt: createdAt(),
  decidedBy: uuid("decided_by"),
  decidedAt: ts("decided_at"),
});

export const incidents = pgTable("incidents", {
  id: id(),
  reference: text("reference").notNull().unique(),
  siteId: uuid("site_id").notNull().references(() => sites.id),
  groupId: uuid("group_id").references(() => incidentGroups.id),
  relatedIncidentId: uuid("related_incident_id"),
  phase: incidentPhase("phase").notNull(),
  status: incidentStatus("status").notNull(),
  causeKey: text("cause_key").references(() => causeOptions.key),
  causeConfirmedBy: uuid("cause_confirmed_by").references(() => users.id),
  causeConfirmedAt: ts("cause_confirmed_at"),
  technicalAssigned: boolean("technical_assigned").notNull().default(false),
  assignedTeam: text("assigned_team"),
  /** Verified technical facts (only confirmed values; see TechState). */
  techState: jsonb("tech_state").notNull().default(sql`'{}'::jsonb`),
  outageStartedAt: ts("outage_started_at").notNull(),
  detectedAt: ts("detected_at").notNull(),
  validatedAt: ts("validated_at"),
  firstCommAt: ts("first_comm_at"),
  lastTechnicalUpdateAt: ts("last_technical_update_at"),
  restorationDetectedAt: ts("restoration_detected_at"),
  restoredAt: ts("restored_at"),
  restorationConfirmedAt: ts("restoration_confirmed_at"),
  resolvedAt: ts("resolved_at"),
  downtimeSeconds: integer("downtime_seconds"),
  flapCount: integer("flap_count").notNull().default(0),
  rfoStatus: rfoStatus("rfo_status").notNull().default("not_applicable"),
  rfoWaiverReason: text("rfo_waiver_reason"),
  retrospective: boolean("retrospective").notNull().default(false),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  index("incidents_phase_idx").on(t.phase),
  index("incidents_site_idx").on(t.siteId, t.createdAt),
  index("incidents_started_idx").on(t.outageStartedAt),
  // One open incident per site — enforced by the database, not by hope.
  uniqueIndex("incidents_one_open_per_site").on(t.siteId).where(sql`${t.phase} in ('validating','active','restoring')`),
]);

export const monitoringEvents = pgTable("monitoring_events", {
  id: id(),
  source: text("source").notNull(),
  dedupeKey: text("dedupe_key").notNull().unique(),
  kind: eventKind("kind").notNull(),
  eventName: text("event_name").notNull().default(""),
  objectRef: text("object_ref").notNull().default(""),
  objectName: text("object_name").notNull().default(""),
  identifierId: uuid("identifier_id"),
  siteId: uuid("site_id").references(() => sites.id),
  incidentId: uuid("incident_id").references(() => incidents.id),
  occurredAt: ts("occurred_at").notNull(),
  receivedAt: ts("received_at").notNull().defaultNow(),
  processing: eventProcessing("processing").notNull(),
  note: text("note").notNull().default(""),
  raw: jsonb("raw").notNull(),
}, (t) => [index("me_site_idx").on(t.siteId, t.occurredAt), index("me_received_idx").on(t.receivedAt)]);

export const incidentTransitions = pgTable("incident_transitions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  incidentId: uuid("incident_id").notNull().references(() => incidents.id),
  fromPhase: incidentPhase("from_phase"),
  toPhase: incidentPhase("to_phase").notNull(),
  fromStatus: incidentStatus("from_status"),
  toStatus: incidentStatus("to_status").notNull(),
  reason: text("reason").notNull(),
  actorId: uuid("actor_id"),
  at: ts("at").notNull().defaultNow(),
}, (t) => [index("it_incident_idx").on(t.incidentId)]);

/** Append-only, denormalised timeline shown in the incident workspace. */
export const timelineEntries = pgTable("timeline_entries", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  incidentId: uuid("incident_id").notNull().references(() => incidents.id),
  at: ts("at").notNull().defaultNow(),
  kind: text("kind").notNull(), // monitoring | cause | technical | communication | dispatch | system | escalation | rfo
  actorId: uuid("actor_id"),
  actorLabel: text("actor_label").notNull().default("System"),
  summary: text("summary").notNull(),
  data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
}, (t) => [index("tl_incident_idx").on(t.incidentId, t.at)]);

export const causeConfirmations = pgTable("cause_confirmations", {
  id: id(),
  incidentId: uuid("incident_id").notNull().references(() => incidents.id),
  causeKey: text("cause_key").notNull().references(() => causeOptions.key),
  confirmedBy: uuid("confirmed_by").notNull().references(() => users.id),
  confirmedAt: ts("confirmed_at").notNull().defaultNow(),
  note: text("note").notNull().default(""),
  supersededAt: ts("superseded_at"),
  isCorrection: boolean("is_correction").notNull().default(false),
});

export const technicalUpdates = pgTable("technical_updates", {
  id: id(),
  incidentId: uuid("incident_id").notNull().references(() => incidents.id),
  authorId: uuid("author_id").notNull().references(() => users.id),
  createdAt: createdAt(),
  /** Exactly what was pasted — never modified. */
  originalText: text("original_text").notNull(),
  extraction: jsonb("extraction").notNull(),
  confirmedFacts: jsonb("confirmed_facts").notNull(),
  changes: text("changes").array().notNull().default(sql`'{}'::text[]`),
  meaningful: boolean("meaningful").notNull(),
  extractor: text("extractor").notNull(),
  communicationIds: uuid("communication_ids").array().notNull().default(sql`'{}'::uuid[]`),
});

export const technicianDispatches = pgTable("technician_dispatches", {
  id: id(),
  incidentId: uuid("incident_id").notNull().references(() => incidents.id),
  reference: text("reference").notNull().unique(),
  priority: text("priority").notNull().default("URGENT"),
  status: dispatchStatus("status").notNull().default("requested"),
  team: text("team").notNull(),
  workOrder: jsonb("work_order").notNull(),
  externalSystem: text("external_system"),
  externalRef: text("external_ref"),
  requestedBy: uuid("requested_by").notNull().references(() => users.id),
  requestedAt: ts("requested_at").notNull().defaultNow(),
  sentAt: ts("sent_at"),
  ackTokenHash: text("ack_token_hash"),
  acknowledgedAt: ts("acknowledged_at"),
  acknowledgedBy: text("acknowledged_by"),
  onSiteAt: ts("on_site_at"),
  completedAt: ts("completed_at"),
  cancelledAt: ts("cancelled_at"),
  notes: text("notes").notNull().default(""),
}, (t) => [index("td_incident_idx").on(t.incidentId)]);

export const rfoRecords = pgTable("rfo_records", {
  id: id(),
  incidentId: uuid("incident_id").notNull().references(() => incidents.id),
  /** Verified customer-facing RFO wording, confirmed by Technical. */
  rfoText: text("rfo_text").notNull(),
  internalNotes: text("internal_notes").notNull().default(""),
  providerRef: text("provider_ref").notNull().default(""),
  receivedAt: ts("received_at").notNull(),
  enteredBy: uuid("entered_by").notNull().references(() => users.id),
  enteredAt: ts("entered_at").notNull().defaultNow(),
  communicationId: uuid("communication_id"),
});

// ───────────────────────────── Templates ─────────────────────────────

export const communicationTemplates = pgTable("communication_templates", {
  id: id(),
  kind: text("kind").notNull(),
  audience: audience("audience").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  builtIn: boolean("built_in").notNull().default(false),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("ct_kind_aud_uq").on(t.kind, t.audience)]);

export const templateVersions = pgTable("template_versions", {
  id: id(),
  templateId: uuid("template_id").notNull().references(() => communicationTemplates.id),
  version: integer("version").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  status: templateVersionStatus("status").notNull().default("draft"),
  changeNote: text("change_note").notNull().default(""),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
  submittedAt: ts("submitted_at"),
  publishedAt: ts("published_at"),
  retiredAt: ts("retired_at"),
}, (t) => [
  uniqueIndex("tv_version_uq").on(t.templateId, t.version),
  uniqueIndex("tv_one_published").on(t.templateId).where(sql`${t.status} = 'published'`),
]);

export const templateApprovals = pgTable("template_approvals", {
  id: id(),
  templateVersionId: uuid("template_version_id").notNull().references(() => templateVersions.id),
  approverId: uuid("approver_id").notNull().references(() => users.id),
  decision: text("decision").notNull(), // approved | rejected
  comment: text("comment").notNull().default(""),
  at: ts("at").notNull().defaultNow(),
});

// ───────────────────────────── Communications ─────────────────────────────

export const communicationSchedules = pgTable("communication_schedules", {
  incidentId: uuid("incident_id").primaryKey().references(() => incidents.id),
  intervalMinutes: integer("interval_minutes").notNull(),
  lastOutageUpdateAt: ts("last_outage_update_at"),
  nextDueAt: ts("next_due_at"),
  active: boolean("active").notNull().default(true),
  stoppedReason: text("stopped_reason"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const communications = pgTable("communications", {
  id: id(),
  incidentId: uuid("incident_id").notNull().references(() => incidents.id),
  groupId: uuid("group_id"),
  kind: text("kind").notNull(),
  requestedKind: text("requested_kind").notNull(),
  audience: text("audience").notNull(), // resident | isp
  purpose: text("purpose").notNull(),   // initial | cause | technical | periodic | restoration | final
  templateVersionId: uuid("template_version_id").notNull().references(() => templateVersions.id),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  variables: jsonb("variables").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  status: commStatus("status").notNull().default("queued"),
  triggeredBy: uuid("triggered_by"),
  technicalUpdateId: uuid("technical_update_id"),
  createdAt: createdAt(),
  sentAt: ts("sent_at"),
  cancelledReason: text("cancelled_reason"),
}, (t) => [index("comm_incident_idx").on(t.incidentId, t.createdAt)]);

export const communicationDeliveries = pgTable("communication_deliveries", {
  id: id(),
  communicationId: uuid("communication_id").notNull().references(() => communications.id),
  recipientId: uuid("recipient_id"),
  ispId: uuid("isp_id"),
  channel: text("channel").notNull(), // client_api | smtp
  address: text("address").notNull(),
  status: deliveryStatus("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastAttemptAt: ts("last_attempt_at"),
  providerMessageId: text("provider_message_id"),
  error: text("error"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("cd_comm_addr_uq").on(t.communicationId, t.channel, t.address),
  index("cd_provider_idx").on(t.providerMessageId),
]);

export const deliveryEvents = pgTable("delivery_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  deliveryId: uuid("delivery_id").notNull().references(() => communicationDeliveries.id),
  status: deliveryStatus("status").notNull(),
  at: ts("at").notNull().defaultNow(),
  detail: text("detail").notNull().default(""),
  raw: jsonb("raw"),
});

// ───────────────────────────── Escalation ─────────────────────────────

export const escalationRules = pgTable("escalation_rules", {
  id: id(),
  trigger: text("trigger").notNull(),
  level: integer("level").notNull().default(1),
  afterMinutes: integer("after_minutes").notNull(),
  notifyRoles: text("notify_roles").array().notNull().default(sql`'{}'::text[]`),
  notifyEmails: text("notify_emails").array().notNull().default(sql`'{}'::text[]`),
  notifyTeam: boolean("notify_team").notNull().default(false),
  window: text("window").notNull().default("always"), // always | business_hours | after_hours
  active: boolean("active").notNull().default(true),
  description: text("description").notNull().default(""),
}, (t) => [uniqueIndex("er_uq").on(t.trigger, t.level)]);

export const escalations = pgTable("escalations", {
  id: id(),
  incidentId: uuid("incident_id").notNull().references(() => incidents.id),
  ruleId: uuid("rule_id").notNull().references(() => escalationRules.id),
  trigger: text("trigger").notNull(),
  level: integer("level").notNull(),
  subjectRef: text("subject_ref").notNull().default(""),
  raisedAt: ts("raised_at").notNull().defaultNow(),
  message: text("message").notNull(),
  notified: jsonb("notified").notNull().default(sql`'[]'::jsonb`),
  resolvedAt: ts("resolved_at"),
  acknowledgedBy: uuid("acknowledged_by"),
  acknowledgedAt: ts("acknowledged_at"),
}, (t) => [
  uniqueIndex("esc_uq").on(t.incidentId, t.ruleId, t.subjectRef),
  index("esc_open_idx").on(t.resolvedAt),
]);

// ───────────────────────────── Jobs & health ─────────────────────────────

/** Durable job queue. Claimed with FOR UPDATE SKIP LOCKED; leases recover crashed workers. */
export const jobs = pgTable("jobs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  kind: text("kind").notNull(),
  incidentId: uuid("incident_id"),
  runAt: ts("run_at").notNull(),
  status: jobStatus("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(8),
  dedupeKey: text("dedupe_key"),
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  lockedBy: text("locked_by"),
  lockedUntil: ts("locked_until"),
  lastError: text("last_error"),
  createdAt: createdAt(),
  completedAt: ts("completed_at"),
}, (t) => [
  index("jobs_due_idx").on(t.status, t.runAt),
  uniqueIndex("jobs_dedupe_uq").on(t.dedupeKey).where(sql`${t.dedupeKey} is not null and ${t.status} in ('pending','running')`),
]);

export const integrationHealth = pgTable("integration_health", {
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  lastSuccessAt: ts("last_success_at"),
  lastErrorAt: ts("last_error_at"),
  lastError: text("last_error"),
  consecutiveErrors: integer("consecutive_errors").notNull().default(0),
  meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
});

export const alerts = pgTable("system_alerts", {
  id: id(),
  key: text("key").notNull(),
  severity: text("severity").notNull(), // info | warning | critical
  message: text("message").notNull(),
  incidentId: uuid("incident_id"),
  raisedAt: ts("raised_at").notNull().defaultNow(),
  resolvedAt: ts("resolved_at"),
}, (t) => [uniqueIndex("alerts_open_uq").on(t.key).where(sql`${t.resolvedAt} is null`)]);

// ───────────────────────────── Audit ─────────────────────────────

/** Append-only (UPDATE/DELETE blocked by trigger) and hash-chained for tamper evidence. */
export const auditLogs = pgTable("audit_logs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: ts("at").notNull().defaultNow(),
  actorId: uuid("actor_id"),
  actorLabel: text("actor_label").notNull(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  ip: text("ip"),
  prevHash: text("prev_hash").notNull(),
  hash: text("hash").notNull(),
}, (t) => [index("audit_entity_idx").on(t.entityType, t.entityId), index("audit_at_idx").on(t.at)]);
