-- V3-P4 realized P/L & tax engine (§13.3, issue #331). Fully additive: new
-- tables (dividends, user_tax_settings), new nullable columns on transactions
-- and portfolio_cash_movements, and three new cash-movement kinds. Existing
-- rows are untouched — a NULL transactions.tax_mode reads as pre-engine
-- history and behaves exactly like 'none', and a missing user_tax_settings
-- row IS 'none' mode, so v2 behavior is preserved by construction.
CREATE TYPE "public"."tax_mode" AS ENUM('none', 'manual_per_trade', 'country_specific');--> statement-breakpoint
-- Extend cash_movement_kind with dividend + the tax settlement legs by
-- RECREATING the type (the 0019 dance). ALTER TYPE ... ADD VALUE would be
-- rejected here: the migration runs in a transaction, and the CHECK
-- constraints added below reference the new values, which Postgres forbids
-- for values added (not created) in the same transaction on a database where
-- the type pre-exists (55P04 "unsafe use of new value") — i.e. every deployed
-- instance. BOTH kind-referencing CHECKs must drop before the column type
-- dance (their expressions pin the old enum's OIDs, so the text cast would
-- fail with "operator does not exist: text = cash_movement_kind"); the sign
-- CHECK is re-added extended and the transfer-link CHECK verbatim at the end.
ALTER TABLE "portfolio_cash_movements" DROP CONSTRAINT "portfolio_cash_movements_sign";--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" DROP CONSTRAINT "portfolio_cash_movements_transfer_link";--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."cash_movement_kind";--> statement-breakpoint
CREATE TYPE "public"."cash_movement_kind" AS ENUM('deposit', 'withdrawal', 'buy', 'sell_proceeds', 'transfer_out', 'transfer_in', 'dividend', 'tax_withholding', 'tax_refund');--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ALTER COLUMN "kind" SET DATA TYPE "public"."cash_movement_kind" USING "kind"::"public"."cash_movement_kind";--> statement-breakpoint
CREATE TABLE "dividends" (
	"id" uuid PRIMARY KEY NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"cash_source_id" uuid NOT NULL,
	"gross_amount_eur" numeric(20, 6) NOT NULL,
	"executed_at" timestamp with time zone NOT NULL,
	"note" text,
	"tax_mode" "tax_mode" NOT NULL,
	"tax_country" char(2),
	"tax_amount_eur" numeric(20, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dividends_gross_positive" CHECK ("dividends"."gross_amount_eur" > 0)
);
--> statement-breakpoint
CREATE TABLE "user_tax_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"mode" "tax_mode" DEFAULT 'none' NOT NULL,
	"country" char(2),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_tax_settings_country" CHECK (("user_tax_settings"."mode" = 'country_specific') = ("user_tax_settings"."country" is not null))
);
--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ADD COLUMN "dividend_id" uuid;--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ADD COLUMN "tax_year" integer;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "tax_mode" "tax_mode";--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "tax_country" char(2);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "tax_amount_eur" numeric(20, 6);--> statement-breakpoint
ALTER TABLE "dividends" ADD CONSTRAINT "dividends_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dividends" ADD CONSTRAINT "dividends_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dividends" ADD CONSTRAINT "dividends_cash_source_id_portfolio_cash_sources_id_fk" FOREIGN KEY ("cash_source_id") REFERENCES "public"."portfolio_cash_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tax_settings" ADD CONSTRAINT "user_tax_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dividends_portfolio_idx" ON "dividends" USING btree ("portfolio_id","executed_at");--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ADD CONSTRAINT "portfolio_cash_movements_dividend_id_dividends_id_fk" FOREIGN KEY ("dividend_id") REFERENCES "public"."dividends"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ADD CONSTRAINT "portfolio_cash_movements_transfer_link" CHECK (("portfolio_cash_movements"."kind" in ('transfer_out','transfer_in'))
          = ("portfolio_cash_movements"."transfer_id" is not null and "portfolio_cash_movements"."counterpart_source_id" is not null));--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ADD CONSTRAINT "portfolio_cash_movements_tax_year" CHECK (("portfolio_cash_movements"."kind" in ('tax_withholding','tax_refund')) = ("portfolio_cash_movements"."tax_year" is not null));--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ADD CONSTRAINT "portfolio_cash_movements_dividend_link" CHECK ("portfolio_cash_movements"."kind" <> 'dividend' or "portfolio_cash_movements"."dividend_id" is not null);--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ADD CONSTRAINT "portfolio_cash_movements_sign" CHECK (("portfolio_cash_movements"."kind" in ('deposit','sell_proceeds','transfer_in','dividend','tax_refund') and "portfolio_cash_movements"."amount_eur" > 0)
          or ("portfolio_cash_movements"."kind" in ('withdrawal','buy','transfer_out','tax_withholding') and "portfolio_cash_movements"."amount_eur" < 0));
