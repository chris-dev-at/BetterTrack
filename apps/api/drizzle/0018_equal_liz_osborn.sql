ALTER TABLE "oauth_clients" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "is_first_party" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "logo_url" text;