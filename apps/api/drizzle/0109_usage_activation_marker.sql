-- V5-P2 arc (b), #1680: a durable activation marker for the registration funnel.
--
-- `activatedUsers()` used to be `count(distinct user_id)` over ALL of
-- `usage_events`, a lifetime metric read from a table that #1614/#1664 then gave
-- a retention window (`BT_USAGE_EVENT_RETENTION_DAYS`, default 180). Once an
-- instance outlives that window, a user who registered, used the app for a week
-- and went dormant silently drops out of the count, so registered→activated
-- decays month over month and reads as an activation collapse that never
-- happened. The `usage_daily` rollup cannot rescue it: it is keyed
-- (day, feature) and carries no user id.
--
-- So activation gets its own narrow home: one row per account, written at the
-- same locked `upsertEvents` boundary that admits a raw event, never swept by
-- retention. `user_id` is the PRIMARY KEY, which is what makes the writer's
-- ON CONFLICT DO NOTHING idempotent — re-activity can neither duplicate the row
-- nor move `first_active_at`.
CREATE TABLE "usage_activations" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"first_active_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Account deletion must stay total (§10), exactly as for `usage_events`.
ALTER TABLE "usage_activations"
ADD CONSTRAINT "usage_activations_user_id_users_id_fk"
FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- BEST-EFFORT backfill, and deliberately nothing more (#1680 out-of-scope):
-- pre-migration activation can only be recovered from the raw rows that
-- SURVIVED the sweeps already run, so a user whose events were pruned before
-- this migration stays uncounted until their next activity re-marks them.
--
-- This is the ONE write in #1680 that does not come from the admitted set the
-- writer computes under the privacy lock, so §6.12 ("vaulted/paranoid data
-- never counted") is enforced here rather than inferred. Reading `usage_events`
-- alone would already be very likely to hold — enable purges every one of a
-- paranoid account's rows and capture is suppressed afterwards — but that is a
-- claim about historical state, not a constraint on the statement. The NOT
-- EXISTS makes it structural, and costs nothing on a one-shot backfill.
INSERT INTO "usage_activations" ("user_id", "first_active_at")
SELECT "usage_events"."user_id", min("usage_events"."last_seen_at")
FROM "usage_events"
WHERE NOT EXISTS (
	SELECT 1
	FROM "users" u
	WHERE u."id" = "usage_events"."user_id" AND u."privacy_mode" = 'paranoid'
)
GROUP BY "usage_events"."user_id"
ON CONFLICT ("user_id") DO NOTHING;
