CREATE TYPE "public"."alert_kind" AS ENUM('price_above', 'price_below', 'pct_up_from_ref', 'pct_down_from_ref', 'pct_day_up', 'pct_day_down');--> statement-breakpoint
CREATE TYPE "public"."alert_status" AS ENUM('active', 'triggered', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."asset_type" AS ENUM('stock', 'etf', 'index', 'fx', 'commodity', 'crypto', 'custom');--> statement-breakpoint
CREATE TYPE "public"."conglomerate_status" AS ENUM('draft', 'active');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('inapp', 'email', 'telegram', 'discord');--> statement-breakpoint
CREATE TYPE "public"."transaction_side" AS ENUM('buy', 'sell');--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"kind" "alert_kind" NOT NULL,
	"threshold" numeric NOT NULL,
	"ref_price" numeric,
	"repeat" boolean DEFAULT false NOT NULL,
	"status" "alert_status" NOT NULL,
	"last_triggered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"provider_ref" text NOT NULL,
	"owner_id" uuid,
	"type" "asset_type" NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"exchange" text,
	"currency" char(3) NOT NULL,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE "conglomerate_positions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conglomerate_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"weight_pct" numeric(6, 3) NOT NULL,
	"sort_order" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conglomerates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "conglomerate_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"user_id" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"enabled" boolean NOT NULL,
	"config" jsonb,
	CONSTRAINT "notification_settings_user_channel_pk" PRIMARY KEY("user_id","channel")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"payload" jsonb,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolios" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text DEFAULT 'Main' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_history" (
	"asset_id" uuid NOT NULL,
	"date" date NOT NULL,
	"close" numeric NOT NULL,
	CONSTRAINT "price_history_asset_date_pk" PRIMARY KEY("asset_id","date")
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conglomerate_id" uuid NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"side" "transaction_side" NOT NULL,
	"quantity" numeric(20, 8) NOT NULL,
	"price" numeric(20, 6) NOT NULL,
	"fee" numeric(20, 6) DEFAULT '0' NOT NULL,
	"executed_at" timestamp with time zone NOT NULL,
	"note" text,
	CONSTRAINT "transactions_quantity_positive" CHECK ("transactions"."quantity" > 0),
	CONSTRAINT "transactions_price_nonneg" CHECK ("transactions"."price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "workboard_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conglomerate_positions" ADD CONSTRAINT "conglomerate_positions_conglomerate_id_conglomerates_id_fk" FOREIGN KEY ("conglomerate_id") REFERENCES "public"."conglomerates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conglomerate_positions" ADD CONSTRAINT "conglomerate_positions_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conglomerates" ADD CONSTRAINT "conglomerates_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_conglomerate_id_conglomerates_id_fk" FOREIGN KEY ("conglomerate_id") REFERENCES "public"."conglomerates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workboard_items" ADD CONSTRAINT "workboard_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workboard_items" ADD CONSTRAINT "workboard_items_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_provider_owner_unique" ON "assets" USING btree ("provider_id","provider_ref","owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conglomerate_positions_cong_asset_unique" ON "conglomerate_positions" USING btree ("conglomerate_id","asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "portfolios_user_name_unique" ON "portfolios" USING btree ("user_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "share_links_token_unique" ON "share_links" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "workboard_items_user_asset_unique" ON "workboard_items" USING btree ("user_id","asset_id");