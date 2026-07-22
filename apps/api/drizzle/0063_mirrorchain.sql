-- MIRRORCHAIN — group portfolios (§13.5 V5-P7; docs/mirrorchain-design.md §1,
-- binding). Additive chain link layer only — the five tables below plus their
-- enums; ZERO changes to existing tables (design §1). A chain is ONE logical
-- portfolio materialized as a real `portfolios` row (a "copy") in every member's
-- account; ops in a per-chain totally-ordered log replicate writes across copies.
-- This is M1: schema + indexes/invariants, no behavior.
CREATE TYPE "public"."mirror_chain_status" AS ENUM('active', 'dissolved');--> statement-breakpoint
CREATE TYPE "public"."mirror_member_role" AS ENUM('owner', 'manager', 'member');--> statement-breakpoint
CREATE TYPE "public"."mirror_member_status" AS ENUM('active', 'left', 'removed', 'dissolved', 'account_deleted');--> statement-breakpoint
CREATE TYPE "public"."mirror_invite_status" AS ENUM('pending', 'accepted', 'declined', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."mirror_row_kind" AS ENUM('transaction', 'dividend', 'cash_movement', 'cash_source');--> statement-breakpoint
CREATE TABLE "mirror_chains" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" "mirror_chain_status" DEFAULT 'active' NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_by_username" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dissolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mirror_chain_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"chain_id" uuid NOT NULL,
	"user_id" uuid,
	"username" text NOT NULL,
	"portfolio_id" uuid,
	"role" "mirror_member_role" NOT NULL,
	"status" "mirror_member_status" DEFAULT 'active' NOT NULL,
	"applied_seq" bigint DEFAULT 0 NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invited_by" uuid,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mirror_chain_invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"chain_id" uuid NOT NULL,
	"from_user" uuid,
	"to_user" uuid NOT NULL,
	"status" "mirror_invite_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mirror_chain_ops" (
	"id" uuid PRIMARY KEY NOT NULL,
	"chain_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"kind" text NOT NULL,
	"mirror_id" uuid,
	"actor_user_id" uuid,
	"actor_username" text NOT NULL,
	"origin_portfolio_id" uuid,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mirror_rows" (
	"chain_id" uuid NOT NULL,
	"kind" "mirror_row_kind" NOT NULL,
	"mirror_id" uuid NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"local_id" uuid NOT NULL,
	"created_by" uuid,
	"created_by_username" text NOT NULL,
	CONSTRAINT "mirror_rows_pk" PRIMARY KEY("kind","mirror_id","portfolio_id")
);
--> statement-breakpoint
ALTER TABLE "mirror_chains" ADD CONSTRAINT "mirror_chains_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mirror_chain_members" ADD CONSTRAINT "mirror_chain_members_chain_id_mirror_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."mirror_chains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mirror_chain_members" ADD CONSTRAINT "mirror_chain_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mirror_chain_members" ADD CONSTRAINT "mirror_chain_members_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mirror_chain_members" ADD CONSTRAINT "mirror_chain_members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mirror_chain_invites" ADD CONSTRAINT "mirror_chain_invites_chain_id_mirror_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."mirror_chains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mirror_chain_invites" ADD CONSTRAINT "mirror_chain_invites_from_user_users_id_fk" FOREIGN KEY ("from_user") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mirror_chain_invites" ADD CONSTRAINT "mirror_chain_invites_to_user_users_id_fk" FOREIGN KEY ("to_user") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mirror_chain_ops" ADD CONSTRAINT "mirror_chain_ops_chain_id_mirror_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."mirror_chains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mirror_chain_ops" ADD CONSTRAINT "mirror_chain_ops_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mirror_chain_ops" ADD CONSTRAINT "mirror_chain_ops_origin_portfolio_id_portfolios_id_fk" FOREIGN KEY ("origin_portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mirror_rows" ADD CONSTRAINT "mirror_rows_chain_id_mirror_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."mirror_chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mirror_rows" ADD CONSTRAINT "mirror_rows_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mirror_rows" ADD CONSTRAINT "mirror_rows_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mirror_chain_members_chain_idx" ON "mirror_chain_members" USING btree ("chain_id");--> statement-breakpoint
CREATE INDEX "mirror_chain_members_user_idx" ON "mirror_chain_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mirror_chain_members_owner_unique" ON "mirror_chain_members" USING btree ("chain_id") WHERE "mirror_chain_members"."status" = 'active' and "mirror_chain_members"."role" = 'owner';--> statement-breakpoint
CREATE UNIQUE INDEX "mirror_chain_members_active_user_unique" ON "mirror_chain_members" USING btree ("chain_id","user_id") WHERE "mirror_chain_members"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "mirror_chain_members_active_portfolio_unique" ON "mirror_chain_members" USING btree ("portfolio_id") WHERE "mirror_chain_members"."status" = 'active';--> statement-breakpoint
CREATE INDEX "mirror_chain_invites_to_user_idx" ON "mirror_chain_invites" USING btree ("to_user");--> statement-breakpoint
CREATE UNIQUE INDEX "mirror_chain_invites_pending_unique" ON "mirror_chain_invites" USING btree ("chain_id","to_user") WHERE "mirror_chain_invites"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "mirror_chain_ops_chain_seq_unique" ON "mirror_chain_ops" USING btree ("chain_id","seq");--> statement-breakpoint
CREATE INDEX "mirror_chain_ops_entity_idx" ON "mirror_chain_ops" USING btree ("chain_id","mirror_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "mirror_rows_kind_local_unique" ON "mirror_rows" USING btree ("kind","local_id");--> statement-breakpoint
CREATE INDEX "mirror_rows_portfolio_idx" ON "mirror_rows" USING btree ("portfolio_id");
