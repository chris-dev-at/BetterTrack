-- #1315 — one authenticated feedback queue shared by web and native clients.
-- User submissions are text-only in v1: no anonymous path, read-back endpoint,
-- or attachments. Category is mandatory because the owner triages feature /
-- change requests first, bugs second, and other feedback last.
CREATE TYPE "public"."feedback_category" AS ENUM('feature', 'bug', 'other');
--> statement-breakpoint
CREATE TYPE "public"."feedback_status" AS ENUM('new', 'triaged', 'done');
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"category" "feedback_category" NOT NULL,
	"subject" text,
	"message" text NOT NULL,
	"context" jsonb,
	"status" "feedback_status" DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_message_length" CHECK (char_length("feedback"."message") between 1 and 5000),
	CONSTRAINT "feedback_subject_length" CHECK ("feedback"."subject" is null or char_length("feedback"."subject") <= 120),
	CONSTRAINT "feedback_context_object" CHECK ("feedback"."context" is null or jsonb_typeof("feedback"."context") = 'object')
);
--> statement-breakpoint
ALTER TABLE "feedback"
ADD CONSTRAINT "feedback_user_id_users_id_fk"
FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "feedback_user_created_idx" ON "feedback" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "feedback_status_created_idx" ON "feedback" USING btree ("status","created_at");
--> statement-breakpoint
-- Widen an already-existing BetterTrackMobile client before it can request the
-- new scope. Union-only: preserve ordering and every admin-added scope, append
-- feedback:write once, and remain a no-op on fresh DBs where the boot seed will
-- create the first-party client from its canonical code definition instead.
UPDATE "oauth_clients"
SET "scopes" = "scopes" || ARRAY['feedback:write']::text[]
WHERE "client_id" = 'btc_IbT1mzw_7kBiPHPkGfaE0Q'
  AND NOT ('feedback:write' = ANY("scopes"));
