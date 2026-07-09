-- #349 follow-up — grant the first-party BetterTrackMobile OAuth client
-- (client_id btc_IbT1mzw_7kBiPHPkGfaE0Q) the #361 friend-chat scopes so mobile
-- OAuth can reach the friend-chat endpoints shipped in #349 that are gated on
-- them (chat:read to list conversations / read messages, chat:write to send).
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
--   * The WHERE guard skips the row once both scopes are already present, so
--     re-running the migration changes nothing.
--   * The correlated sub-select appends only the scopes that are missing,
--     preserving the existing order and never producing a duplicate.
UPDATE "oauth_clients"
SET "scopes" = "scopes" || (
  SELECT COALESCE(array_agg(s), ARRAY[]::text[])
  FROM unnest(
    ARRAY['chat:read', 'chat:write']::text[]
  ) AS s
  WHERE NOT (s = ANY("scopes"))
)
WHERE "client_id" = 'btc_IbT1mzw_7kBiPHPkGfaE0Q'
  AND NOT (
    "scopes" @> ARRAY['chat:read', 'chat:write']::text[]
  );
