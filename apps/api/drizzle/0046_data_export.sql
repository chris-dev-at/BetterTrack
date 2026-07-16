-- #494 — Account data export (§13.4 V4-P6a). Additive: one table for the async
-- export job + one status enum. A job assembles a zip of every user-owned entity
-- under the env-configured export dir; the download is gated by a hashed token +
-- expiry (only the SHA-256 hash lands here, never the raw token). Cascades away
-- with the owning user; the cleanup job deletes files + rows past expiry.

CREATE TYPE "public"."export_job_status" AS ENUM('pending', 'ready', 'failed');
--> statement-breakpoint
CREATE TABLE "export_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "export_job_status" DEFAULT 'pending' NOT NULL,
	"file_path" text,
	"file_size" integer,
	"download_token_hash" text,
	"expires_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "export_jobs_user_created_idx" ON "export_jobs" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "export_jobs_download_token_hash_unique" ON "export_jobs" USING btree ("download_token_hash");
--> statement-breakpoint
CREATE INDEX "export_jobs_expires_at_idx" ON "export_jobs" USING btree ("expires_at");
