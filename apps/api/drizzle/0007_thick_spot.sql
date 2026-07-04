CREATE TYPE "public"."email_status" AS ENUM('sent', 'failed', 'suppressed');--> statement-breakpoint
CREATE TABLE "email_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"recipient" varchar(320) NOT NULL,
	"template" varchar(64) NOT NULL,
	"subject" text NOT NULL,
	"status" "email_status" NOT NULL,
	"error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_log_created_at_idx" ON "email_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "email_log_user_id_idx" ON "email_log" USING btree ("user_id");