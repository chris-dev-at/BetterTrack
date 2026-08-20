-- #1393 — the official apps are BetterTrack product surfaces, so their active
-- grants track the code-owned first-party client ceiling. Both feedback
-- migrations widened only the BetterTrackMobile CLIENT row and never the GRANT
-- rows minted before them (0088 for feedback:write, 0090 for #1338's
-- feedback:read), which is the whole root cause of the mobile 403s: prod's
-- auto-updater runs migrate.js but never seed.js, so the boot-time reconcile
-- that unions the ceiling into active grants never fires there. Heal grants
-- issued before those deploys without requiring users to sign in or consent
-- again.
--
-- Resolve the target through the stable public client_id shipped by the app,
-- never an environment-specific internal UUID. Union-only and guarded for an
-- idempotent replay. Revoked grants are historical authorization records and
-- remain byte-for-byte unchanged. No third-party client can cross both the
-- stable-id and first-party predicates.
--
-- Appending only the MISSING scopes (rather than a blanket concat) keeps a grant
-- that already carries one of the two from gaining a duplicate, and `WITH
-- ORDINALITY` pins the appended order to the ceiling's own order so the healed
-- row matches what the runtime reconcile would have written.
UPDATE "oauth_grants" AS "grant"
SET "scopes" = "grant"."scopes" || ARRAY(
		SELECT "want"."scope"
		FROM unnest(ARRAY['feedback:write', 'feedback:read']::text[])
			WITH ORDINALITY AS "want"("scope", "ord")
		WHERE NOT ("want"."scope" = ANY("grant"."scopes"))
		ORDER BY "want"."ord"
	)
FROM "oauth_clients" AS "client"
WHERE "grant"."client_id" = "client"."id"
	AND "client"."client_id" = 'btc_IbT1mzw_7kBiPHPkGfaE0Q'
	AND "client"."is_first_party" = true
	AND "grant"."revoked_at" IS NULL
	AND NOT ("grant"."scopes" @> ARRAY['feedback:write', 'feedback:read']::text[]);
