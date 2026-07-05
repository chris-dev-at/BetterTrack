CREATE TYPE "public"."cash_movement_kind" AS ENUM('deposit', 'withdrawal', 'buy', 'sell_proceeds');--> statement-breakpoint
CREATE TABLE "portfolio_cash_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"kind" "cash_movement_kind" NOT NULL,
	"amount_eur" numeric(20, 6) NOT NULL,
	"transaction_id" uuid,
	"executed_at" timestamp with time zone NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portfolio_cash_movements_sign" CHECK (("portfolio_cash_movements"."kind" in ('deposit','sell_proceeds') and "portfolio_cash_movements"."amount_eur" > 0)
          or ("portfolio_cash_movements"."kind" in ('withdrawal','buy') and "portfolio_cash_movements"."amount_eur" < 0))
);
--> statement-breakpoint
ALTER TABLE "portfolios" ADD COLUMN "default_pay_from_cash" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ADD CONSTRAINT "portfolio_cash_movements_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ADD CONSTRAINT "portfolio_cash_movements_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portfolio_cash_movements_portfolio_idx" ON "portfolio_cash_movements" USING btree ("portfolio_id","executed_at");