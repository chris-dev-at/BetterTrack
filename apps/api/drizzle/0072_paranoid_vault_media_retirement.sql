-- V5-P13 PD6 foundation (#895): server-medium transitions never destroy bytes.
-- Drive-only staging lives outside the active vault, and a separate retirement
-- set retains the active head plus bounded history until an explicit, retained
-- and cryptographically proven purge succeeds.
ALTER TABLE "paranoid_vaults" ADD COLUMN "retirement_proof_public_key" text;--> statement-breakpoint
CREATE TABLE "paranoid_vault_server_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"format_version" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"blob" bytea NOT NULL,
	"retirement_proof_public_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paranoid_vault_retirements" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"retired_version" integer NOT NULL,
	"retirement_proof_public_key" text NOT NULL,
	"retired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paranoid_vault_retired" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"format_version" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"blob" bytea NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paranoid_vault_server_candidates" ADD CONSTRAINT "paranoid_vault_server_candidates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paranoid_vault_retirements" ADD CONSTRAINT "paranoid_vault_retirements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paranoid_vault_retired" ADD CONSTRAINT "paranoid_vault_retired_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paranoid_vault_server_candidates_user_unique" ON "paranoid_vault_server_candidates" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "paranoid_vault_server_candidates_expires_idx" ON "paranoid_vault_server_candidates" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "paranoid_vault_retired_user_version_unique" ON "paranoid_vault_retired" USING btree ("user_id","version");--> statement-breakpoint
CREATE INDEX "paranoid_vault_retired_user_version_idx" ON "paranoid_vault_retired" USING btree ("user_id","version");
