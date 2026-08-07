-- Vaults v2 (`docs/VAULTS_V2_DESIGN.md`) — per-portfolio paranoid mode as
-- multi-vault wallets. A vault is a NAMED, user-owned container with its own
-- 12-word passphrase and its own storage backend set; a portfolio is paranoid
-- iff `portfolios.vault_id` is set.
--
-- MIGRATION NUMBER: 0087, not 0085. On the branch point (main @ bb7b1bfc) the
-- highest released migration is 0084, but 0085 is held by the unmerged PR #1168
-- (`0085_tax_year_unlocks`) and 0086 by PR #1171 (`0086_portfolio_kind`).
-- Taking the next FREE number keeps three concurrent branches from claiming one
-- filename. The immutability gate (`checkMigrationsImmutable.ts`) only freezes
-- entries that already exist on `origin/main`, so appending here is legal; the
-- journal `when` below is deliberately above both pending stamps so that if
-- either lands first, the rebase is an `idx` bump and nothing else.
--
-- The server stores ciphertext BLINDLY: it never decrypts, parses or indexes a
-- document. `name` and `backends` are the only cleartext a vault carries, and
-- both are non-secret by design.
CREATE TYPE "public"."vault_backends" AS ENUM('server', 'drive', 'both');
--> statement-breakpoint
-- Three doc kinds per vault (design r2 §8): one header (kdfSalt + keySlots[] +
-- the portfolio index), one `common` (every account/vault-scoped entity kind,
-- namespaced per vault), and one per member portfolio. All CAS-versioned
-- independently, which is what makes r2's single-blob mutation rule expressible.
CREATE TYPE "public"."vault_doc_kind" AS ENUM('header', 'common', 'portfolio');
--> statement-breakpoint
CREATE TABLE "vaults" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"backends" "vault_backends" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vaults_name_length" CHECK (char_length("vaults"."name") between 1 and 64)
);
--> statement-breakpoint
ALTER TABLE "vaults"
ADD CONSTRAINT "vaults_user_id_users_id_fk"
FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "vaults_user_name_unique" ON "vaults" USING btree ("user_id","name");
--> statement-breakpoint
CREATE INDEX "vaults_user_idx" ON "vaults" USING btree ("user_id");
--> statement-breakpoint
-- One opaque document per row. Exactly one `header` per vault (kdfSalt +
-- keySlots[] + the portfolio index) and one `portfolio` blob per vaulted
-- portfolio, each INDIVIDUALLY versioned so two devices editing two different
-- portfolios of one vault never collide on the same CAS token.
--
-- `size_bytes = octet_length(ciphertext)` is asserted in the database, not just
-- in the service: the size cap is a privacy-relevant bound and a cap that lives
-- only in application code is one bad code path away from unbounded. 1 MiB for a
-- header, 8 MiB for a portfolio document.
CREATE TABLE "vault_docs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vault_id" uuid NOT NULL,
	"doc_kind" "vault_doc_kind" NOT NULL,
	"portfolio_id" uuid,
	"ciphertext" "bytea" NOT NULL,
	"size_bytes" integer NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_docs_portfolio_id_matches_kind" CHECK (("vault_docs"."doc_kind" = 'portfolio') = ("vault_docs"."portfolio_id" is not null)),
	CONSTRAINT "vault_docs_version_positive" CHECK ("vault_docs"."version" > 0),
	CONSTRAINT "vault_docs_size_cap" CHECK ("vault_docs"."size_bytes" = octet_length("vault_docs"."ciphertext")
        and "vault_docs"."size_bytes" > 0
        and "vault_docs"."size_bytes" <= (case "vault_docs"."doc_kind"
          when 'header' then 1048576
          when 'common' then 4194304
          else 8388608 end))
);
--> statement-breakpoint
ALTER TABLE "vault_docs"
ADD CONSTRAINT "vault_docs_vault_id_vaults_id_fk"
FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id")
ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vault_docs"
ADD CONSTRAINT "vault_docs_portfolio_id_portfolios_id_fk"
FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id")
ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "vault_docs_header_unique" ON "vault_docs" USING btree ("vault_id") WHERE "vault_docs"."doc_kind" = 'header';
--> statement-breakpoint
CREATE UNIQUE INDEX "vault_docs_common_unique" ON "vault_docs" USING btree ("vault_id") WHERE "vault_docs"."doc_kind" = 'common';
--> statement-breakpoint
CREATE UNIQUE INDEX "vault_docs_portfolio_unique" ON "vault_docs" USING btree ("vault_id","portfolio_id") WHERE "vault_docs"."doc_kind" = 'portfolio';
--> statement-breakpoint
CREATE INDEX "vault_docs_vault_idx" ON "vault_docs" USING btree ("vault_id");
--> statement-breakpoint
-- The paranoid bit itself. SET NULL rather than RESTRICT: the "delete only when
-- empty" precondition is enforced in the repository under `FOR UPDATE` (it must
-- also see `vault_docs`, which no FK could express), and a RESTRICT here would
-- make the users-cascade delete order load-bearing for account deletion.
ALTER TABLE "portfolios" ADD COLUMN "vault_id" uuid;
--> statement-breakpoint
ALTER TABLE "portfolios"
ADD CONSTRAINT "portfolios_vault_id_vaults_id_fk"
FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id")
ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "portfolios_vault_idx" ON "portfolios" USING btree ("vault_id");
--> statement-breakpoint
-- Server-coordinated v1 -> v2 migration (design r2 §11). The claim serializes
-- the document writes to one client at a time; `migrated_to` is the single CAS
-- commit point after which the legacy account vault is a read-only tombstone.
-- Nullable and unset for every existing row: an account that never migrates is
-- byte-identical to before.
ALTER TABLE "paranoid_vaults" ADD COLUMN "migrating_by" text;
--> statement-breakpoint
ALTER TABLE "paranoid_vaults" ADD COLUMN "migration_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "paranoid_vaults" ADD COLUMN "migrated_to" uuid;
