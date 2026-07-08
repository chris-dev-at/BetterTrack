-- #341 Part 2 — grant the first-party BetterTrackMobile OAuth client
-- (client_id btc_IbT1mzw_7kBiPHPkGfaE0Q) the #361 platform scopes so mobile
-- OAuth can reach the account-security / notifications / social-write endpoints
-- that are gated on them (/auth/pin/*, /notifications, /settings/notifications,
-- /auth/change-password, /auth/2fa/*, /auth/sessions*, and /social writes).
--
-- This adds ONLY to the client's ALLOWED-scope ceiling — never to any existing
-- user grant or token. Force-adding scopes to a live grant would silently widen
-- consent; instead the mobile app re-consents to receive a token that carries
-- them. The effective scope of any live token stays the intersection of what the
-- user consented to and this ceiling (enforced at the token/resource layer).
--
-- Safe + idempotent by design:
--   * Scoped by client_id, so it is a NO-OP on a fresh database where the client
--     does not exist yet (CI, local, and before the mobile client is created).
--   * The WHERE guard skips the row once all four scopes are already present, so
--     re-running the migration changes nothing.
--   * The correlated sub-select appends only the scopes that are missing,
--     preserving the existing order and never producing a duplicate.
UPDATE "oauth_clients"
SET "scopes" = "scopes" || (
  SELECT COALESCE(array_agg(s), ARRAY[]::text[])
  FROM unnest(
    ARRAY['account:security', 'notifications:read', 'notifications:write', 'social:write']::text[]
  ) AS s
  WHERE NOT (s = ANY("scopes"))
)
WHERE "client_id" = 'btc_IbT1mzw_7kBiPHPkGfaE0Q'
  AND NOT (
    "scopes" @> ARRAY['account:security', 'notifications:read', 'notifications:write', 'social:write']::text[]
  );
