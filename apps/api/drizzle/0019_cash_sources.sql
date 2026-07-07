-- V3-P3 cash sources (§13.3): the V2 single per-portfolio cash ledger becomes a
-- **Main** source plus named siblings. This migration is lossless: every
-- existing portfolio gets one Main source and every existing movement is
-- attached to it, so per-source sums equal the old per-portfolio sums exactly
-- (no amounts are touched).
CREATE TYPE "public"."cash_source_type" AS ENUM('bank', 'retirement', 'cash', 'custom');--> statement-breakpoint
-- Extend cash_movement_kind with the transfer legs by RECREATING the type.
-- ALTER TYPE ... ADD VALUE would be rejected here: the migration runs in a
-- transaction, and the CHECK constraints re-added below reference the new
-- values, which Postgres forbids for values added (not created) in the same
-- transaction (55P04 "unsafe use of new value") on a database where the type
-- pre-exists — i.e. every deployed instance. A type created in-transaction has
-- no such restriction. The sign CHECK must drop before the column type dance
-- (its expression pins the old enum's OIDs) and is re-added at the end.
ALTER TABLE "portfolio_cash_movements" DROP CONSTRAINT "portfolio_cash_movements_sign";--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."cash_movement_kind";--> statement-breakpoint
CREATE TYPE "public"."cash_movement_kind" AS ENUM('deposit', 'withdrawal', 'buy', 'sell_proceeds', 'transfer_out', 'transfer_in');--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ALTER COLUMN "kind" SET DATA TYPE "public"."cash_movement_kind" USING "kind"::"public"."cash_movement_kind";--> statement-breakpoint
CREATE TABLE "portfolio_cash_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "cash_source_type" NOT NULL,
	"is_main" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portfolio_cash_sources" ADD CONSTRAINT "portfolio_cash_sources_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portfolio_cash_sources_portfolio_name_unique" ON "portfolio_cash_sources" USING btree ("portfolio_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "portfolio_cash_sources_main_unique" ON "portfolio_cash_sources" USING btree ("portfolio_id") WHERE "portfolio_cash_sources"."is_main";--> statement-breakpoint
-- source_id lands NULLABLE first: the table may hold V2 rows that only the
-- backfill below can attribute. It becomes NOT NULL once every row is attached.
ALTER TABLE "portfolio_cash_movements" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ADD COLUMN "transfer_id" uuid;--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ADD COLUMN "counterpart_source_id" uuid;--> statement-breakpoint
-- Lossless V2 → V3 conversion, step 1: provision one Main source for every
-- existing portfolio (movements or not — existing users see their Main
-- immediately; new portfolios materialise theirs on first cash touch).
-- gen_random_uuid() is v4 rather than the app's v7 — fine for a one-time
-- backfill, nothing orders by source id.
INSERT INTO "portfolio_cash_sources" ("id", "portfolio_id", "name", "type", "is_main")
SELECT gen_random_uuid(), "id", 'Main', 'cash', true FROM "portfolios";--> statement-breakpoint
-- Step 2: attach every existing movement to its portfolio's Main source. All
-- V2 movements belonged to the single ledger, which Main now IS — per-source
-- balances therefore equal the old per-portfolio balances to the last cent.
UPDATE "portfolio_cash_movements" SET "source_id" = s."id"
FROM "portfolio_cash_sources" s
WHERE s."portfolio_id" = "portfolio_cash_movements"."portfolio_id" AND s."is_main";--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ALTER COLUMN "source_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ADD CONSTRAINT "portfolio_cash_movements_source_id_portfolio_cash_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."portfolio_cash_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ADD CONSTRAINT "portfolio_cash_movements_counterpart_source_id_portfolio_cash_sources_id_fk" FOREIGN KEY ("counterpart_source_id") REFERENCES "public"."portfolio_cash_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portfolio_cash_movements_source_idx" ON "portfolio_cash_movements" USING btree ("source_id","executed_at");--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ADD CONSTRAINT "portfolio_cash_movements_transfer_link" CHECK (("portfolio_cash_movements"."kind" in ('transfer_out','transfer_in'))
          = ("portfolio_cash_movements"."transfer_id" is not null and "portfolio_cash_movements"."counterpart_source_id" is not null));--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ADD CONSTRAINT "portfolio_cash_movements_sign" CHECK (("portfolio_cash_movements"."kind" in ('deposit','sell_proceeds','transfer_in') and "portfolio_cash_movements"."amount_eur" > 0)
          or ("portfolio_cash_movements"."kind" in ('withdrawal','buy','transfer_out') and "portfolio_cash_movements"."amount_eur" < 0));
