-- Per-portfolio setting overrides (issue #636): the override layer of the
-- scoping cascade `effective = portfolio override ?? user default ?? system
-- default`. One row per (portfolio, setting key) pins a value for that portfolio
-- only; a generic key/jsonb store so any scopeable setting opts in without a
-- migration (first key: 'tax', value { mode, country }). A missing row means the
-- portfolio inherits its user-level default; deleting a row is reset-to-default.
-- Cascades away with the owning portfolio.
CREATE TABLE "portfolio_settings" (
	"portfolio_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portfolio_settings_portfolio_id_key_pk" PRIMARY KEY("portfolio_id","key")
);
--> statement-breakpoint
ALTER TABLE "portfolio_settings" ADD CONSTRAINT "portfolio_settings_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE cascade ON UPDATE no action;
