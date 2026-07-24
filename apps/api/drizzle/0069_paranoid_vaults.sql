-- V5-P13 arc (b) — Paranoid mode foundation (PD2, docs/paranoid-design.md §1,
-- §2, §4). Strictly additive: the account privacy-mode flag plus the server
-- BLIND blob store for a paranoid account's client-encrypted vault. The vault
-- rows hold the opaque envelope bytes (`blob`) + the minimum CAS/version
-- metadata only — never cleartext portfolio data; the server stores and returns
-- the blob verbatim and never decrypts, parses (beyond the header's version for
-- CAS) or indexes it. `paranoid_vault_history` is the bounded ciphertext safety
-- net; both tables cascade away with the user.
CREATE TYPE "public"."privacy_mode" AS ENUM('normal', 'paranoid');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "privacy_mode" "privacy_mode" DEFAULT 'normal' NOT NULL;--> statement-breakpoint
CREATE TABLE "paranoid_vaults" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"format_version" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"blob" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paranoid_vault_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"format_version" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"blob" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paranoid_vaults" ADD CONSTRAINT "paranoid_vaults_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paranoid_vault_history" ADD CONSTRAINT "paranoid_vault_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paranoid_vault_history_user_version_unique" ON "paranoid_vault_history" USING btree ("user_id","version");--> statement-breakpoint
CREATE INDEX "paranoid_vault_history_user_created_idx" ON "paranoid_vault_history" USING btree ("user_id","created_at");
