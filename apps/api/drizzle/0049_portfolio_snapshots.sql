-- V5-P1 arc a (#553) — precomputed per-portfolio daily snapshots. Strictly
-- additive. One row per (portfolio, calendar day) through *yesterday*; the
-- live "today" point is computed fresh from quotes and never persisted. Money
-- columns are unconstrained numeric so the engine's full-precision output
-- round-trips verbatim (§5.4 — no snapshot-side rounding). The state table
-- carries the recompute watermark + the dirty-from invalidation marker
-- (§16 2026-07-17 invalidation rules). Both cascade away with the portfolio.
CREATE TABLE "portfolio_daily_snapshots" (
	"portfolio_id" uuid NOT NULL,
	"date" date NOT NULL,
	"value_eur" numeric NOT NULL,
	"cost_basis_eur" numeric NOT NULL,
	"pl_eur" numeric NOT NULL,
	"flow_eur" numeric NOT NULL,
	"cash_by_source" jsonb NOT NULL,
	"asset_values" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portfolio_daily_snapshots_pk" PRIMARY KEY("portfolio_id","date")
);
--> statement-breakpoint
CREATE TABLE "portfolio_snapshot_state" (
	"portfolio_id" uuid PRIMARY KEY NOT NULL,
	"computed_through" date NOT NULL,
	"dirty_from" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portfolio_daily_snapshots" ADD CONSTRAINT "portfolio_daily_snapshots_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_snapshot_state" ADD CONSTRAINT "portfolio_snapshot_state_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE cascade ON UPDATE no action;
