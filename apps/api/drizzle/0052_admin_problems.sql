-- V5-P2 arc (d) (#566) — admin "Problems" capture, the Sentry replacement.
-- Strictly additive. One row per distinct problem, folded by `fingerprint`
-- (a stable hash of kind + name + normalized message) with an occurrence count
-- and first/last-seen stamps. Unhandled request errors, permanently-failed jobs
-- and provider failures land here; every stored string is PII-scrubbed before
-- it is persisted (no email/token/cookie). `resolved_by` points at the admin who
-- cleared the problem, nulled if that account is deleted. Two enums back `kind`
-- and the resolve-flow `status`.
CREATE TYPE "public"."problem_kind" AS ENUM('error', 'job', 'provider');--> statement-breakpoint
CREATE TYPE "public"."problem_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TABLE "problems" (
	"id" uuid PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"kind" "problem_kind" NOT NULL,
	"status" "problem_status" DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"context" jsonb,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid
);
--> statement-breakpoint
ALTER TABLE "problems" ADD CONSTRAINT "problems_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "problems_fingerprint_unique" ON "problems" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "problems_status_last_seen_idx" ON "problems" USING btree ("status","last_seen_at");--> statement-breakpoint
CREATE INDEX "problems_kind_idx" ON "problems" USING btree ("kind");
