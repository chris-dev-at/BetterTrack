-- V5-P13 PD6 follow-up — inactive, expiring server-medium candidates. A row in
-- this table is never the live server DataHome: the browser must read back and
-- authenticate the exact candidate before a proof-bound PATCH atomically moves
-- it into paranoid_vaults and activates the server medium.
CREATE TABLE "paranoid_vault_server_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"format_version" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"blob" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paranoid_vault_server_candidates" ADD CONSTRAINT "paranoid_vault_server_candidates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paranoid_vault_server_candidates_user_unique" ON "paranoid_vault_server_candidates" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "paranoid_vault_server_candidates_expires_idx" ON "paranoid_vault_server_candidates" USING btree ("expires_at");
