-- #368 — Notifications v2. Additive platform pieces for the unified center:
-- two new delivery channels (phone push via FCM, browser push via VAPID) with
-- their registration stores, a durable-dedupe `hidden` flag on notifications
-- (the at-least-once notifications.dispatch job marks delivery with a row even
-- when the recipient routed the type away from in-app), and a per-user global
-- mute. Existing rows are untouched; every default keeps current behavior.

-- New matrix channels. Values are only ADDED here, never used in this
-- transaction (PG 12+ allows ADD VALUE in a tx as long as it isn't consumed).
ALTER TYPE "public"."notification_channel" ADD VALUE 'push';
--> statement-breakpoint
ALTER TYPE "public"."notification_channel" ADD VALUE 'webpush';
--> statement-breakpoint

-- FCM device registrations (phone push, folds #351) ---------------------------
CREATE TYPE "public"."device_platform" AS ENUM('android', 'ios', 'web');
--> statement-breakpoint
CREATE TABLE "device_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"platform" "device_platform" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "device_tokens_token_unique" ON "device_tokens" USING btree ("token");
--> statement-breakpoint
CREATE INDEX "device_tokens_user_id_idx" ON "device_tokens" USING btree ("user_id");
--> statement-breakpoint

-- Web-push (VAPID) subscriptions (browser push, folds #350's channel) ---------
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_unique" ON "push_subscriptions" USING btree ("endpoint");
--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_id_idx" ON "push_subscriptions" USING btree ("user_id");
--> statement-breakpoint

-- Hidden dedupe-marker rows + the global mute ---------------------------------
ALTER TABLE "notifications" ADD COLUMN "hidden" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notifications_muted" boolean DEFAULT false NOT NULL;
