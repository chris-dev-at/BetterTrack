-- #420 — Registration modes live (§6.12, §13.4 V4-P4a). Two additive tables, no
-- change to any existing table: activating a self-serve mode is now a data
-- switch, not a rebuild. `registration_tokens` gates the invite-token mode
-- (single/multi-use with a counter + optional expiry, hash-only); the
-- `approval` mode parks self-serve applicants in `registration_requests` as
-- PENDING rows that are NOT `users` — a pending applicant has no usable account.
-- Closed mode is unaffected: with the mode stored as `closed`, neither table is
-- ever read on the register path.
CREATE TABLE "registration_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"label" varchar(80),
	"max_uses" integer DEFAULT 1 NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registration_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" varchar(320) NOT NULL,
	"username" varchar(40) NOT NULL,
	"password_hash" text NOT NULL,
	"locale" varchar(5) DEFAULT 'en' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "registration_tokens" ADD CONSTRAINT "registration_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "registration_tokens_token_hash_unique" ON "registration_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "registration_requests_email_unique" ON "registration_requests" USING btree ("email");
--> statement-breakpoint
CREATE UNIQUE INDEX "registration_requests_username_lower_unique" ON "registration_requests" USING btree (lower("username"));
