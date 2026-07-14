-- #455 — Alert follows + alert visibility. Additive only.
-- `users.alerts_visible_to_followers` (default OFF) is the owner's opt-in that
-- exposes their price alerts to their FOLLOWERS; while off, no follower ever
-- sees or is notified about an alert (the fan-out queries join on the flag at
-- emission time, so flipping it off stops delivery immediately). Per-user over
-- the whole alert list, NOT a V3-P5 audience row: followers are not friends,
-- so the friend-scoped audience rungs don't map (PROJECTPLAN §16 2026-07-14).
ALTER TABLE "users" ADD COLUMN "alerts_visible_to_followers" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Per-followed-person alert-follow triggers (#455, both default OFF,
-- independent): notify me when they CREATE a new alert / when one of their
-- alerts FIRES. Notify-only — nothing is copied into the follower's alert list.
ALTER TABLE "user_follows" ADD COLUMN "notify_on_alert_create" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_follows" ADD COLUMN "notify_on_alert_fire" boolean DEFAULT false NOT NULL;
