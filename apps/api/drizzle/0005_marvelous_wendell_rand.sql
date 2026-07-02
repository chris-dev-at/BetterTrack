CREATE TYPE "public"."portfolio_visibility" AS ENUM('private', 'friends');--> statement-breakpoint
ALTER TABLE "portfolios" ADD COLUMN "visibility" "portfolio_visibility" DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "portfolios" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;