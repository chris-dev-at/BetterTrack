-- #478 — Google sign-in (§13.4 V4-P4b). Additive: the external-identity table +
-- a password-usability flag on users + provider columns on the approval queue.
-- The whole feature is env-gated (BT_GOOGLE_CLIENT_ID/SECRET); this schema is
-- inert until a Google client is configured and a user actually links.

-- Federated sign-in identities — today only Google. (provider, subject) is
-- globally unique so a Google account maps to exactly one user; (provider,
-- user_id) is unique so a user links at most one account per provider. Cascades
-- away with the owning user.
CREATE TABLE "external_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"email" varchar(320) NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "external_identities_provider_subject_unique" ON "external_identities" USING btree ("provider","subject");
--> statement-breakpoint
CREATE UNIQUE INDEX "external_identities_provider_user_unique" ON "external_identities" USING btree ("provider","user_id");
--> statement-breakpoint
CREATE INDEX "external_identities_user_idx" ON "external_identities" USING btree ("user_id");
--> statement-breakpoint
-- Whether `password_hash` is a real, user-chosen credential. A Google-registered
-- account is created password-less (random unusable hash, flag false); every
-- existing / password account is true (the column default).
ALTER TABLE "users" ADD COLUMN "has_usable_password" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
-- Approval-queue support for the Google path: password is now nullable (a
-- federated applicant has none), plus the verified provider identity carried
-- through to account creation on admin approval.
ALTER TABLE "registration_requests" ALTER COLUMN "password_hash" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "registration_requests" ADD COLUMN "provider" text;
--> statement-breakpoint
ALTER TABLE "registration_requests" ADD COLUMN "provider_subject" text;
--> statement-breakpoint
ALTER TABLE "registration_requests" ADD COLUMN "provider_email_verified" boolean DEFAULT false NOT NULL;
