-- PARANOID E4 (#1414): durable, content-free state for one portfolio's
-- capture / move-in / move-out pipeline. The portfolio row is the identity
-- anchor, so deleting it removes the state. Vault ids deliberately have NO FK:
-- a completed transition receipt must remain replayable after an empty vault is
-- later deleted.
CREATE TABLE "portfolio_vault_transition_states" (
	"portfolio_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"capture_revision" text,
	"capture_expires_at" timestamp with time zone,
	"capture_vault_id" uuid,
	"capture_media_attested_at" timestamp with time zone,
	"capture_media_attested_drive_connection_id" uuid,
	"lifecycle_generation" integer DEFAULT 0 NOT NULL,
	"move_in_vault_id" uuid,
	"move_in_doc_version" integer,
	"move_in_completed_at" timestamp with time zone,
	"move_in_retired_custom_asset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"move_out_vault_id" uuid,
	"move_out_id" uuid,
	"move_out_document_digest" text,
	"move_out_document_set_hash" text,
	"move_out_proof_public_key" text,
	"move_out_completed_at" timestamp with time zone,
	"move_out_post_commit_pending" boolean DEFAULT false NOT NULL,
	"move_out_post_commit_custom_asset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"move_out_post_commit_last_attempt_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portfolio_vault_transition_states_capture_pair" CHECK (
		("portfolio_vault_transition_states"."capture_revision" IS NULL)
		= ("portfolio_vault_transition_states"."capture_expires_at" IS NULL)
	),
	CONSTRAINT "portfolio_vault_transition_states_capture_target_attestation" CHECK (
		(
			"portfolio_vault_transition_states"."capture_vault_id" IS NULL
			AND "portfolio_vault_transition_states"."capture_media_attested_at" IS NULL
			AND "portfolio_vault_transition_states"."capture_media_attested_drive_connection_id" IS NULL
		)
		OR (
			"portfolio_vault_transition_states"."capture_vault_id" IS NOT NULL
			AND "portfolio_vault_transition_states"."capture_media_attested_at" IS NOT NULL
		)
	),
	CONSTRAINT "portfolio_vault_transition_states_move_in_receipt" CHECK (
		(
			"portfolio_vault_transition_states"."move_in_vault_id" IS NULL
			AND "portfolio_vault_transition_states"."move_in_doc_version" IS NULL
			AND "portfolio_vault_transition_states"."move_in_completed_at" IS NULL
		)
		OR (
			"portfolio_vault_transition_states"."move_in_vault_id" IS NOT NULL
			AND "portfolio_vault_transition_states"."move_in_doc_version" IS NOT NULL
			AND "portfolio_vault_transition_states"."move_in_completed_at" IS NOT NULL
		)
	),
	CONSTRAINT "portfolio_vault_transition_states_move_in_retirements" CHECK (
		"portfolio_vault_transition_states"."move_in_completed_at" IS NOT NULL
		OR cardinality("portfolio_vault_transition_states"."move_in_retired_custom_asset_ids") = 0
	),
	CONSTRAINT "portfolio_vault_transition_states_move_out_receipt" CHECK (
		(
			"portfolio_vault_transition_states"."move_out_vault_id" IS NULL
			AND "portfolio_vault_transition_states"."move_out_id" IS NULL
			AND "portfolio_vault_transition_states"."move_out_document_digest" IS NULL
			AND "portfolio_vault_transition_states"."move_out_document_set_hash" IS NULL
			AND "portfolio_vault_transition_states"."move_out_proof_public_key" IS NULL
			AND "portfolio_vault_transition_states"."move_out_completed_at" IS NULL
		)
		OR (
			"portfolio_vault_transition_states"."move_out_vault_id" IS NOT NULL
			AND "portfolio_vault_transition_states"."move_out_id" IS NOT NULL
			AND "portfolio_vault_transition_states"."move_out_document_digest" IS NOT NULL
			AND "portfolio_vault_transition_states"."move_out_document_set_hash" IS NOT NULL
			AND "portfolio_vault_transition_states"."move_out_proof_public_key" IS NOT NULL
			AND "portfolio_vault_transition_states"."move_out_completed_at" IS NOT NULL
		)
	),
	CONSTRAINT "portfolio_vault_transition_states_doc_version_nonnegative" CHECK (
		"portfolio_vault_transition_states"."move_in_doc_version" IS NULL
		OR "portfolio_vault_transition_states"."move_in_doc_version" >= 0
	),
	CONSTRAINT "portfolio_vault_transition_states_lifecycle_generation_range" CHECK (
		"portfolio_vault_transition_states"."lifecycle_generation" >= 0
	),
	CONSTRAINT "portfolio_vault_transition_states_receipt_lifecycle" CHECK (
		"portfolio_vault_transition_states"."lifecycle_generation" > 0
		OR (
			"portfolio_vault_transition_states"."move_in_completed_at" IS NULL
			AND "portfolio_vault_transition_states"."move_out_completed_at" IS NULL
		)
	),
	CONSTRAINT "portfolio_vault_transition_states_post_commit_plan" CHECK (
		(
			"portfolio_vault_transition_states"."move_out_post_commit_pending"
			AND "portfolio_vault_transition_states"."move_out_completed_at" IS NOT NULL
		)
		OR (
			NOT "portfolio_vault_transition_states"."move_out_post_commit_pending"
			AND cardinality("portfolio_vault_transition_states"."move_out_post_commit_custom_asset_ids") = 0
			AND "portfolio_vault_transition_states"."move_out_post_commit_last_attempt_at" IS NULL
		)
	)
);
--> statement-breakpoint
ALTER TABLE "portfolio_vault_transition_states"
ADD CONSTRAINT "portfolio_vault_transition_states_portfolio_id_portfolios_id_fk"
FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id")
ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "portfolio_vault_transition_states"
ADD CONSTRAINT "portfolio_vault_transition_states_user_id_users_id_fk"
FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "portfolio_vault_transition_states_move_out_id_unique"
ON "portfolio_vault_transition_states" USING btree ("move_out_id")
WHERE "portfolio_vault_transition_states"."move_out_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "portfolio_vault_transition_states_user_portfolio_idx"
ON "portfolio_vault_transition_states" USING btree ("user_id", "portfolio_id");
--> statement-breakpoint
CREATE INDEX "portfolio_vault_transition_states_pending_finalize_idx"
ON "portfolio_vault_transition_states" USING btree (
	"move_out_post_commit_last_attempt_at" ASC NULLS FIRST,
	"updated_at",
	"portfolio_id"
)
WHERE "move_out_post_commit_pending";
