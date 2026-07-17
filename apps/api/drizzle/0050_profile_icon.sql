-- V5-P0c arc — curated profile icons (#549). Strictly additive: one nullable
-- text column on `users` carrying the picked avatar id from the finite bundled
-- set. NULL = no choice; every render surface falls back to a deterministic
-- id-derived default, so existing rows render an avatar without a backfill.
-- The set of allowed ids lives in `packages/contracts` (PROFILE_ICON_IDS) and
-- is validated at the write path — no CHECK constraint here so adding a new
-- curated avatar is a code-only change.
ALTER TABLE "users" ADD COLUMN "profile_icon" text;
