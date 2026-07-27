ALTER TABLE "friendships" ADD COLUMN "user_a_sharing_revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "friendships" ADD COLUMN "user_b_sharing_revoked_at" timestamp with time zone;
