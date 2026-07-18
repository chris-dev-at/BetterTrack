-- V5-P3 (#575) — digest mode: per-user per-type outbound cadence + a digest
-- queue. Strictly additive. `notification_cadences` stores a per-(user, type)
-- cadence (absence = `instant`, the pre-digest behaviour, so no existing user is
-- migrated); `notification_digest_queue` holds deferred (daily/weekly) items —
-- one row per outbound channel — that the digest job groups by `period` and
-- claims atomically (stamping `delivered_at`) so a re-run never double-sends.
-- Cadence governs the OUTBOUND channels (email/push/webpush) only; the in-app
-- bell is always instant.
CREATE TYPE "public"."notification_cadence" AS ENUM('instant', 'daily', 'weekly');--> statement-breakpoint
CREATE TABLE "notification_cadences" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"cadence" "notification_cadence" NOT NULL,
	CONSTRAINT "notification_cadences_user_type_pk" PRIMARY KEY("user_id","type")
);
--> statement-breakpoint
CREATE TABLE "notification_digest_queue" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"cadence" "notification_cadence" NOT NULL,
	"period" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notification_cadences" ADD CONSTRAINT "notification_cadences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_digest_queue" ADD CONSTRAINT "notification_digest_queue_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_digest_queue_pending_idx" ON "notification_digest_queue" USING btree ("cadence","user_id","period") WHERE "notification_digest_queue"."delivered_at" is null;--> statement-breakpoint
CREATE INDEX "notification_digest_queue_user_idx" ON "notification_digest_queue" USING btree ("user_id");
