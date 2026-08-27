-- Quarantine the per-portfolio "Vaults v2" surface (owner ruling 2026-08-19,
-- PROJECTPLAN §16 — BetterTrack has exactly ONE paranoid implementation, the
-- account-level V5-P13 one). 0087 created this surface; this migration takes it
-- out of the application's reach WITHOUT destroying a byte.
--
-- Why RENAME and not DROP. Merge is deploy on the production host, so the
-- migration runs the moment this lands. Dropping here would destroy user data
-- before anyone had a chance to take it offsite, and for a JOINED portfolio the
-- v2 ciphertext is the ONLY server-side copy — `vault_portfolio_purge`
-- hard-deleted that portfolio's cleartext rows at join time. So the tables are
-- renamed to an inert `zz_vault_v2_backup_*` quarantine that no code references,
-- and `scripts/ops/export-vault-v2-backup.mjs` dumps them to an external
-- directory and (with `--drop`) destroys them as a separate, deliberate step.
--
-- The ciphertext is client-encrypted; we cannot read it and neither the backup
-- nor any future step can. There is deliberately NO port path into the v1
-- paranoid implementation ("keine Port-Funktion").

-- ── 1. Park the two columns v2 added to `portfolios` ────────────────────────
-- `vault_id` is the paranoid bit itself and `alias` the cleartext label a locked
-- row rendered. Both are dropped below (the FK on `vault_id` would otherwise
-- block the eventual DROP of the quarantined `vaults` table), so their values
-- are captured first — `vault_id` is the only record of WHICH portfolios were
-- vaulted, and therefore of which portfolios had their cleartext purged.
CREATE TABLE "zz_vault_v2_backup_portfolio_links" (
	"portfolio_id" uuid PRIMARY KEY NOT NULL,
	"vault_id" uuid,
	"alias" text,
	"quarantined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "zz_vault_v2_backup_portfolio_links" ("portfolio_id", "vault_id", "alias")
SELECT "id", "vault_id", "alias" FROM "portfolios"
WHERE "vault_id" IS NOT NULL OR "alias" IS NOT NULL;
--> statement-breakpoint

-- ── 2. Park, then CLEAR, the v1 → v2 migration state ────────────────────────
-- 0087 added three columns to the v1 table `paranoid_vaults`. `migrated_to` is
-- the flip's commit point, and the v1 repository refuses every WRITE while it is
-- set (`paranoidVaultRepository` → `migrated_tombstone`). With v2 gone, a row
-- left in that state would be a permanently read-only v1 vault with no successor
-- — a bricked account. Clearing the three columns restores v1 as the single
-- authority, which is exactly the ruling.
--
-- The v1→v2 flip was never wired into any client UI, so this is expected to
-- match zero rows; it is written to be correct if it does not.
--
-- The COLUMNS deliberately stay on `paranoid_vaults`: dropping them would mean
-- editing the v1 schema and repository, and the ruling is to leave the v1
-- implementation untouched. Nothing can set them again once v2 is gone.
CREATE TABLE "zz_vault_v2_backup_legacy_migration" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"migrating_by" text,
	"migration_expires_at" timestamp with time zone,
	"migrated_to" uuid,
	"quarantined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "zz_vault_v2_backup_legacy_migration"
	("user_id", "migrating_by", "migration_expires_at", "migrated_to")
SELECT "user_id", "migrating_by", "migration_expires_at", "migrated_to"
FROM "paranoid_vaults"
WHERE "migrating_by" IS NOT NULL
	OR "migration_expires_at" IS NOT NULL
	OR "migrated_to" IS NOT NULL;
--> statement-breakpoint
UPDATE "paranoid_vaults"
SET "migrating_by" = NULL, "migration_expires_at" = NULL, "migrated_to" = NULL
WHERE "migrating_by" IS NOT NULL
	OR "migration_expires_at" IS NOT NULL
	OR "migrated_to" IS NOT NULL;
--> statement-breakpoint

-- ── 3. Drop the v2 columns from `portfolios` ────────────────────────────────
-- Dropping the column drops its FK and index with it; the explicit statements
-- keep the intent readable and stay correct if a hand-patched database has one
-- without the other.
ALTER TABLE "portfolios" DROP CONSTRAINT IF EXISTS "portfolios_vault_id_vaults_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "portfolios_vault_idx";
--> statement-breakpoint
ALTER TABLE "portfolios" DROP COLUMN IF EXISTS "vault_id";
--> statement-breakpoint
ALTER TABLE "portfolios" DROP CONSTRAINT IF EXISTS "portfolios_alias_length";
--> statement-breakpoint
ALTER TABLE "portfolios" DROP COLUMN IF EXISTS "alias";
--> statement-breakpoint

-- ── 4. Sever every inbound cascade, THEN rename ─────────────────────────────
-- This is the load-bearing step of the quarantine. `vaults.user_id`,
-- `vault_leave_receipts.user_id/portfolio_id` and `vault_docs.portfolio_id` are
-- all `ON DELETE CASCADE`. Left in place, an account deletion or a portfolio
-- deletion between this deploy and the operator's backup run would silently
-- destroy exactly the rows we are preserving. Dropping the FKs makes the
-- quarantine inert — nothing outside it can reach it any more — and also unblocks
-- the eventual DROP.
ALTER TABLE "vaults" DROP CONSTRAINT IF EXISTS "vaults_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "vault_docs" DROP CONSTRAINT IF EXISTS "vault_docs_vault_id_vaults_id_fk";
--> statement-breakpoint
ALTER TABLE "vault_docs" DROP CONSTRAINT IF EXISTS "vault_docs_portfolio_id_portfolios_id_fk";
--> statement-breakpoint
ALTER TABLE "vault_leave_receipts" DROP CONSTRAINT IF EXISTS "vault_leave_receipts_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "vault_leave_receipts" DROP CONSTRAINT IF EXISTS "vault_leave_receipts_portfolio_id_portfolios_id_fk";
--> statement-breakpoint
ALTER TABLE "vaults" RENAME TO "zz_vault_v2_backup_vaults";
--> statement-breakpoint
ALTER TABLE "vault_docs" RENAME TO "zz_vault_v2_backup_vault_docs";
--> statement-breakpoint
ALTER TABLE "vault_leave_receipts" RENAME TO "zz_vault_v2_backup_vault_leave_receipts";
--> statement-breakpoint

-- ── 5. Rename the secondary indexes off the live namespace ─────────────────
-- Index and constraint names do not follow a table rename, so the quarantine
-- would otherwise keep sitting on the original names. The renames below cover
-- the SECONDARY indexes only.
--
-- Not exhaustive, deliberately: the three primary-key constraints keep their
-- original names (`vaults_pkey`, `vault_docs_pkey`,
-- `vault_leave_receipts_pkey`), so those identifiers stay occupied until the
-- tables are dropped. That is accepted rather than fixed — renaming a PK
-- constraint buys nothing here (the ops script drops these tables outright) and
-- is pure added risk on a migration that runs at deploy. A future table named
-- `vaults` would therefore need its own PK constraint name, which is a
-- deliberate collision with a quarantine that is meant to be temporary.
ALTER INDEX IF EXISTS "vaults_user_name_unique" RENAME TO "zz_vault_v2_backup_vaults_user_name_unique";
--> statement-breakpoint
ALTER INDEX IF EXISTS "vaults_user_idx" RENAME TO "zz_vault_v2_backup_vaults_user_idx";
--> statement-breakpoint
ALTER INDEX IF EXISTS "vault_docs_header_unique" RENAME TO "zz_vault_v2_backup_vault_docs_header_unique";
--> statement-breakpoint
ALTER INDEX IF EXISTS "vault_docs_common_unique" RENAME TO "zz_vault_v2_backup_vault_docs_common_unique";
--> statement-breakpoint
ALTER INDEX IF EXISTS "vault_docs_portfolio_unique" RENAME TO "zz_vault_v2_backup_vault_docs_portfolio_unique";
--> statement-breakpoint
ALTER INDEX IF EXISTS "vault_docs_vault_idx" RENAME TO "zz_vault_v2_backup_vault_docs_vault_idx";
--> statement-breakpoint
ALTER INDEX IF EXISTS "vault_leave_receipts_portfolio_idx" RENAME TO "zz_vault_v2_backup_vault_leave_receipts_portfolio_idx";
