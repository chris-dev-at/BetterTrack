-- Self-service account deletion (#362, §13.4 V4-P2c) — chat anonymization
-- semantics (§16, 2026-07-09): deleting an account must NOT destroy the chat
-- history of the OTHER participant. The chat participant/sender columns switch
-- from ON DELETE CASCADE to nullable + ON DELETE SET NULL, so the deleted side
-- anonymizes ("Deleted user") while the survivor keeps the thread, read-only.
-- Conversations whose BOTH sides are gone are purged by the deletion service.
--
-- Safe + idempotent by construction: DROP CONSTRAINT ... IF EXISTS, re-ADD with
-- the same drizzle-conventional names, DROP NOT NULL is a no-op when already
-- nullable. No data is rewritten.
ALTER TABLE "chat_conversations" ALTER COLUMN "user_a" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_conversations" ALTER COLUMN "user_b" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_conversations" DROP CONSTRAINT IF EXISTS "chat_conversations_user_a_users_id_fk";--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_user_a_users_id_fk" FOREIGN KEY ("user_a") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversations" DROP CONSTRAINT IF EXISTS "chat_conversations_user_b_users_id_fk";--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_user_b_users_id_fk" FOREIGN KEY ("user_b") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ALTER COLUMN "sender_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" DROP CONSTRAINT IF EXISTS "chat_messages_sender_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
