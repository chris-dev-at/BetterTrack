-- Announcements v2 (owner directive 2026-10-29, PROJECTPLAN §6.19.5; wire in
-- docs/announcements-contract.md). Three kinds, an audience, an explicit
-- lifecycle, markdown bodies, and per-user RECEIPTS that are the
-- acknowledgement log — on the same two tables V4-P5 (b) built.
--
-- Numbering: idx 122. 0118–0121 are taken by the open PR-A, PR-B,
-- feedback-api and PR-C lanes; journal contiguity (`migrationJournal.test.ts`)
-- resolves as those land, and this entry is renumbered at rebase if any of
-- them is withdrawn. The `when` sits above every one of theirs.
--
-- RE-RUNNABLE BY CONSTRUCTION (the 0036 lesson): every statement is guarded —
-- IF [NOT] EXISTS, a duplicate_object catch, DROP-then-ADD for constraints,
-- and backfills that only touch rows still in their pre-migration shape — so
-- applying this file a second time changes nothing. The migration test applies
-- it twice and compares.
--
-- What it must never do: lose a dismissal. Every `announcement_dismissals` row
-- survives the rename byte-for-byte as a `notice` dismissal (same user, same
-- announcement, same `dismissed_at`), and its `created_at`/`updated_at` carry
-- the dismissal instant rather than the deploy instant.

-- ── 1. Vocabulary ──────────────────────────────────────────────────────────
DO $$ BEGIN
	CREATE TYPE "public"."announcement_kind" AS ENUM('notice', 'once', 'ack_required');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."announcement_audience" AS ENUM('everyone', 'existing_at_publish');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."announcement_lifecycle" AS ENUM('draft', 'published', 'archived');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."announcement_body_format" AS ENUM('plain', 'markdown');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."announcement_ack_via" AS ENUM('web_session', 'first_party_oauth');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."announcement_lapse_reason" AS ENUM('ended', 'archived');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- ── 2. `announcement_dismissals` → `announcement_receipts` ────────────────
-- Renamed first, so the announcement backfill below can ask "does this row
-- hold receipts?" of the table that will own them.
ALTER TABLE IF EXISTS "announcement_dismissals" RENAME TO "announcement_receipts";--> statement-breakpoint
-- Both old foreign keys cascaded. Neither may any more (Chief ruling
-- 2026-10-29): a deletion path that skips the pseudonymisation must fail
-- loudly instead of losing acknowledgement evidence. Re-added as RESTRICT below.
ALTER TABLE "announcement_receipts" DROP CONSTRAINT IF EXISTS "announcement_dismissals_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "announcement_receipts" DROP CONSTRAINT IF EXISTS "announcement_dismissals_announcement_id_announcements_id_fk";--> statement-breakpoint
-- The composite PK becomes the unique constraint below: a pseudonymised row
-- has no user, and a primary key cannot hold a NULL.
ALTER TABLE "announcement_receipts" DROP CONSTRAINT IF EXISTS "announcement_dismissals_pk";--> statement-breakpoint
-- The surrogate key. A volatile default is evaluated per existing row, so
-- every legacy dismissal gets its own id in this one statement (v4 rather than
-- the app's v7 — the app supplies v7 on its own inserts).
ALTER TABLE "announcement_receipts" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "announcement_receipts" DROP CONSTRAINT IF EXISTS "announcement_receipts_pkey";--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD CONSTRAINT "announcement_receipts_pkey" PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "announcement_receipts" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "announcement_receipts" ALTER COLUMN "dismissed_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "announcement_receipts" ALTER COLUMN "dismissed_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD COLUMN IF NOT EXISTS "seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD COLUMN IF NOT EXISTS "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD COLUMN IF NOT EXISTS "acknowledged_via" "announcement_ack_via";--> statement-breakpoint
-- The OAuth grant an acknowledgement came through. No FK on purpose: the
-- evidence must survive a revoked or deleted grant.
ALTER TABLE "announcement_receipts" ADD COLUMN IF NOT EXISTS "acknowledged_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD COLUMN IF NOT EXISTS "acknowledged_locale" text;--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD COLUMN IF NOT EXISTS "acknowledged_content_sha256" text;--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD COLUMN IF NOT EXISTS "lapsed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD COLUMN IF NOT EXISTS "lapse_reason" "announcement_lapse_reason";--> statement-breakpoint
-- created_at / updated_at: added nullable, filled from the dismissal instant,
-- then defaulted and made NOT NULL — so a legacy row's timestamps say when the
-- user dismissed it, not when this deploy ran, and a re-run finds nothing NULL.
ALTER TABLE "announcement_receipts" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;--> statement-breakpoint
UPDATE "announcement_receipts" SET "created_at" = COALESCE("dismissed_at", now()) WHERE "created_at" IS NULL;--> statement-breakpoint
UPDATE "announcement_receipts" SET "updated_at" = COALESCE("dismissed_at", now()) WHERE "updated_at" IS NULL;--> statement-breakpoint
ALTER TABLE "announcement_receipts" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "announcement_receipts" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "announcement_receipts" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "announcement_receipts" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
-- The pseudonym of a deleted account (§6.19.5): HMAC-SHA256(user id) under a
-- key HKDF-derived from the stored-record encryption key, the id of that key,
-- and when the row was pseudonymised.
ALTER TABLE "announcement_receipts" ADD COLUMN IF NOT EXISTS "subject_token" text;--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD COLUMN IF NOT EXISTS "subject_key_id" text;--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD COLUMN IF NOT EXISTS "pseudonymized_at" timestamp with time zone;--> statement-breakpoint
-- The upserts' conflict target and the gate's per-user lookup. NULLs are
-- distinct, so pseudonymised rows (user_id NULL) never collide.
ALTER TABLE "announcement_receipts" DROP CONSTRAINT IF EXISTS "announcement_receipts_user_announcement_uq";--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD CONSTRAINT "announcement_receipts_user_announcement_uq" UNIQUE ("user_id", "announcement_id");--> statement-breakpoint
ALTER TABLE "announcement_receipts" DROP CONSTRAINT IF EXISTS "announcement_receipts_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD CONSTRAINT "announcement_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_receipts" DROP CONSTRAINT IF EXISTS "announcement_receipts_announcement_id_announcements_id_fk";--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD CONSTRAINT "announcement_receipts_announcement_id_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER INDEX IF EXISTS "announcement_dismissals_announcement_id_idx" RENAME TO "announcement_receipts_announcement_id_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "announcement_receipts_announcement_id_idx" ON "announcement_receipts" USING btree ("announcement_id");--> statement-breakpoint
-- A receipt records something.
ALTER TABLE "announcement_receipts" DROP CONSTRAINT IF EXISTS "announcement_receipts_has_state";--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD CONSTRAINT "announcement_receipts_has_state" CHECK ("seen_at" IS NOT NULL OR "dismissed_at" IS NOT NULL OR "acknowledged_at" IS NOT NULL OR "lapsed_at" IS NOT NULL);--> statement-breakpoint
-- An obligation is either acknowledged or lapsed, never both.
ALTER TABLE "announcement_receipts" DROP CONSTRAINT IF EXISTS "announcement_receipts_ack_xor_lapse";--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD CONSTRAINT "announcement_receipts_ack_xor_lapse" CHECK ("acknowledged_at" IS NULL OR "lapsed_at" IS NULL);--> statement-breakpoint
ALTER TABLE "announcement_receipts" DROP CONSTRAINT IF EXISTS "announcement_receipts_lapse_complete";--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD CONSTRAINT "announcement_receipts_lapse_complete" CHECK (("lapsed_at" IS NULL) = ("lapse_reason" IS NULL));--> statement-breakpoint
-- A row is live (user_id set, no pseudonym) or pseudonymised (all three set).
ALTER TABLE "announcement_receipts" DROP CONSTRAINT IF EXISTS "announcement_receipts_pseudonym_token";--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD CONSTRAINT "announcement_receipts_pseudonym_token" CHECK (("user_id" IS NULL) = ("subject_token" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "announcement_receipts" DROP CONSTRAINT IF EXISTS "announcement_receipts_pseudonym_key";--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD CONSTRAINT "announcement_receipts_pseudonym_key" CHECK (("user_id" IS NULL) = ("subject_key_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "announcement_receipts" DROP CONSTRAINT IF EXISTS "announcement_receipts_pseudonym_at";--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD CONSTRAINT "announcement_receipts_pseudonym_at" CHECK (("user_id" IS NULL) = ("pseudonymized_at" IS NOT NULL));--> statement-breakpoint
-- A live acknowledgement is complete: instant, channel, locale and the hash of
-- the exact text all together, or none of them.
ALTER TABLE "announcement_receipts" DROP CONSTRAINT IF EXISTS "announcement_receipts_live_ack_complete";--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD CONSTRAINT "announcement_receipts_live_ack_complete" CHECK ("user_id" IS NULL OR ((("acknowledged_at" IS NULL) = ("acknowledged_via" IS NULL)) AND (("acknowledged_at" IS NULL) = ("acknowledged_locale" IS NULL)) AND (("acknowledged_at" IS NULL) = ("acknowledged_content_sha256" IS NULL))));--> statement-breakpoint
-- A pseudonymised row keeps exactly the announcement, the instant, the hash
-- and the token — and nothing else that could point back at the person.
ALTER TABLE "announcement_receipts" DROP CONSTRAINT IF EXISTS "announcement_receipts_pseudonym_shape";--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD CONSTRAINT "announcement_receipts_pseudonym_shape" CHECK ("user_id" IS NOT NULL OR ("acknowledged_at" IS NOT NULL AND "acknowledged_content_sha256" IS NOT NULL AND "acknowledged_via" IS NULL AND "acknowledged_grant_id" IS NULL AND "acknowledged_locale" IS NULL AND "seen_at" IS NULL AND "dismissed_at" IS NULL AND "lapsed_at" IS NULL AND "lapse_reason" IS NULL));--> statement-breakpoint
ALTER TABLE "announcement_receipts" DROP CONSTRAINT IF EXISTS "announcement_receipts_ack_locale_known";--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD CONSTRAINT "announcement_receipts_ack_locale_known" CHECK ("acknowledged_locale" IS NULL OR "acknowledged_locale" IN ('en', 'de'));--> statement-breakpoint
ALTER TABLE "announcement_receipts" DROP CONSTRAINT IF EXISTS "announcement_receipts_sha256_hex";--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD CONSTRAINT "announcement_receipts_sha256_hex" CHECK ("acknowledged_content_sha256" IS NULL OR "acknowledged_content_sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "announcement_receipts" DROP CONSTRAINT IF EXISTS "announcement_receipts_subject_token_hex";--> statement-breakpoint
ALTER TABLE "announcement_receipts" ADD CONSTRAINT "announcement_receipts_subject_token_hex" CHECK ("subject_token" IS NULL OR "subject_token" ~ '^[0-9a-f]{64}$');--> statement-breakpoint

-- ── 3. `announcements` ─────────────────────────────────────────────────────
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "kind" "announcement_kind" DEFAULT 'notice' NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "audience" "announcement_audience" DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "lifecycle" "announcement_lifecycle" DEFAULT 'draft' NOT NULL;--> statement-breakpoint
-- Added with DEFAULT 'plain' so every legacy row reads as plain text (today's
-- whitespace-pre-line banner); new rows default to the markdown subset.
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "body_format" "announcement_body_format" DEFAULT 'plain' NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements" ALTER COLUMN "body_format" SET DEFAULT 'markdown';--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "released_by" uuid;--> statement-breakpoint
-- The frozen existing_at_publish cutoff: GREATEST(publish instant, starts_at),
-- set once at publish and never moved (Chief ruling 2026-10-29).
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "audience_cutoff_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "archived_by" uuid;--> statement-breakpoint
-- The lapse pass's per-announcement claim (walk-then-claim, like published_at).
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "lapse_recorded_at" timestamp with time zone;--> statement-breakpoint
-- "Also notify by e-mail" (Chief ruling 2026-10-29), sent N days after the
-- window opened to the accounts still pending then (Chief ruling 2026-10-30);
-- email_pass_recorded_at is that pass's per-announcement claim.
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "notify_by_email" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "notify_by_email_after_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "email_pass_recorded_at" timestamp with time zone;--> statement-breakpoint
-- DE becomes optional for notice/once (publish requires it for ack_required).
ALTER TABLE "announcements" ALTER COLUMN "title_de" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements" ALTER COLUMN "body_de" DROP NOT NULL;--> statement-breakpoint

-- Backfill. Only rows still in the pre-migration shape (lifecycle 'draft',
-- nothing released) are touched, so a re-run is a no-op. Every legacy row is a
-- plain-text, everyone, notice — the column defaults above already say so.
--   • active                                  → published
--   • inactive, but the fan-out stamped it     → archived (it was withdrawn)
--   • inactive, never stamped, HOLDS receipts  → archived: users saw it (the
--     old dismiss route accepted any existing id), and a draft is deletable,
--     which the RESTRICT foreign key above would then refuse
--   • anything else                           → stays a draft
-- released_at = COALESCE(published_at, starts_at, created_at): the best
-- record of when it first went out. archived_at = updated_at: the last edit is
-- when it was switched off. The cutoff is the CHECK-required later of the two.
UPDATE "announcements" a SET
	"lifecycle" = CASE WHEN a."active" THEN 'published'::"announcement_lifecycle" ELSE 'archived'::"announcement_lifecycle" END,
	"released_at" = COALESCE(a."published_at", a."starts_at", a."created_at"),
	"audience_cutoff_at" = GREATEST(
		COALESCE(a."published_at", a."starts_at", a."created_at"),
		COALESCE(a."starts_at", a."published_at", a."created_at")
	),
	"archived_at" = CASE WHEN a."active" THEN NULL ELSE a."updated_at" END
WHERE a."lifecycle" = 'draft'
	AND a."released_at" IS NULL
	AND (
		a."active"
		OR a."published_at" IS NOT NULL
		OR EXISTS (SELECT 1 FROM "announcement_receipts" r WHERE r."announcement_id" = a."id")
	);--> statement-breakpoint

ALTER TABLE "announcements" DROP CONSTRAINT IF EXISTS "announcements_released_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" DROP CONSTRAINT IF EXISTS "announcements_archived_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "announcements_released_by_idx" ON "announcements" USING btree ("released_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "announcements_archived_by_idx" ON "announcements" USING btree ("archived_by");--> statement-breakpoint
-- Serves the user list, the gate snapshot and both sweeps (§6.19.5). The old
-- announcements_active_window_idx stays with `active` for one release (`active`
-- is written in lockstep, active = (lifecycle = 'published'), so a rollback
-- reads consistent rows); a follow-up migration drops both.
CREATE INDEX IF NOT EXISTS "announcements_lifecycle_kind_window_idx" ON "announcements" USING btree ("lifecycle","kind","starts_at","ends_at");--> statement-breakpoint
ALTER TABLE "announcements" DROP CONSTRAINT IF EXISTS "announcements_lifecycle_released";--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_lifecycle_released" CHECK (("lifecycle" = 'draft') = ("released_at" IS NULL));--> statement-breakpoint
ALTER TABLE "announcements" DROP CONSTRAINT IF EXISTS "announcements_lifecycle_cutoff";--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_lifecycle_cutoff" CHECK (("lifecycle" = 'draft') = ("audience_cutoff_at" IS NULL));--> statement-breakpoint
ALTER TABLE "announcements" DROP CONSTRAINT IF EXISTS "announcements_lifecycle_archived";--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_lifecycle_archived" CHECK (("lifecycle" = 'archived') = ("archived_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "announcements" DROP CONSTRAINT IF EXISTS "announcements_lapse_ack_only";--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_lapse_ack_only" CHECK ("lapse_recorded_at" IS NULL OR "kind" = 'ack_required');--> statement-breakpoint
ALTER TABLE "announcements" DROP CONSTRAINT IF EXISTS "announcements_notify_email_ack_only";--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_notify_email_ack_only" CHECK (NOT "notify_by_email" OR "kind" = 'ack_required');--> statement-breakpoint
ALTER TABLE "announcements" DROP CONSTRAINT IF EXISTS "announcements_notify_email_after_days_range";--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_notify_email_after_days_range" CHECK ("notify_by_email_after_days" BETWEEN 0 AND 365);--> statement-breakpoint
-- ack_required-only, like the toggle (CEO addendum 2026-10-30): a column with
-- a NOT NULL default cannot be NULL elsewhere, so "only ack_required carries a
-- delay" reads as "every other kind holds the default".
ALTER TABLE "announcements" DROP CONSTRAINT IF EXISTS "announcements_notify_email_after_days_ack_only";--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_notify_email_after_days_ack_only" CHECK ("kind" = 'ack_required' OR "notify_by_email_after_days" = 7);--> statement-breakpoint
ALTER TABLE "announcements" DROP CONSTRAINT IF EXISTS "announcements_email_pass_needs_toggle";--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_email_pass_needs_toggle" CHECK ("email_pass_recorded_at" IS NULL OR "notify_by_email");
