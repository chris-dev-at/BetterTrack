-- PARANOID E1 writer rulings R1/R3/R4 (#1411, 2026-08-20).
--
-- This is deliberately append-only over 0091. It registers the two singleton
-- document addresses needed to prove a complete per-vault doc set, pins the
-- portfolio docId === portfolioId protocol rule at the database boundary,
-- carries full-set media attestation identity, and gives every retirement a
-- per-vault lifetime generation that cannot be reused after purge.

-- ── R1: config-registered singleton doc ids + portfolio address binding ─────
-- E0 shipped no writer routes, so the new vault table has no production rows
-- to backfill. A surprise row makes this migration fail loudly instead of
-- inventing client document ids the server has no authority to mint.
ALTER TABLE "vaults" ADD COLUMN "header_doc_id" uuid NOT NULL;
--> statement-breakpoint
ALTER TABLE "vaults" ADD COLUMN "common_doc_id" uuid NOT NULL;
--> statement-breakpoint
ALTER TABLE "vaults"
ADD CONSTRAINT "vaults_config_doc_ids_distinct"
CHECK ("header_doc_id" <> "common_doc_id");
--> statement-breakpoint
ALTER TABLE "vault_blobs"
ADD CONSTRAINT "vault_blobs_portfolio_doc_id"
CHECK ("doc_kind" <> 'portfolio' OR "doc_id" = "portfolio_id");
--> statement-breakpoint

-- ── R3: transition-scoped full-set media attestations ───────────────────────
ALTER TABLE "vaults" ADD COLUMN "media_attested_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "vaults" ADD COLUMN "media_attested_drive_connection_id" uuid;
--> statement-breakpoint
-- Same deferred-NO-ACTION discipline as vaults.drive_connection_id: a lone
-- connection delete refuses at COMMIT, while the account-deletion cascade may
-- remove the connection and its vaults in either cascade order.
ALTER TABLE "vaults"
ADD CONSTRAINT "vaults_media_attested_drive_connection_fk"
FOREIGN KEY ("media_attested_drive_connection_id")
REFERENCES "public"."drive_connections"("id")
ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "vaults"
ADD CONSTRAINT "vaults_media_attestation_state"
CHECK (
  ("media_attested_at" IS NULL AND "media_attested_drive_connection_id" IS NULL)
  OR (
    "media_attested_at" IS NOT NULL
    AND (
      (
        "media" @> ARRAY['drive']::text[]
        AND "media_attested_drive_connection_id" IS NOT NULL
        AND "media_attested_drive_connection_id" = "drive_connection_id"
      )
      OR (
        NOT "media" @> ARRAY['drive']::text[]
        AND "media_attested_drive_connection_id" IS NULL
      )
    )
  )
);
--> statement-breakpoint
-- Nullable is binding: 0091 is already deployed. Every E1-created candidate
-- nevertheless carries a non-null transition id and the repository refuses
-- legacy-null rows for promotion.
ALTER TABLE "vault_server_candidates" ADD COLUMN "transition_id" uuid;
--> statement-breakpoint
CREATE INDEX "vault_server_candidates_transition_idx"
ON "vault_server_candidates" USING btree ("vault_id", "transition_id");
--> statement-breakpoint

-- ── R4: lifetime retirement generation + current retirement snapshot ───────
-- The allocator lives on vaults because the signed purge deletes the current
-- vault_retirements row. Keeping the counter on the vault makes generation
-- monotonic across retire → purge → re-add-server → retire cycles.
ALTER TABLE "vaults"
ADD COLUMN "retirement_generation" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "vaults"
ADD CONSTRAINT "vaults_retirement_generation_nonnegative"
CHECK ("retirement_generation" >= 0);
--> statement-breakpoint
ALTER TABLE "vault_retirements"
ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "vault_retirements"
ADD CONSTRAINT "vault_retirements_generation_positive"
CHECK ("generation" > 0);
