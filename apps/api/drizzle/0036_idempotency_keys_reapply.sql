-- #417 follow-up (P1, "Idempotency-Key header 500s on prod"): re-apply the
-- idempotency_keys DDL from 0034 idempotently.
--
-- Why: drizzle's migrator applies a migration only when its journal `when` is
-- GREATER than the max `created_at` already recorded in __drizzle_migrations —
-- and 0033's journal entry carries a hand-rounded FUTURE timestamp
-- (1783900000000 = 2026-07-12T23:46:40Z). 0034_idempotency_keys was generated
-- with a real (earlier) timestamp, so every database that had already applied
-- 0033 in a previous deploy — production — SILENTLY SKIPPED 0034, while fresh
-- databases (CI, unit PGlite, integration postgres) start empty and apply
-- everything, keeping all tests green. On prod the middleware's first query
-- then failed with `relation "idempotency_keys" does not exist` → HTTP 500 on
-- every request carrying the header, on every covered route.
--
-- This migration re-issues the same DDL guarded with IF NOT EXISTS (and a
-- pg_constraint check for the FK, which has no IF NOT EXISTS form), so it:
--   * creates the table on databases that skipped 0034 (production);
--   * no-ops on databases where 0034 did run (fresh CI/dev databases).
-- Its journal `when` (1783911111111) is greater than 0035's, so the poisoned
-- prod migrations-table max cannot skip it. 0034 itself is left untouched:
-- editing an already-applied migration would change history for the databases
-- that did run it. src/__tests__/migrationJournal.test.ts now enforces the
-- journal ordering invariant so this class of silent skip fails at PR time.
CREATE TABLE IF NOT EXISTS "idempotency_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer,
	"response_body" text,
	"content_type" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'idempotency_keys_user_id_users_id_fk'
	) THEN
		ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idempotency_keys_user_key_unique" ON "idempotency_keys" USING btree ("user_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idempotency_keys_created_at_idx" ON "idempotency_keys" USING btree ("created_at");
