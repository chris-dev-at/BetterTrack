-- V4-P8 — Broker CSV imports: staged batches + normalized rows. Strictly
-- additive. A `pending` batch is pure staging — nothing in the portfolio is
-- written until the explicit apply confirm, which routes every write through
-- the existing portfolio/tax services. `broker_id` is a mapper id STRING (never
-- an enum), so adding a broker mapper needs no migration (§13.4 pluggability).
CREATE TYPE "public"."import_batch_status" AS ENUM('pending', 'applied');--> statement-breakpoint
CREATE TYPE "public"."import_row_kind" AS ENUM('buy', 'sell', 'dividend', 'deposit', 'withdrawal');--> statement-breakpoint
CREATE TYPE "public"."import_row_flag" AS ENUM('mapped', 'unmapped', 'duplicate', 'error');--> statement-breakpoint
CREATE TYPE "public"."import_row_result" AS ENUM('applied', 'skipped_duplicate', 'skipped_unmapped', 'skipped_error', 'failed');--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"broker_id" text NOT NULL,
	"filename" text NOT NULL,
	"status" "import_batch_status" DEFAULT 'pending' NOT NULL,
	"cash_source_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_index" integer NOT NULL,
	"raw" text NOT NULL,
	"kind" "import_row_kind",
	"flag" "import_row_flag" NOT NULL,
	"message" text,
	"executed_at" timestamp with time zone,
	"isin" text,
	"symbol" text,
	"name" text,
	"quantity" numeric(20, 8),
	"price" numeric(20, 6),
	"fee" numeric(20, 6),
	"amount_eur" numeric(20, 6),
	"currency" char(3),
	"note" text,
	"asset_id" uuid,
	"content_hash" text,
	"result" "import_row_result",
	"result_message" text
);
--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_cash_source_id_portfolio_cash_sources_id_fk" FOREIGN KEY ("cash_source_id") REFERENCES "public"."portfolio_cash_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_batches_owner_idx" ON "import_batches" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "import_rows_batch_idx" ON "import_rows" USING btree ("batch_id");
