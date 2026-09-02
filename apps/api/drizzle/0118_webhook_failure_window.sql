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
-- have zeroed the counter), so it is the newest instant the streak can honestly
-- claim — the true first failure is older and unrecorded, which makes this the
-- lenient direction rather than a fabricated-recency one.
--
-- The two failure modes this deliberately avoids: nobody is disabled by the
-- deploy itself (a disable only ever happens on a delivery, and the anchor is
-- in the past, never in the future), and nobody is silently forgiven either —
-- a receiver still dead keeps its count and trips on its next failures, while
-- one whose streak is already older than the window restarts from 1, which is
-- precisely the transient-outage case this migration exists to fix.
--
-- `last_delivery_at` is null only if the counter was raised without any
-- recorded delivery, which no code path does; `updated_at` is the conservative
-- fallback so the column's "null iff streak is 0" invariant holds for every row.
UPDATE "webhook_subscriptions"
SET "failure_window_started_at" = COALESCE("last_delivery_at", "updated_at")
WHERE "consecutive_failures" > 0;
