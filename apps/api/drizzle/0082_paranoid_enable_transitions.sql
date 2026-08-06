-- #1126 — a normal account may expose opaque server-vault bytes only inside
-- the owning browser's short-lived paranoid-enable capture window. Expiry is
-- durable so both API processes and the worker agree when staged bytes become
-- abandoned and must be deleted.
CREATE TABLE "paranoid_enable_transitions" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paranoid_enable_transitions" ADD CONSTRAINT "paranoid_enable_transitions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paranoid_enable_transitions_expires_idx" ON "paranoid_enable_transitions" USING btree ("expires_at");--> statement-breakpoint
-- Existing normal-mode rows predate durable staging. Give an in-flight wizard
-- one ordinary staging lifetime to commit; abandoned rows then enter the same
-- cleanup path instead of remaining orphaned forever.
INSERT INTO "paranoid_enable_transitions" (
	"user_id",
	"expires_at",
	"created_at",
	"updated_at"
)
SELECT DISTINCT
	"users"."id",
	now() + interval '10 minutes',
	now(),
	now()
FROM "users"
WHERE "users"."privacy_mode" = 'normal'
	AND (
		EXISTS (SELECT 1 FROM "paranoid_vaults" WHERE "paranoid_vaults"."user_id" = "users"."id")
		OR EXISTS (SELECT 1 FROM "paranoid_vault_history" WHERE "paranoid_vault_history"."user_id" = "users"."id")
	)
ON CONFLICT ("user_id") DO NOTHING;
