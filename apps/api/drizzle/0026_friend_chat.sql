-- V3-P8 (#349) — Friend chat. 1:1 direct messages between accepted friends:
-- conversations (unique per pair) + messages, with per-participant unread
-- markers and share-in-chat chips. Purely ADDITIVE — no existing table changes,
-- no new privacy path (chip resolution reuses the #332 audience enforcement).

-- Chat share-chip target kind ------------------------------------------------
CREATE TYPE "public"."chat_chip_kind" AS ENUM('asset', 'portfolio', 'conglomerate', 'watchlist');
--> statement-breakpoint

-- 1:1 conversations. One row per friend pair, stored canonical user_a < user_b
-- (like friendships), so the unique index makes "one conversation per pair" a
-- schema invariant. Unread is derived from the per-side *_last_read_at markers.
CREATE TABLE "chat_conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_a" uuid NOT NULL,
	"user_b" uuid NOT NULL,
	"user_a_last_read_at" timestamp with time zone,
	"user_b_last_read_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_user_a_users_id_fk" FOREIGN KEY ("user_a") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_user_b_users_id_fk" FOREIGN KEY ("user_b") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_conversations_pair_unique" ON "chat_conversations" USING btree ("user_a","user_b");
--> statement-breakpoint
CREATE INDEX "chat_conversations_user_a_idx" ON "chat_conversations" USING btree ("user_a");
--> statement-breakpoint
CREATE INDEX "chat_conversations_user_b_idx" ON "chat_conversations" USING btree ("user_b");
--> statement-breakpoint

-- Messages. Text and/or a bare (chip_kind, chip_subject_id) reference — never a
-- snapshot of the shared item, so every viewer's chip re-resolves through the
-- enforcement layer at read time. The CHECKs keep a message non-empty and a chip
-- all-or-nothing. UUIDv7 ids give newest-first keyset pagination.
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"body" text,
	"chip_kind" "chat_chip_kind",
	"chip_subject_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_not_empty" CHECK ("chat_messages"."body" IS NOT NULL OR "chat_messages"."chip_kind" IS NOT NULL),
	CONSTRAINT "chat_messages_chip_complete" CHECK (("chat_messages"."chip_kind" IS NULL) = ("chat_messages"."chip_subject_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "chat_messages_conversation_idx" ON "chat_messages" USING btree ("conversation_id","id");
