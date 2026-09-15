-- Admin panel ADMIN-W5 (#1907): moderation depth in People 360.
--
-- Two tables. `admin_moderation_actions` is the append-only RECORD — one row
-- per moderation action against an account, carrying the operator's reason and
-- identity, written in the SAME transaction as the state change it describes so
-- a suspension can never exist without its reason. `admin_user_flags` holds the
-- CURRENT review flag, one row per account, so "show me flagged accounts" is an
-- index lookup instead of a correlated "latest flag/unflag wins" subquery over
-- the history.
--
-- Neither table is the account's content: both are admin workspace, classified
-- `skip` in EXPORT_TABLE_CLASSIFICATION and `server` in
-- PARANOID_TABLE_CLASSIFICATION for the reason the §16 row of 2026-08-29 gives
-- for `admin_user_notes`. Deletion still cascades, so it stays total.
--
-- The CHECKs mirror `admin_user_notes` (#1406 W2): the zod contract already
-- rejects a blank or over-long reason, and the columns repeat both so no future
-- caller can write unbounded prose past the route. `previous_value` /
-- `next_value` are bounded too — they are short STATE LABELS, and an unbounded
-- pair of them would be the same unbounded prose column one field over.
CREATE TABLE "admin_moderation_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"previous_value" text,
	"next_value" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_moderation_actions_reason_not_empty" CHECK ("admin_moderation_actions"."reason" ~ '[^[:space:]]'),
	CONSTRAINT "admin_moderation_actions_reason_length" CHECK (char_length("admin_moderation_actions"."reason") <= 2000),
	CONSTRAINT "admin_moderation_actions_action_known" CHECK ("admin_moderation_actions"."action" in ('disable', 'enable', 'chat_ban', 'chat_unban', 'role_change', 'flag', 'unflag', 'delete_reservation', 'password_reset')),
	CONSTRAINT "admin_moderation_actions_previous_value_length" CHECK ("admin_moderation_actions"."previous_value" is null or char_length("admin_moderation_actions"."previous_value") <= 64),
	CONSTRAINT "admin_moderation_actions_next_value_length" CHECK ("admin_moderation_actions"."next_value" is null or char_length("admin_moderation_actions"."next_value") <= 64)
);
--> statement-breakpoint
CREATE TABLE "admin_user_flags" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"flagged_by" uuid,
	"flagged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_user_flags_reason_not_empty" CHECK ("admin_user_flags"."reason" ~ '[^[:space:]]'),
	CONSTRAINT "admin_user_flags_reason_length" CHECK (char_length("admin_user_flags"."reason") <= 2000)
);
--> statement-breakpoint
-- The record is about a person: when the account is deleted it has no subject
-- left, and account deletion must stay total (§10).
ALTER TABLE "admin_moderation_actions"
ADD CONSTRAINT "admin_moderation_actions_user_id_users_id_fk"
FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Nullable + ON DELETE set null, exactly as `audit_log.actor_id` and
-- `admin_user_notes.author_id`: the record outlives the operator who wrote it
-- and renders a tombstone rather than losing the row.
ALTER TABLE "admin_moderation_actions"
ADD CONSTRAINT "admin_moderation_actions_actor_id_users_id_fk"
FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id")
ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "admin_user_flags"
ADD CONSTRAINT "admin_user_flags_user_id_users_id_fk"
FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "admin_user_flags"
ADD CONSTRAINT "admin_user_flags_flagged_by_users_id_fk"
FOREIGN KEY ("flagged_by") REFERENCES "public"."users"("id")
ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- The only read is "this account's record, newest first", so the index carries
-- the ORDER as well as the filter — including the `id` tiebreak, which two
-- actions written by one PATCH share a `created_at` with by construction.
CREATE INDEX "admin_moderation_actions_user_created_idx"
ON "admin_moderation_actions" USING btree ("user_id","created_at" DESC,"id" DESC);
--> statement-breakpoint
-- FK index parity (#1619 `check:schema-drift`): Postgres indexes the referenced
-- side only, and the referencing side is what a cascading admin delete scans.
CREATE INDEX "admin_moderation_actions_actor_id_idx"
ON "admin_moderation_actions" USING btree ("actor_id");
--> statement-breakpoint
CREATE INDEX "admin_user_flags_flagged_by_idx"
ON "admin_user_flags" USING btree ("flagged_by");
