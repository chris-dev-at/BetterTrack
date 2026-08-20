-- #1400 — widen feedback into a helpdesk without changing the three wire
-- values already shipped to mobile. PostgreSQL enum additions are append-only.
ALTER TYPE "public"."feedback_category" ADD VALUE 'help';
--> statement-breakpoint
ALTER TYPE "public"."feedback_category" ADD VALUE 'improvement';
--> statement-breakpoint
-- A user can leave a conversation without erasing the owner's audit trail.
-- NULL means visible to the submitter; a timestamp is the admin tombstone.
ALTER TABLE "feedback" ADD COLUMN "deleted_by_user_at" timestamp with time zone;
