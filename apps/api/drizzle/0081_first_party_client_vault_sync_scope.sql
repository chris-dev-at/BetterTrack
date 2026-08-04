-- #1043 — widen the existing BetterTrackMobile first-party OAuth client through
-- the deploy-time migration channel when vault:sync becomes grantable. Mirrors
-- the union-only code seed: preserve order and admin-added scopes, append the
-- scope only when missing, and never narrow or duplicate.
UPDATE "oauth_clients"
SET "scopes" = "scopes" || ARRAY['vault:sync']::text[]
WHERE "client_id" = 'btc_IbT1mzw_7kBiPHPkGfaE0Q'
  AND NOT ('vault:sync' = ANY("scopes"));
