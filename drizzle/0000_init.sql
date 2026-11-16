CREATE TYPE "public"."audience" AS ENUM('all', 'resident', 'isp');--> statement-breakpoint
CREATE TYPE "public"."comm_status" AS ENUM('queued', 'sending', 'sent', 'partially_failed', 'failed', 'cancelled', 'no_recipients');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'sending', 'accepted', 'delivered', 'deferred', 'bounced', 'failed', 'suppressed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."dispatch_status" AS ENUM('requested', 'sent', 'acknowledged', 'on_site', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."event_kind" AS ENUM('down', 'up', 'heartbeat', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."event_processing" AS ENUM('processed', 'duplicate', 'unmatched', 'stale', 'ignored', 'error');--> statement-breakpoint
CREATE TYPE "public"."incident_phase" AS ENUM('validating', 'active', 'restoring', 'awaiting_rfo', 'resolved', 'interruption');--> statement-breakpoint
CREATE TYPE "public"."incident_status" AS ENUM('validating', 'awaiting_cause', 'power_area', 'technician_required', 'technician_investigating', 'awaiting_backhaul', 'under_investigation', 'restoring', 'restored_awaiting_rfo', 'resolved', 'interruption');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'done', 'cancelled', 'dead');--> statement-breakpoint
CREATE TYPE "public"."recipient_status" AS ENUM('active', 'suppressed', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."rfo_status" AS ENUM('not_applicable', 'awaiting', 'sent', 'waived');--> statement-breakpoint
CREATE TYPE "public"."role_key" AS ENUM('service_desk', 'technical', 'admin');--> statement-breakpoint
CREATE TYPE "public"."template_version_status" AS ENUM('draft', 'pending_approval', 'published', 'retired', 'rejected');--> statement-breakpoint
CREATE TABLE "system_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"incident_id" uuid,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"actor_label" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backhaul_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"public_name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"support_email" text,
	"support_phone" text,
	"sla_restore_minutes" integer,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "backhaul_providers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "cause_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"cause_key" text NOT NULL,
	"confirmed_by" uuid NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"superseded_at" timestamp with time zone,
	"is_correction" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cause_options" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"public_description" text NOT NULL,
	"category" text NOT NULL,
	"template_kind" text NOT NULL,
	"requires_dispatch" boolean DEFAULT false NOT NULL,
	"assigns_technical" boolean DEFAULT false NOT NULL,
	"periodic_kind" text DEFAULT 'no_update' NOT NULL,
	"sort" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communication_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"communication_id" uuid NOT NULL,
	"recipient_id" uuid,
	"isp_id" uuid,
	"channel" text NOT NULL,
	"address" text NOT NULL,
	"status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"provider_message_id" text,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communication_schedules" (
	"incident_id" uuid PRIMARY KEY NOT NULL,
	"interval_minutes" integer NOT NULL,
	"last_outage_update_at" timestamp with time zone,
	"next_due_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"stopped_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communication_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"audience" "audience" NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"built_in" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"group_id" uuid,
	"kind" text NOT NULL,
	"requested_kind" text NOT NULL,
	"audience" text NOT NULL,
	"purpose" text NOT NULL,
	"template_version_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"variables" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "comm_status" DEFAULT 'queued' NOT NULL,
	"triggered_by" uuid,
	"technical_update_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"cancelled_reason" text,
	CONSTRAINT "communications_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "correlation_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_ids" uuid[] NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "delivery_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"delivery_id" uuid NOT NULL,
	"status" "delivery_status" NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "escalation_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" text NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"after_minutes" integer NOT NULL,
	"notify_roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"notify_emails" text[] DEFAULT '{}'::text[] NOT NULL,
	"notify_team" boolean DEFAULT false NOT NULL,
	"window" text DEFAULT 'always' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"description" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"level" integer NOT NULL,
	"subject_ref" text DEFAULT '' NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"message" text NOT NULL,
	"notified" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resolved_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"acknowledged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fault_types" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"public_description" text NOT NULL,
	"template_kind" text NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"label" text NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "incident_groups_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "incident_transitions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"incident_id" uuid NOT NULL,
	"from_phase" "incident_phase",
	"to_phase" "incident_phase" NOT NULL,
	"from_status" "incident_status",
	"to_status" "incident_status" NOT NULL,
	"reason" text NOT NULL,
	"actor_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"site_id" uuid NOT NULL,
	"group_id" uuid,
	"related_incident_id" uuid,
	"phase" "incident_phase" NOT NULL,
	"status" "incident_status" NOT NULL,
	"cause_key" text,
	"cause_confirmed_by" uuid,
	"cause_confirmed_at" timestamp with time zone,
	"technical_assigned" boolean DEFAULT false NOT NULL,
	"assigned_team" text,
	"tech_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outage_started_at" timestamp with time zone NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"validated_at" timestamp with time zone,
	"first_comm_at" timestamp with time zone,
	"last_technical_update_at" timestamp with time zone,
	"restoration_detected_at" timestamp with time zone,
	"restored_at" timestamp with time zone,
	"restoration_confirmed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"downtime_seconds" integer,
	"flap_count" integer DEFAULT 0 NOT NULL,
	"rfo_status" "rfo_status" DEFAULT 'not_applicable' NOT NULL,
	"rfo_waiver_reason" text,
	"retrospective" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incidents_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "integration_health" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "isps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "isps_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"incident_id" uuid,
	"run_at" timestamp with time zone NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"dedupe_key" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "monitored_object_state" (
	"identifier_id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"state" text NOT NULL,
	"last_event_at" timestamp with time zone NOT NULL,
	"last_event_id" uuid,
	"last_down_at" timestamp with time zone,
	"last_up_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "monitoring_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"kind" "event_kind" NOT NULL,
	"event_name" text DEFAULT '' NOT NULL,
	"object_ref" text DEFAULT '' NOT NULL,
	"object_name" text DEFAULT '' NOT NULL,
	"identifier_id" uuid,
	"site_id" uuid,
	"incident_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processing" "event_processing" NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"raw" jsonb NOT NULL,
	CONSTRAINT "monitoring_events_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audience" text NOT NULL,
	"isp_id" uuid,
	"site_id" uuid,
	"team" text,
	"name" text DEFAULT '' NOT NULL,
	"email" text NOT NULL,
	"status" "recipient_status" DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"bounce_count" integer DEFAULT 0 NOT NULL,
	"last_bounce_at" timestamp with time zone,
	"last_delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfo_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"rfo_text" text NOT NULL,
	"internal_notes" text DEFAULT '' NOT NULL,
	"provider_ref" text DEFAULT '' NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"entered_by" uuid NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"communication_id" uuid
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"key" "role_key" PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"requires_mfa" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"mfa_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip" text,
	"user_agent" text,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_isps" (
	"site_id" uuid NOT NULL,
	"isp_id" uuid NOT NULL,
	CONSTRAINT "site_isps_site_id_isp_id_pk" PRIMARY KEY("site_id","isp_id")
);
--> statement-breakpoint
CREATE TABLE "site_monitoring_identifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"source" text NOT NULL,
	"match_type" text NOT NULL,
	"value" text NOT NULL,
	"critical" boolean DEFAULT true NOT NULL,
	"label" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"estate" text DEFAULT '' NOT NULL,
	"region" text DEFAULT '' NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"backhaul_provider_id" uuid,
	"circuit_ref" text DEFAULT '' NOT NULL,
	"upstream_ref" text DEFAULT '' NOT NULL,
	"technical_team" text DEFAULT 'NOC' NOT NULL,
	"resident_list_ref" text DEFAULT '' NOT NULL,
	"rfo_required" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sites_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "technical_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"original_text" text NOT NULL,
	"extraction" jsonb NOT NULL,
	"confirmed_facts" jsonb NOT NULL,
	"changes" text[] DEFAULT '{}'::text[] NOT NULL,
	"meaningful" boolean NOT NULL,
	"extractor" text NOT NULL,
	"communication_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "technician_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"priority" text DEFAULT 'URGENT' NOT NULL,
	"status" "dispatch_status" DEFAULT 'requested' NOT NULL,
	"team" text NOT NULL,
	"work_order" jsonb NOT NULL,
	"external_system" text,
	"external_ref" text,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"ack_token_hash" text,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	"on_site_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"notes" text DEFAULT '' NOT NULL,
	CONSTRAINT "technician_dispatches_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "template_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_version_id" uuid NOT NULL,
	"approver_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"status" "template_version_status" DEFAULT 'draft' NOT NULL,
	"change_note" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "timeline_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"incident_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"actor_id" uuid,
	"actor_label" text DEFAULT 'System' NOT NULL,
	"summary" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "role_key" NOT NULL,
	"password_hash" text NOT NULL,
	"mfa_secret_enc" text,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cause_confirmations" ADD CONSTRAINT "cause_confirmations_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cause_confirmations" ADD CONSTRAINT "cause_confirmations_cause_key_cause_options_key_fk" FOREIGN KEY ("cause_key") REFERENCES "public"."cause_options"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cause_confirmations" ADD CONSTRAINT "cause_confirmations_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_deliveries" ADD CONSTRAINT "communication_deliveries_communication_id_communications_id_fk" FOREIGN KEY ("communication_id") REFERENCES "public"."communications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_schedules" ADD CONSTRAINT "communication_schedules_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_template_version_id_template_versions_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."template_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_delivery_id_communication_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."communication_deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_rule_id_escalation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."escalation_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_groups" ADD CONSTRAINT "incident_groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_transitions" ADD CONSTRAINT "incident_transitions_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_group_id_incident_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."incident_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_cause_key_cause_options_key_fk" FOREIGN KEY ("cause_key") REFERENCES "public"."cause_options"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_cause_confirmed_by_users_id_fk" FOREIGN KEY ("cause_confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_object_state" ADD CONSTRAINT "monitored_object_state_identifier_id_site_monitoring_identifiers_id_fk" FOREIGN KEY ("identifier_id") REFERENCES "public"."site_monitoring_identifiers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_object_state" ADD CONSTRAINT "monitored_object_state_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_events" ADD CONSTRAINT "monitoring_events_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_events" ADD CONSTRAINT "monitoring_events_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipients" ADD CONSTRAINT "recipients_isp_id_isps_id_fk" FOREIGN KEY ("isp_id") REFERENCES "public"."isps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipients" ADD CONSTRAINT "recipients_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfo_records" ADD CONSTRAINT "rfo_records_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfo_records" ADD CONSTRAINT "rfo_records_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_isps" ADD CONSTRAINT "site_isps_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_isps" ADD CONSTRAINT "site_isps_isp_id_isps_id_fk" FOREIGN KEY ("isp_id") REFERENCES "public"."isps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_monitoring_identifiers" ADD CONSTRAINT "site_monitoring_identifiers_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_backhaul_provider_id_backhaul_providers_id_fk" FOREIGN KEY ("backhaul_provider_id") REFERENCES "public"."backhaul_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technical_updates" ADD CONSTRAINT "technical_updates_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technical_updates" ADD CONSTRAINT "technical_updates_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_dispatches" ADD CONSTRAINT "technician_dispatches_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_dispatches" ADD CONSTRAINT "technician_dispatches_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_approvals" ADD CONSTRAINT "template_approvals_template_version_id_template_versions_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."template_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_approvals" ADD CONSTRAINT "template_approvals_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_template_id_communication_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."communication_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_entries" ADD CONSTRAINT "timeline_entries_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_roles_key_fk" FOREIGN KEY ("role") REFERENCES "public"."roles"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_open_uq" ON "system_alerts" USING btree ("key") WHERE "system_alerts"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_at_idx" ON "audit_logs" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "cd_comm_addr_uq" ON "communication_deliveries" USING btree ("communication_id","channel","address");--> statement-breakpoint
CREATE INDEX "cd_provider_idx" ON "communication_deliveries" USING btree ("provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ct_kind_aud_uq" ON "communication_templates" USING btree ("kind","audience");--> statement-breakpoint
CREATE INDEX "comm_incident_idx" ON "communications" USING btree ("incident_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "er_uq" ON "escalation_rules" USING btree ("trigger","level");--> statement-breakpoint
CREATE UNIQUE INDEX "esc_uq" ON "escalations" USING btree ("incident_id","rule_id","subject_ref");--> statement-breakpoint
CREATE INDEX "esc_open_idx" ON "escalations" USING btree ("resolved_at");--> statement-breakpoint
CREATE INDEX "it_incident_idx" ON "incident_transitions" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "incidents_phase_idx" ON "incidents" USING btree ("phase");--> statement-breakpoint
CREATE INDEX "incidents_site_idx" ON "incidents" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE INDEX "incidents_started_idx" ON "incidents" USING btree ("outage_started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_one_open_per_site" ON "incidents" USING btree ("site_id") WHERE "incidents"."phase" in ('validating','active','restoring');--> statement-breakpoint
CREATE INDEX "jobs_due_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_uq" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."dedupe_key" is not null and "jobs"."status" in ('pending','running');--> statement-breakpoint
CREATE INDEX "me_site_idx" ON "monitoring_events" USING btree ("site_id","occurred_at");--> statement-breakpoint
CREATE INDEX "me_received_idx" ON "monitoring_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "recipients_isp_idx" ON "recipients" USING btree ("isp_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recipients_uq" ON "recipients" USING btree ("audience",coalesce("isp_id"::text,''),coalesce("site_id"::text,''),coalesce("team",''),lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "smi_uq" ON "site_monitoring_identifiers" USING btree ("source","match_type","value");--> statement-breakpoint
CREATE INDEX "td_incident_idx" ON "technician_dispatches" USING btree ("incident_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tv_version_uq" ON "template_versions" USING btree ("template_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "tv_one_published" ON "template_versions" USING btree ("template_id") WHERE "template_versions"."status" = 'published';--> statement-breakpoint
CREATE INDEX "tl_incident_idx" ON "timeline_entries" USING btree ("incident_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree (lower("email"));