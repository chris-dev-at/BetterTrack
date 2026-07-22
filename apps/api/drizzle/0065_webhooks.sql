-- V5-P10 — Outbound webhooks (issue 1/2). Strictly additive: two new tables and
-- one enum for the "API as a product" outbound leg. `webhook_subscriptions`
-- holds a user's target URLs + subscribed event types + the AES-256-GCM
-- envelope of the signing secret (never the plaintext); `webhook_deliveries` is
-- the bounded per-subscription delivery log the retention-cleanup cron prunes by
-- age. Nothing references portfolio/tax data — deliveries carry only the
-- subscribing user's own domain-event payload.
CREATE TYPE "public"."webhook_delivery_status" AS ENUM('success', 'failed');--> statement-breakpoint
CREATE TABLE "webhook_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"url" text NOT NULL,
	"description" varchar(200),
	"event_types" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"secret_encrypted" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"disabled_reason" text,
	"disabled_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_delivery_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subscription_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"status" "webhook_delivery_status" NOT NULL,
	"response_status" integer,
	"attempts" integer DEFAULT 1 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_webhook_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."webhook_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_subscriptions_user_idx" ON "webhook_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_subscription_idx" ON "webhook_deliveries" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_created_idx" ON "webhook_deliveries" USING btree ("created_at");
