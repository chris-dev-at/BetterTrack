-- Admin panel rebuild W2 (#1406): operator notes on an account.
--
-- Admin-private annotations behind the People 360 "Notes" tab — the context an
-- audit row cannot carry ("prefers German copy", "reported the same rounding
-- bug twice"). Never exposed on a user-facing route, no behaviour anywhere in
-- the product, every write audited with the operator as actor. The table is
-- additive by construction: dropping all of it leaves every account
-- byte-identical.
--
-- The two CHECKs mirror `feedback_messages` (#1339): the zod contract already
-- rejects blank and over-long bodies, and the column repeats both so no future
-- caller can write unbounded operator prose past the route.
CREATE TABLE "admin_user_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_user_notes_not_empty" CHECK ("admin_user_notes"."body" ~ '[^[:space:]]'),
	CONSTRAINT "admin_user_notes_body_length" CHECK (char_length("admin_user_notes"."body") <= 2000)
);
--> statement-breakpoint
-- A note is about a person: when the account is deleted the note has no subject
-- left, and account deletion must stay total (§10).
ALTER TABLE "admin_user_notes"
ADD CONSTRAINT "admin_user_notes_user_id_users_id_fk"
FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Nullable + ON DELETE set null, exactly as `audit_log.actor_id`: a note
-- outlives the admin who wrote it so the operator trail stays readable, and the
-- UI renders a missing author rather than losing the note.
ALTER TABLE "admin_user_notes"
ADD CONSTRAINT "admin_user_notes_author_id_users_id_fk"
FOREIGN KEY ("author_id") REFERENCES "public"."users"("id")
ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- The only read is "this account's notes, newest first", so the index carries
-- both columns rather than making Postgres sort a user's notes on every open.
CREATE INDEX "admin_user_notes_user_created_idx"
ON "admin_user_notes" USING btree ("user_id","created_at");
