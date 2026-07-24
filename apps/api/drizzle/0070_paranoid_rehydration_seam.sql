-- V5-P13 PD3a — durable, portfolio-free transition metadata and the atomic
-- disable/rehydration retry receipt. No cleartext document, count, fingerprint,
-- key, or Drive token is stored here.
ALTER TABLE "users" ADD COLUMN "paranoid_media_set" text[];--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "paranoid_drive_attested_version" integer;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_paranoid_media_state" CHECK (
  ("privacy_mode" = 'normal' AND "paranoid_media_set" IS NULL AND "paranoid_drive_attested_version" IS NULL)
  OR (
    "privacy_mode" = 'paranoid'
    AND "paranoid_media_set" IS NOT NULL
    AND (
      "paranoid_media_set" = ARRAY['server']::text[]
      OR "paranoid_media_set" = ARRAY['drive']::text[]
      OR "paranoid_media_set" = ARRAY['server', 'drive']::text[]
      OR "paranoid_media_set" = ARRAY['drive', 'server']::text[]
    )
    AND (
      "paranoid_drive_attested_version" IS NULL
      OR ("paranoid_drive_attested_version" > 0 AND "paranoid_media_set" @> ARRAY['drive']::text[])
    )
  )
);--> statement-breakpoint
CREATE TABLE "paranoid_rehydration_receipts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"rehydration_id" uuid NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paranoid_rehydration_receipts" ADD CONSTRAINT "paranoid_rehydration_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paranoid_rehydration_receipts_rehydration_id_unique" ON "paranoid_rehydration_receipts" USING btree ("rehydration_id");
