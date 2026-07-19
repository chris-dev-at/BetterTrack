-- Passkeys / WebAuthn credentials (§13.4 V4-P4): passwordless sign-in credentials
-- registered to an existing account and managed in Settings → Security. Each row
-- holds the authenticator's credential id (unique — assertions are looked up by
-- it), its COSE public key, the signature counter (bigint: the full 32-bit
-- WebAuthn counter; a non-increasing counter is a cloned-authenticator signal),
-- and the reported transports. Cascades away with the owning user.
CREATE TABLE "passkeys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "passkeys_credential_id_unique" ON "passkeys" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "passkeys_user_idx" ON "passkeys" USING btree ("user_id");
