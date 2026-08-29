-- PARANOID E9 / §17 — "Transition plan for live account-level paranoid accounts",
-- ruled (C) "backup + wipe" on 2026-08-20 (docs/paranoid-design.md §21 Q3).
--
-- WHAT THIS MIGRATION DOES NOT DO: it does not wipe anybody.
--
-- §17 step 1 is unconditional about the ordering — "dump every `paranoid_vaults`
-- account blob + bounded history to a verified archive on the prod host, offsite
-- copy confirmed, THEN any destructive step. The owner runs/authorizes the
-- backup". Merge is deploy on the production host, so a migration body runs
-- unattended the instant this PR lands: it is structurally incapable of waiting
-- for an owner action that happens afterwards. Putting the wipe here would
-- execute the destructive step BEFORE the backup that §17 makes its
-- precondition, which is precisely the inversion the ruling forbids.
--
-- So step 2's "one migration retires the account-level rows (quarantined behind
-- the backup)" is delivered as: this migration ships the quarantine and THE GATE,
-- and `paranoidV1WipeService` performs the retirement per account, behind that
-- gate, once `scripts/ops/export-paranoid-v1-backup.mjs` has written a verified
-- attestation. "Quarantined BEHIND the backup" is implemented literally — the
-- backup is the thing standing in front of the quarantine.
--
-- This mirrors 0089_vault_v2_quarantine, whose header states the same reasoning
-- for the same reason ("Dropping here would destroy user data before anyone had
-- a chance to take it offsite"). It also follows the 2026-07-28 ruling in
-- PROJECTPLAN §16: "unverifiable client assertions may retire bytes but are
-- non-destructive by construction"; only a server-verified fact may destroy.
--
-- Nothing below drops a column, drops a table, or updates a user row. Deploying
-- this is a no-op for every live paranoid account: they keep working exactly as
-- they did, and the §19 deletion train removes the v1 surface later, as separate
-- append-only migrations.

-- ── 1. The gate: an owner-run, VERIFIED backup, recorded server-side ─────────
-- This is the fact the wipe checks. It is written by the ops export script only
-- after it has re-read the archive it just wrote from disk and matched both the
-- per-table row counts and a SHA-256 content digest. No client, no route and no
-- request body can create a row here.
--
-- `user_digests` maps each covered user id to the digest of THAT user's legacy
-- rows at dump time. The wipe recomputes it per account inside its own
-- transaction, so an account whose vault changed after the backup is refused
-- rather than destroyed against a stale archive.
--
-- `offsite_confirmed_at` is the second half of §17 step 1 ("offsite copy
-- confirmed"). The operator copies the archive off the host, digests the COPY,
-- and hands the digest back to the script; only a match sets these columns. The
-- wipe requires them, so "offsite copy confirmed" is a machine-checked
-- precondition and not an intention.
CREATE TABLE "paranoid_v1_backup_attestations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"archive_file" text NOT NULL,
	"archive_sha256" text NOT NULL,
	"row_counts" jsonb NOT NULL,
	"user_digests" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"offsite_confirmed_at" timestamp with time zone,
	"offsite_confirmed_sha256" text,
	CONSTRAINT "paranoid_v1_backup_attestations_offsite_pair" CHECK (
		("offsite_confirmed_at" IS NULL) = ("offsite_confirmed_sha256" IS NULL)
	),
	CONSTRAINT "paranoid_v1_backup_attestations_sha_shape" CHECK (
		"archive_sha256" ~ '^[0-9a-f]{64}$'
		AND ("offsite_confirmed_sha256" IS NULL OR "offsite_confirmed_sha256" ~ '^[0-9a-f]{64}$')
	)
);
--> statement-breakpoint

-- ── 2. The receipt: proof a given account was wiped, and the notice state ────
-- One row per wiped account. It is three things at once:
--   * the idempotency key of the wipe (PK on `user_id` — a second wipe of the
--     same account cannot silently run; the service refuses on conflict);
--   * §17 step 3's one-time notice state (`notice_acknowledged_at IS NULL`
--     means the fresh-start notice is still owed). Only wiped accounts have a
--     row, so an account that was always `normal` can never be shown the notice
--     — that is structural, not a conditional;
--   * §18's admin "legacy-wiped marker" ("the account went through the
--     backup+wipe").
--
-- The prior_* columns record what was flipped, so the receipt alone explains the
-- account's before/after without reading the quarantine. `prior_privacy_mode` is
-- `text`, deliberately NOT the `privacy_mode` enum: the receipt outlives the §19
-- train, which drops that enum with the column it belongs to.
--
-- This one DOES cascade from `users`: it is metadata about an account, not the
-- account's data, and it must not outlive a deleted account.
CREATE TABLE "paranoid_v1_wipe_receipts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"attestation_id" uuid NOT NULL,
	"wiped_at" timestamp with time zone DEFAULT now() NOT NULL,
	"prior_privacy_mode" text NOT NULL,
	"prior_media_set" text[],
	"prior_drive_attested_version" integer,
	"notice_acknowledged_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "paranoid_v1_wipe_receipts" ADD CONSTRAINT "paranoid_v1_wipe_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "paranoid_v1_wipe_receipts" ADD CONSTRAINT "paranoid_v1_wipe_receipts_attestation_id_fk" FOREIGN KEY ("attestation_id") REFERENCES "public"."paranoid_v1_backup_attestations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "paranoid_v1_wipe_receipts_notice_pending_idx" ON "paranoid_v1_wipe_receipts" USING btree ("user_id") WHERE "notice_acknowledged_at" IS NULL;
--> statement-breakpoint

-- ── 3. The quarantine — seven inert mirrors, created EMPTY ───────────────────
-- §17 step 2: the legacy rows are "quarantined ... `zz_`-prefix pattern", not
-- dropped. The wipe copies each account's rows here and deletes the live ones in
-- the same transaction; the §19 deletion train drops these tables afterwards, as
-- separate append-only migrations.
--
-- Two deliberate shape choices, both learned from 0089:
--
--   * NO FOREIGN KEY TO `users`. Every live paranoid table cascades from
--     `users.id`, so an account deletion between the wipe and the train would
--     otherwise silently destroy exactly the rows the quarantine exists to
--     preserve — 0089's step 4 severs every inbound cascade for this reason. The
--     price is a `user_id` that can dangle; that is the intended trade, and the
--     external archive is the copy of record regardless.
--
--   * A SURROGATE `id` PRIMARY KEY on all seven, even where the live table keys
--     on `user_id`. The originals' keys are preserved as ordinary columns. A
--     quarantine must never reject a row it is being handed for safekeeping.
--
-- Column sets mirror the live tables as of 0091, including the three dead
-- `migrating_by`/`migration_expires_at`/`migrated_to` columns that 0087 added to
-- `paranoid_vaults` and 0089 cleared but left in place.
CREATE TABLE "zz_paranoid_v1_backup_paranoid_vaults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"format_version" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"blob" bytea NOT NULL,
	"retirement_proof_public_key" text,
	"migrating_by" text,
	"migration_expires_at" timestamp with time zone,
	"migrated_to" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"attestation_id" uuid NOT NULL,
	"quarantined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zz_paranoid_v1_backup_paranoid_vault_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"history_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"format_version" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"blob" bytea NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"attestation_id" uuid NOT NULL,
	"quarantined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zz_paranoid_v1_backup_paranoid_enable_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"attestation_id" uuid NOT NULL,
	"quarantined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zz_paranoid_v1_backup_paranoid_vault_server_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"format_version" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"blob" bytea NOT NULL,
	"retirement_proof_public_key" text,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attestation_id" uuid NOT NULL,
	"quarantined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zz_paranoid_v1_backup_paranoid_vault_retirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"retired_version" integer NOT NULL,
	"retirement_proof_public_key" text NOT NULL,
	"retired_at" timestamp with time zone NOT NULL,
	"attestation_id" uuid NOT NULL,
	"quarantined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zz_paranoid_v1_backup_paranoid_vault_retired" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"retired_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"format_version" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"blob" bytea NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone NOT NULL,
	"attestation_id" uuid NOT NULL,
	"quarantined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zz_paranoid_v1_backup_paranoid_rehydration_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"rehydration_id" uuid NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"attestation_id" uuid NOT NULL,
	"quarantined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Per-account lookup is the only access pattern the quarantine has: the wipe
-- writes one account's rows, the ops script reads whole tables, the train drops
-- them. One index each on `user_id`, nothing more.
CREATE INDEX "zz_paranoid_v1_backup_paranoid_vaults_user_idx" ON "zz_paranoid_v1_backup_paranoid_vaults" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "zz_paranoid_v1_backup_paranoid_vault_history_user_idx" ON "zz_paranoid_v1_backup_paranoid_vault_history" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "zz_paranoid_v1_backup_paranoid_enable_transitions_user_idx" ON "zz_paranoid_v1_backup_paranoid_enable_transitions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "zz_paranoid_v1_backup_paranoid_vault_server_candidates_user_idx" ON "zz_paranoid_v1_backup_paranoid_vault_server_candidates" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "zz_paranoid_v1_backup_paranoid_vault_retirements_user_idx" ON "zz_paranoid_v1_backup_paranoid_vault_retirements" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "zz_paranoid_v1_backup_paranoid_vault_retired_user_idx" ON "zz_paranoid_v1_backup_paranoid_vault_retired" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "zz_paranoid_v1_backup_paranoid_rehydration_receipts_user_idx" ON "zz_paranoid_v1_backup_paranoid_rehydration_receipts" USING btree ("user_id");
