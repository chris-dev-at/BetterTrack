-- #1339 — each feedback submission is its own admin ↔ submitter support thread.
-- The two last-read timestamps derive unread counts at read time; no mutable
-- counters or per-message read-receipt rows are introduced.
CREATE TYPE "public"."feedback_message_author_side" AS ENUM('submitter', 'admin');
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "submitter_last_read_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "admin_last_read_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "feedback_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"feedback_id" uuid NOT NULL,
	"author_side" "feedback_message_author_side" NOT NULL,
	"author_user_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_messages_not_empty" CHECK ("feedback_messages"."body" ~ '[^[:space:]]'),
	CONSTRAINT "feedback_messages_body_length" CHECK (char_length("feedback_messages"."body") <= 4000)
);
--> statement-breakpoint
ALTER TABLE "feedback_messages"
ADD CONSTRAINT "feedback_messages_feedback_id_feedback_id_fk"
FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id")
ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Nullable + ON DELETE set null, as chat's sender_id (#362): an admin's replies
-- live on other users' submissions, so account deletion must anonymize them
-- rather than be blocked by them. `author_side` keeps the staff attribution.
ALTER TABLE "feedback_messages"
ADD CONSTRAINT "feedback_messages_author_user_id_users_id_fk"
FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id")
ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "feedback_messages_feedback_idx"
ON "feedback_messages" USING btree ("feedback_id","created_at","id");
