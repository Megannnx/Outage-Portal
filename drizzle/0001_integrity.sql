-- Audit log is append-only. Updates and deletes are rejected at the database level,
-- so even a compromised application account cannot rewrite history.
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
--> statement-breakpoint
-- Original technical notes are never overwritten.
CREATE OR REPLACE FUNCTION technical_updates_text_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.original_text IS DISTINCT FROM OLD.original_text OR NEW.extraction IS DISTINCT FROM OLD.extraction THEN
    RAISE EXCEPTION 'technical update original text is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER technical_updates_immutable BEFORE UPDATE ON technical_updates
  FOR EACH ROW EXECUTE FUNCTION technical_updates_text_immutable();
--> statement-breakpoint
CREATE TRIGGER technical_updates_no_delete BEFORE DELETE ON technical_updates
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
--> statement-breakpoint
-- Published/retired template wording can never be edited in place: a change is a new version.
CREATE OR REPLACE FUNCTION template_versions_freeze() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('pending_approval','published','retired','rejected')
     AND (NEW.subject IS DISTINCT FROM OLD.subject OR NEW.body IS DISTINCT FROM OLD.body) THEN
    RAISE EXCEPTION 'template version % is frozen', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER template_versions_frozen BEFORE UPDATE ON template_versions
  FOR EACH ROW EXECUTE FUNCTION template_versions_freeze();
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS incident_reference_seq;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS dispatch_reference_seq;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS group_reference_seq;
