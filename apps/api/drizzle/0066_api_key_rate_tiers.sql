-- V5-P10 — API platform: per-key rate tiers + per-key request-log audit trail
-- (issue 2/2). Strictly additive: one admin-configurable tier-definitions table
-- (name/limit/window), a nullable `tier_id` on the existing api_keys table, and a
-- bounded per-key request log the retention-cleanup cron prunes by age. A single
-- default tier is seeded so existing keys resolve a sane limit unchanged.
CREATE TABLE "api_key_tiers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(80) NOT NULL,
	"request_limit" integer NOT NULL,
	"window_sec" integer NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_key_request_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"method" varchar(10) NOT NULL,
	"path" text NOT NULL,
	"status" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "tier_id" uuid;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tier_id_api_key_tiers_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."api_key_tiers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_request_log" ADD CONSTRAINT "api_key_request_log_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_request_log" ADD CONSTRAINT "api_key_request_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_key_request_log_key_created_idx" ON "api_key_request_log" USING btree ("key_id","created_at");--> statement-breakpoint
CREATE INDEX "api_key_request_log_created_idx" ON "api_key_request_log" USING btree ("created_at");--> statement-breakpoint
INSERT INTO "api_key_tiers" ("id", "name", "request_limit", "window_sec", "is_default")
VALUES (gen_random_uuid(), 'Default', 120, 60, true);
