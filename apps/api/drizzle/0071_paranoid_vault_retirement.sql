-- V5-P13 PD6 — removing the server medium retires, rather than destroys, the
-- current opaque vault and its bounded history. Only the separately gated purge
-- may delete these rows after the recovery window.
ALTER TABLE "paranoid_vault_history" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "paranoid_vault_history_user_retired_idx" ON "paranoid_vault_history" USING btree ("user_id","retired_at");
