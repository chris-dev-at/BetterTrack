-- #495 — Telegram + Discord notification channels (§13.4 V4-P10). Additive:
-- one table per per-user setup (Telegram bot link handshake, Discord webhook
-- URL encrypted via secretBox). The `notification_channel` enum already
-- carries `telegram` + `discord` (added in #368/#391's baseline), so no enum
-- alter is needed here — the existing notification_settings.channel FK works
-- for the new columns out of the box.

CREATE TABLE "telegram_links" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"chat_id" text,
	"bot_username" text,
	"link_code" text,
	"link_code_expires_at" timestamp with time zone,
	"linked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "telegram_links_link_code_idx" ON "telegram_links" USING btree ("link_code");
--> statement-breakpoint
CREATE TABLE "discord_webhooks" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"encrypted_url" text NOT NULL,
	"webhook_id_masked" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discord_webhooks" ADD CONSTRAINT "discord_webhooks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
