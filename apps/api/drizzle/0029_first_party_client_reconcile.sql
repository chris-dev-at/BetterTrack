-- #398 follow-up — self-heal the first-party BetterTrackMobile OAuth client
-- (client_id btc_IbT1mzw_7kBiPHPkGfaE0Q) on EVERY environment via the one deploy
-- channel that self-executes on prod: a migration. Production was restored from an
-- outdated dump, so its oauth_clients row is missing the #349/#361 chat scopes and
-- mobile chat 403s. The #398 boot-seed (seedFirstPartyClients) fixes this on a
-- fresh install, but the prod auto-updater only ever runs migrate.js, never
-- seed.js — so nothing there triggers the seed. This migration mirrors the
-- canonical FIRST_PARTY_CLIENTS definition (apps/api/src/services/oauth/
-- firstPartyClients.ts) and converges the row the exact same way the seed does:
-- create-if-missing at the full scope ceiling, else widen WITHOUT narrowing.
--
-- Safe + idempotent by construction — a true no-op on the second run and on any
-- environment (dev/test/prod):
--   * MISSING row  -> INSERT the full canonical row once. Guarded by
--     WHERE NOT EXISTS on client_id, so it fires at most once per database. The
--     id is a one-time gen_random_uuid() (v4 rather than the app's v7 — fine for
--     a PK nothing time-orders on; see 0019), user_id NULL (system-owned, no
--     account), no secret (public/PKCE), is_first_party true, the canonical
--     redirect URI and the full 12-scope ceiling.
--   * EXISTING row -> converge additively, never narrowing. Scopes become
--     existing ∪ ceiling and redirect URIs become existing ∪ canonical, appending
--     only what is missing (preserving existing order and any admin-added extras),
--     exactly like the 0023/0027 scope-grant migrations. The correlated sub-select
--     + `NOT (col @> …)` guard means each UPDATE skips a row that already contains
--     everything, so a re-run changes nothing and never produces a duplicate.
--     client_id, secret, name and the public/first-party flags are never touched.
-- On a freshly-INSERTed row the two UPDATE guards are already satisfied, so they
-- no-op; on an old narrower row the INSERT's NOT EXISTS is false, so only the
-- UPDATEs run. The three statements compose into the seed's union-only semantics.
INSERT INTO "oauth_clients" (
  "id",
  "user_id",
  "client_id",
  "name",
  "client_secret_hash",
  "redirect_uris",
  "scopes",
  "is_public",
  "is_first_party",
  "logo_url"
)
SELECT
  gen_random_uuid(),
  NULL,
  'btc_IbT1mzw_7kBiPHPkGfaE0Q',
  'BetterTrackMobile',
  NULL,
  ARRAY['bettertrack://oauth/callback']::text[],
  ARRAY[
    'portfolio:read',
    'portfolio:write',
    'workboard:read',
    'workboard:write',
    'market:read',
    'social:read',
    'social:write',
    'notifications:read',
    'notifications:write',
    'chat:read',
    'chat:write',
    'account:security'
  ]::text[],
  true,
  true,
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM "oauth_clients" WHERE "client_id" = 'btc_IbT1mzw_7kBiPHPkGfaE0Q'
);--> statement-breakpoint
UPDATE "oauth_clients"
SET "scopes" = "scopes" || (
  SELECT COALESCE(array_agg(s), ARRAY[]::text[])
  FROM unnest(
    ARRAY[
      'portfolio:read',
      'portfolio:write',
      'workboard:read',
      'workboard:write',
      'market:read',
      'social:read',
      'social:write',
      'notifications:read',
      'notifications:write',
      'chat:read',
      'chat:write',
      'account:security'
    ]::text[]
  ) AS s
  WHERE NOT (s = ANY("scopes"))
)
WHERE "client_id" = 'btc_IbT1mzw_7kBiPHPkGfaE0Q'
  AND NOT (
    "scopes" @> ARRAY[
      'portfolio:read',
      'portfolio:write',
      'workboard:read',
      'workboard:write',
      'market:read',
      'social:read',
      'social:write',
      'notifications:read',
      'notifications:write',
      'chat:read',
      'chat:write',
      'account:security'
    ]::text[]
  );--> statement-breakpoint
UPDATE "oauth_clients"
SET "redirect_uris" = "redirect_uris" || (
  SELECT COALESCE(array_agg(u), ARRAY[]::text[])
  FROM unnest(
    ARRAY['bettertrack://oauth/callback']::text[]
  ) AS u
  WHERE NOT (u = ANY("redirect_uris"))
)
WHERE "client_id" = 'btc_IbT1mzw_7kBiPHPkGfaE0Q'
  AND NOT (
    "redirect_uris" @> ARRAY['bettertrack://oauth/callback']::text[]
  );
