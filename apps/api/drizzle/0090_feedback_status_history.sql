-- #1338 — make feedback outcomes explicit and readable by their submitters.
-- `new` / `triaged` retain #1315's public names. The former catch-all `done`
-- cannot tell a user what happened, so any such legacy row returns to triage
-- for an owner to classify deliberately with a reason or shipped version.
ALTER TABLE "feedback" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
CREATE TYPE "public"."feedback_status_v2" AS ENUM(
	'new',
	'triaged',
	'working_on_it',
	'saved_as_future_idea',
	'declined',
	'shipped'
);
--> statement-breakpoint
ALTER TABLE "feedback"
ALTER COLUMN "status" TYPE "public"."feedback_status_v2"
USING (
	CASE "status"::text
		WHEN 'done' THEN 'triaged'
		ELSE "status"::text
	END
)::"public"."feedback_status_v2";
--> statement-breakpoint
DROP TYPE "public"."feedback_status";
--> statement-breakpoint
ALTER TYPE "public"."feedback_status_v2" RENAME TO "feedback_status";
--> statement-breakpoint
ALTER TABLE "feedback" ALTER COLUMN "status" SET DEFAULT 'new'::"public"."feedback_status";
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "last_status_change_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "feedback" SET "last_status_change_at" = "updated_at";
--> statement-breakpoint
ALTER TABLE "feedback" ALTER COLUMN "last_status_change_at" SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE "feedback" ALTER COLUMN "last_status_change_at" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "declined_reason" text;
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "shipped_version" varchar(64);
--> statement-breakpoint
ALTER TABLE "feedback"
ADD CONSTRAINT "feedback_status_metadata_pair" CHECK (
	(
		"status" = 'declined'
		AND "declined_reason" IS NOT NULL
		AND btrim("declined_reason") <> ''
		AND char_length("declined_reason") <= 1000
		AND "shipped_version" IS NULL
	)
	OR (
		"status" = 'shipped'
		AND "shipped_version" IS NOT NULL
		AND btrim("shipped_version") <> ''
		AND char_length("shipped_version") <= 64
		AND "declined_reason" IS NULL
	)
	OR (
		"status" NOT IN ('declined', 'shipped')
		AND "declined_reason" IS NULL
		AND "shipped_version" IS NULL
	)
);
--> statement-breakpoint
-- BetterTrackMobile must be allowed to request the new read scope before the
-- app advertises it. Union-only, matching the #1315 write-scope migration.
UPDATE "oauth_clients"
SET "scopes" = "scopes" || ARRAY['feedback:read']::text[]
WHERE "client_id" = 'btc_IbT1mzw_7kBiPHPkGfaE0Q'
  AND NOT ('feedback:read' = ANY("scopes"));
