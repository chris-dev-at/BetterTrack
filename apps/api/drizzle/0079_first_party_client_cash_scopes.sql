-- #1041 — widen the existing BetterTrackMobile first-party OAuth client through
-- the deploy-time migration channel at the same time cash:read / cash:write
-- become grantable. Mirrors the union-only code seed: preserve order and any
-- admin-added scopes, append only missing cash scopes, never narrow or duplicate.
UPDATE "oauth_clients"
SET "scopes" = "scopes" || (
  SELECT COALESCE(array_agg(s), ARRAY[]::text[])
  FROM unnest(
    ARRAY[
      'cash:read',
      'cash:write'
    ]::text[]
  ) AS s
  WHERE NOT (s = ANY("scopes"))
)
WHERE "client_id" = 'btc_IbT1mzw_7kBiPHPkGfaE0Q'
  AND NOT (
    "scopes" @> ARRAY[
      'cash:read',
      'cash:write'
    ]::text[]
  );
