CREATE TYPE "public"."standing_order_cadence" AS ENUM('daily', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."standing_order_kind" AS ENUM('buy-asset', 'cash-add', 'cash-deduct');--> statement-breakpoint
CREATE TYPE "public"."standing_order_status" AS ENUM('active', 'paused');--> statement-breakpoint
CREATE TABLE "standing_order_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"standing_order_id" uuid NOT NULL,
	"period_key" date NOT NULL,
	"booked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "standing_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"kind" "standing_order_kind" NOT NULL,
	"asset_id" uuid,
	"amount" numeric(20, 8) NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"label" text,
	"cadence" "standing_order_cadence" NOT NULL,
	"anchor_day" integer,
	"start_date" date NOT NULL,
	"end_date" date,
	"status" "standing_order_status" DEFAULT 'active' NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_period_key" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "standing_orders_amount_positive" CHECK ("standing_orders"."amount" > 0),
	CONSTRAINT "standing_orders_asset_for_buy" CHECK (("standing_orders"."kind" = 'buy-asset') = ("standing_orders"."asset_id" is not null)),
	CONSTRAINT "standing_orders_anchor_for_monthly" CHECK (("standing_orders"."cadence" = 'monthly') = ("standing_orders"."anchor_day" is not null)),
	CONSTRAINT "standing_orders_anchor_range" CHECK ("standing_orders"."anchor_day" is null or ("standing_orders"."anchor_day" between 1 and 31)),
	CONSTRAINT "standing_orders_end_after_start" CHECK ("standing_orders"."end_date" is null or "standing_orders"."end_date" >= "standing_orders"."start_date")
);
--> statement-breakpoint
ALTER TABLE "standing_order_runs" ADD CONSTRAINT "standing_order_runs_standing_order_id_standing_orders_id_fk" FOREIGN KEY ("standing_order_id") REFERENCES "public"."standing_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_orders" ADD CONSTRAINT "standing_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_orders" ADD CONSTRAINT "standing_orders_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_orders" ADD CONSTRAINT "standing_orders_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "standing_order_runs_period_unique" ON "standing_order_runs" USING btree ("standing_order_id","period_key");--> statement-breakpoint
CREATE INDEX "standing_orders_user_idx" ON "standing_orders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "standing_orders_portfolio_idx" ON "standing_orders" USING btree ("portfolio_id");--> statement-breakpoint
CREATE INDEX "standing_orders_status_idx" ON "standing_orders" USING btree ("status");
