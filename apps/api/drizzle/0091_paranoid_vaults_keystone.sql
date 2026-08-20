-- PARANOID VAULTS — per-portfolio schema keystone (#1410, epic E0;
-- docs/paranoid-design.md §3/§7/§8, ACKED & RULED 2026-08-20).
--
-- An account owns N vaults; a vault is a storage CONFIG (server / a separately
-- authenticated Google Drive connection / both) whose client-encrypted DOC SET
-- holds its member portfolios' content. This migration lands the config rows,
-- the blind per-doc blob store (+ history/candidates/retirement, the v1
-- account-singleton machinery re-keyed per (vault_id, doc_id)), the token-free
-- `drive_connections` registry, and the locked-stub columns on `portfolios`.
--
-- COEXISTENCE: the v1 account-level `paranoid_*` tables keep serving live
-- paranoid accounts until the §17 transition retires them (epic E9). The
-- quarantined v2 surface (`zz_vault_v2_backup_*`, migration 0089) stays
-- quarantined and untouched — its TABLE names were freed by the rename, but
-- its PK CONSTRAINT names were deliberately kept (0089 §5), which is why the
-- new `vaults` table names its primary key `vaults_v3_pk` instead of taking
-- the still-occupied default `vaults_pkey`.

-- ── 1. drive_connections (§8) — identity only, NEVER tokens/file ids ─────────
-- `google_sub` is UNIQUE PER USER, deliberately NOT globally unique: two
-- BetterTrack users may back up to the same physical Google Drive (§8); the
-- digest-named, ownership-checked object namespace is the isolation there.
CREATE TABLE "drive_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"google_sub" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drive_connections"
ADD CONSTRAINT "drive_connections_user_id_users_id_fk"
FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "drive_connections_user_sub_unique" ON "drive_connections" USING btree ("user_id","google_sub");
--> statement-breakpoint

-- ── 2. vaults (§3) — the per-vault config row ────────────────────────────────
-- `vaults_media_state`: media is exactly one non-empty duplicate-free subset
-- of {server, drive} (the contract's reserved `local` value and anything
-- unknown are rejected at this deepest boundary), and a Drive connection is
-- bound IFF the drive medium is selected. The FK to `drive_connections`
-- carries NO delete action on purpose: disconnecting a Google account refuses
-- while a vault is bound to it (§8).
CREATE TABLE "vaults" (
	"id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"media" text[] NOT NULL,
	"drive_connection_id" uuid,
	"retirement_proof_public_key" text NOT NULL,
	"key_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vaults_v3_pk" PRIMARY KEY("id"),
	CONSTRAINT "vaults_media_state" CHECK ((
			"vaults"."media" = ARRAY['server']::text[]
			OR "vaults"."media" = ARRAY['drive']::text[]
			OR "vaults"."media" = ARRAY['server', 'drive']::text[]
			OR "vaults"."media" = ARRAY['drive', 'server']::text[]
		)
		AND (
			("vaults"."media" @> ARRAY['drive']::text[] AND "vaults"."drive_connection_id" IS NOT NULL)
			OR (NOT "vaults"."media" @> ARRAY['drive']::text[] AND "vaults"."drive_connection_id" IS NULL)
		))
);
--> statement-breakpoint
ALTER TABLE "vaults"
ADD CONSTRAINT "vaults_user_id_users_id_fk"
FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- DEFERRABLE INITIALLY DEFERRED, like every restraining FK of this surface:
-- the refusal ("cannot disconnect a Google account a vault is bound to")
-- checks at COMMIT, so it still refuses any lone delete while letting the
-- account-deletion cascade — which removes both sides in one transaction —
-- pass regardless of Postgres's cascade ordering. Immediate NO ACTION would
-- abort the user delete mid-cascade.
ALTER TABLE "vaults"
ADD CONSTRAINT "vaults_drive_connection_id_drive_connections_id_fk"
FOREIGN KEY ("drive_connection_id") REFERENCES "public"."drive_connections"("id")
ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE UNIQUE INDEX "vaults_user_name_unique" ON "vaults" USING btree ("user_id","name");
--> statement-breakpoint
CREATE INDEX "vaults_drive_connection_idx" ON "vaults" USING btree ("drive_connection_id");
--> statement-breakpoint

-- ── 3. vault_blobs (§3/§5/§6) — the blind per-doc blob store ─────────────────
-- One row per (vault_id, doc_id) of a vault's doc set (header / common / one
-- portfolio doc per member). `blob` is the opaque envelope v2, never
-- interpreted past its header; `version` is the per-doc monotonic CAS token.
-- The partial unique indexes pin the doc set's shape: at most one header and
-- one common doc per vault, and one portfolio doc per portfolio ANYWHERE (a
-- portfolio lives in at most one vault). The `portfolios` FK carries NO delete
-- action: a locked stub cannot be deleted from under its only surviving copy
-- (the account-deletion cascade still passes — the vault cascade removes these
-- rows in the same statement).
CREATE TABLE "vault_blobs" (
	"vault_id" uuid NOT NULL,
	"doc_id" uuid NOT NULL,
	"doc_kind" text NOT NULL,
	"portfolio_id" uuid,
	"version" integer NOT NULL,
	"format_version" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"blob" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_blobs_pk" PRIMARY KEY("vault_id","doc_id"),
	CONSTRAINT "vault_blobs_doc_kind" CHECK ("vault_blobs"."doc_kind" IN ('header', 'common', 'portfolio')),
	CONSTRAINT "vault_blobs_portfolio_state" CHECK (("vault_blobs"."doc_kind" = 'portfolio' AND "vault_blobs"."portfolio_id" IS NOT NULL)
		OR ("vault_blobs"."doc_kind" <> 'portfolio' AND "vault_blobs"."portfolio_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "vault_blobs"
ADD CONSTRAINT "vault_blobs_vault_id_vaults_id_fk"
FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id")
ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- DEFERRABLE INITIALLY DEFERRED (see the vaults FK note): a locked stub still
-- cannot be deleted from under its doc by any lone statement, but the
-- account-deletion cascade passes because the vault cascade removes these rows
-- in the same transaction.
ALTER TABLE "vault_blobs"
ADD CONSTRAINT "vault_blobs_portfolio_id_portfolios_id_fk"
FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id")
ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE UNIQUE INDEX "vault_blobs_header_unique" ON "vault_blobs" USING btree ("vault_id") WHERE "vault_blobs"."doc_kind" = 'header';
--> statement-breakpoint
CREATE UNIQUE INDEX "vault_blobs_common_unique" ON "vault_blobs" USING btree ("vault_id") WHERE "vault_blobs"."doc_kind" = 'common';
--> statement-breakpoint
CREATE UNIQUE INDEX "vault_blobs_portfolio_unique" ON "vault_blobs" USING btree ("portfolio_id") WHERE "vault_blobs"."doc_kind" = 'portfolio';
--> statement-breakpoint

-- ── 4. vault_blob_history — the bad-write safety net, re-keyed per doc ───────
CREATE TABLE "vault_blob_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vault_id" uuid NOT NULL,
	"doc_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"format_version" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"blob" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vault_blob_history"
ADD CONSTRAINT "vault_blob_history_vault_id_vaults_id_fk"
FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id")
ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "vault_blob_history_doc_version_unique" ON "vault_blob_history" USING btree ("vault_id","doc_id","version");
--> statement-breakpoint
CREATE INDEX "vault_blob_history_doc_created_idx" ON "vault_blob_history" USING btree ("vault_id","doc_id","created_at");
--> statement-breakpoint

-- ── 5. vault_server_candidates — staged, expiring server-medium adds (§7) ───
CREATE TABLE "vault_server_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vault_id" uuid NOT NULL,
	"doc_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"format_version" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"blob" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vault_server_candidates"
ADD CONSTRAINT "vault_server_candidates_vault_id_vaults_id_fk"
FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id")
ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "vault_server_candidates_doc_unique" ON "vault_server_candidates" USING btree ("vault_id","doc_id");
--> statement-breakpoint
CREATE INDEX "vault_server_candidates_expires_idx" ON "vault_server_candidates" USING btree ("expires_at");
--> statement-breakpoint

-- ── 6. vault_retirements + vault_retired — the §7 purge gate, per vault ─────
-- One retirement record per VAULT (verifier pinned at retirement time +
-- timestamp bind the challenge/proof gate); the retired BYTES are per
-- (vault_id, doc_id, version). v1's singleton `retired_version` column has no
-- per-doc meaning and intentionally does not carry over.
CREATE TABLE "vault_retirements" (
	"vault_id" uuid PRIMARY KEY NOT NULL,
	"retirement_proof_public_key" text NOT NULL,
	"retired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vault_retirements"
ADD CONSTRAINT "vault_retirements_vault_id_vaults_id_fk"
FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id")
ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "vault_retired" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vault_id" uuid NOT NULL,
	"doc_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"format_version" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"blob" "bytea" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vault_retired"
ADD CONSTRAINT "vault_retired_vault_id_vaults_id_fk"
FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id")
ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "vault_retired_doc_version_unique" ON "vault_retired" USING btree ("vault_id","doc_id","version");
--> statement-breakpoint

-- ── 7. portfolios — the locked-stub columns (§3) ─────────────────────────────
-- FRESH columns: PR #1392 dropped the v2 pair of the same intent (0089 §1/§3);
-- `vault_alias` is deliberately not named `alias` so the retired column name
-- stays retired. NULL vault_id ⇒ a normal portfolio, byte-for-byte today's
-- behavior. The FK carries NO delete action: deleting a vault refuses while a
-- stub references it (the E1 route refuses too).
ALTER TABLE "portfolios" ADD COLUMN "vault_id" uuid;
--> statement-breakpoint
ALTER TABLE "portfolios" ADD COLUMN "vault_alias" text;
--> statement-breakpoint
-- DEFERRABLE INITIALLY DEFERRED (see the vaults FK note): deleting a vault
-- still refuses at commit while a stub references it; the account-deletion
-- cascade passes.
ALTER TABLE "portfolios"
ADD CONSTRAINT "portfolios_vault_id_vaults_id_fk"
FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id")
ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "portfolios"
ADD CONSTRAINT "portfolios_vault_alias_state"
CHECK ("portfolios"."vault_alias" IS NULL OR "portfolios"."vault_id" IS NOT NULL);
--> statement-breakpoint
CREATE INDEX "portfolios_vault_idx" ON "portfolios" USING btree ("vault_id");
