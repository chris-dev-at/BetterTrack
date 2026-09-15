-- A second auto-disable streak that age never decays (#1646).
--
-- 0118 gave the streak a 24 h window so a healthy receiver could not be killed
-- by blips months apart. That fixed one direction and opened the mirror one: a
-- genuinely dead receiver subscribed to events RARER than the window resets
-- `consecutive_failures` to 1 on every failure and can never reach the
-- threshold, so it never auto-disables and pays the full retry ladder per event
-- indefinitely — relaxing §13.5's "a dead receiver auto-disables after N
-- failures" for exactly the low-volume subscriptions it was written for.
--
-- This counter answers the question the windowed one cannot: have the last N
-- deliveries ALL failed, whatever the gaps between them? It is cleared only by
-- a success or a manual re-enable, never by age.
ALTER TABLE "webhook_subscriptions"
ADD COLUMN "unbroken_failure_streak" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- The streak's own anchor — its first failure since the last success — and the
-- basis of the minimum-span check on this leg. It cannot be derived from
-- `last_success_at`: a receiver that succeeded a year ago and then failed five
-- times in five minutes would measure a one-year span and defeat the burst
-- protection the span exists for. Null exactly when the counter is 0.
ALTER TABLE "webhook_subscriptions"
ADD COLUMN "unbroken_streak_started_at" timestamp with time zone;
--> statement-breakpoint
-- Backfill: adopt the windowed streak as the unbroken one. It is the only
-- evidence on the row, and it is the LENIENT direction here — the true unbroken
-- streak is at least as long as the windowed one (the windowed counter is the
-- unbroken one after age decay), so this can only undercount, never overcount.
-- Undercounting keeps a subscription alive an extra failure or two; the loud
-- mistake would be disabling a working receiver on a fabricated streak.
--
-- The anchor comes from the same row for the same reason, which keeps the
-- "null exactly when the counter is 0" invariant true for every backfilled row:
-- 0118 already guarantees `failure_window_started_at` is null exactly when
-- `consecutive_failures` is 0.
UPDATE "webhook_subscriptions"
SET "unbroken_failure_streak" = "consecutive_failures",
    "unbroken_streak_started_at" = "failure_window_started_at"
WHERE "consecutive_failures" > 0;
