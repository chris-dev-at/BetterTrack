-- #405 follow-up — reconcile the price-alerts scopes onto the first-party
-- BetterTrackMobile OAuth client (client_id btc_IbT1mzw_7kBiPHPkGfaE0Q) via the
-- one deploy channel that self-executes on prod: a migration. PR #423 appended
-- alerts:read / alerts:write to the canonical FIRST_PARTY_CLIENTS scope ceiling
-- (apps/api/src/services/oauth/firstPartyClients.ts) and relied on the boot-seed
-- (seedFirstPartyClients, union-only) to widen existing installs. But the prod
-- live updater is an older copy that runs migrate.js only, never seed.js — the
-- canonical infra/live/updater.sh runs both, but its re-copy onto the live box is
-- still pending — so the seed never fires there: prod's client kept the old
-- 12-scope list and an OAuth authorize requesting alerts scopes hard-rejects.
-- This mirrors the 0029 precedent — converge the row in SQL, the exact same
-- union-only way the seed would — but scoped to ONLY the two #405 alerts scopes.
-- 0029 already guarantees the row exists (create-if-missing at the pre-alerts
-- ceiling) before this runs, so this is a pure additive UPDATE, exactly like the
-- 0023/0027 scope-grant migrations.
--
-- Safe + idempotent by construction — a true no-op on the second run and on any
-- environment (dev/test/prod). The correlated sub-select appends only the alerts
-- scopes the row is still missing (preserving existing order and any admin-added
-- extras, never producing a duplicate), and the `NOT (scopes @> …)` guard skips a
-- row that already holds both — so a re-run changes nothing. Never narrows, never
-- touches any other scope, the redirect URIs, or any other column; and a missing
-- row simply matches zero rows and no-ops.
UPDATE "oauth_clients"
SET "scopes" = "scopes" || (
  SELECT COALESCE(array_agg(s), ARRAY[]::text[])
  FROM unnest(
    ARRAY[
      'alerts:read',
      'alerts:write'
    ]::text[]
  ) AS s
  WHERE NOT (s = ANY("scopes"))
)
WHERE "client_id" = 'btc_IbT1mzw_7kBiPHPkGfaE0Q'
  AND NOT (
    "scopes" @> ARRAY[
      'alerts:read',
      'alerts:write'
    ]::text[]
  );
