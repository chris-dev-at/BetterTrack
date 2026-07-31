-- The Home widget board, per ACCOUNT rather than per browser profile (owner
-- request: "if i set this certain homescreen up and i login somewhere else …
-- i want the same home widget design"). Until now the whole layout lived in one
-- device-wide `localStorage` key, so a second browser started from the defaults
-- and two accounts on one browser shared a board.
--
-- Both columns are nullable with no backfill: NULL means "this account has never
-- saved a board", which is what the SPA's default layout already renders. An
-- existing user's local board is migrated up by the client on its next visit.
--
-- `home_layout` is opaque to the server. It is validated for SHAPE and SIZE only
-- (≤ 48 widgets, bounded ids/settings, ≤ 32 KB serialised) and never for its
-- widget vocabulary, so a client one deploy ahead stores widget types this build
-- cannot name and reads them back verbatim. jsonb (not text) so the cap is
-- enforced against parsed JSON and the column stays queryable if we ever need it.
ALTER TABLE "users" ADD COLUMN "home_layout" jsonb;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "home_layout_updated_at" timestamp with time zone;
