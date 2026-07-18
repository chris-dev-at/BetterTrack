-- V5-P3 (#579) — quiet hours: per-user window + timezone, and a deferral store
-- for notifications fired inside the window. Strictly additive.
--
-- `users` gains an optional quiet-hours window (OFF by default, so no existing
-- user changes behaviour) plus a nullable IANA `timezone` (NULL = UTC): quiet
-- hours and the #575 digest boundaries both align to it. `notification_digest_
-- queue` gains `deliver_after` so it doubles as the deferral store — an INSTANT
-- notification fired inside the window is queued with `cadence = 'instant'` and
-- `deliver_after` = window end, delivered INDIVIDUALLY by the deferred-delivery
-- job once due (the grouped-summary path only ever queries daily/weekly).
ALTER TABLE "users" ADD COLUMN "quiet_hours_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "quiet_hours_start_minute" integer DEFAULT 1320 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "quiet_hours_end_minute" integer DEFAULT 420 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "notification_digest_queue" ADD COLUMN "deliver_after" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "notification_digest_queue_deferred_idx" ON "notification_digest_queue" USING btree ("deliver_after") WHERE "notification_digest_queue"."delivered_at" is null and "notification_digest_queue"."deliver_after" is not null;
