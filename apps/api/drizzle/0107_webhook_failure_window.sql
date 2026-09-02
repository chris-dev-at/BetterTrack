-- Webhook auto-disable gets a bounded window (#1592).
--
-- `consecutive_failures` alone is a lifetime tally with no notion of time: five
-- terminal failures spread across five months disabled a subscription exactly
-- as readily as five in a row, so a receiver that is up 99.9 % of the time was
-- guaranteed to be disabled eventually. The streak now carries the timestamp of
-- its FIRST failure; a failure arriving more than WEBHOOK_AUTO_DISABLE_WINDOW_MS
-- after that anchor starts a fresh streak at 1 instead of extending a stale one.
-- Null exactly when the streak is 0.
ALTER TABLE "webhook_subscriptions"
ADD COLUMN "failure_window_started_at" timestamp with time zone;
--> statement-breakpoint
-- Backfill: adopt the last delivery attempt as the anchor of an already-running
-- streak. That attempt WAS the streak's most recent failure (a success would
-- have zeroed the counter), so it is the newest instant the streak can claim.
--
-- Be honest about the direction: this is the STRICT choice, not the lenient
-- one. The streak's true first failure is older and unrecorded, so a
-- last-failure anchor does fabricate recency — it keeps a legacy streak alive
-- until `last_delivery_at + window` instead of `first_failure + window`. The
-- concrete cost: a row sitting at 4 failures spread over five months whose most
-- recent failure landed under 24 h before the deploy is anchored as if the
-- streak were fresh, and its very next failure disables it — one bounded,
-- one-time instance of exactly the defect this migration removes. It is
-- self-healing: any row whose last failure is already older than the window
-- restarts at 1 on its next failure.
--
-- It is chosen because the alternatives are worse. The two failure modes it
-- avoids outright: nobody is disabled by the deploy itself (a disable only ever
-- happens on a delivery, and the anchor is in the past, never in the future),
-- and nobody is silently forgiven either — a fabricated OLD anchor (say
-- `now() - window`) would zero every legacy streak, including the receivers
-- that are dead right now.
--
-- `last_delivery_at` is null only if the counter was raised without any
-- recorded delivery, which no code path does; `updated_at` is the conservative
-- fallback so the column's "null iff streak is 0" invariant holds for every row.
UPDATE "webhook_subscriptions"
SET "failure_window_started_at" = COALESCE("last_delivery_at", "updated_at")
WHERE "consecutive_failures" > 0;
