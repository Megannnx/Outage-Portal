ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "network" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "sites" SET "network" = upper(substring("notes" from 'Network:\s*(\w+)')) WHERE "network" = '' AND "notes" ~ 'Network:\s*\w+';
