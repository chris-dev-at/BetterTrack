-- OAuth per-install TOKEN FAMILIES (RFC 9700 §4.14.2; §16 2026-10-29, Chief
-- ruling under the owner's indefinite-persistence directive).
--
-- One grant per (client, user) is shared by every install of an app, so until
-- now every revocation was grant-wide: a logout, a Settings revoke, a reinstall
-- or a forgot-PIN on ANY install signed out every other install, and refresh
-- reuse detection on one install's lost answer revoked everyone. A FAMILY is one
-- authorization_code exchange and every token rotated from it — in practice one
-- install. Reuse beyond the grace window, a bearer logout and RFC 7009
-- `POST /oauth/revoke` now revoke only the presenting family; the grant stays
-- the unit for Settings revoke, client deletion, suspension and the emptied
-- scope ceiling.
--
--   oauth_token_families — id, grant_id (ON DELETE cascade with the grant),
--     instance_id (optional client-chosen install id; a re-login with the same
--     id on the same grant retires that install's previous live family — the
--     partial unique index below holds at most ONE live family per instance),
--     created_at, last_used_at (stamped on rotation), revoked_at +
--     revoked_reason (both or neither; the reason vocabulary is closed).
--   oauth_refresh_tokens.family_id / oauth_access_tokens.family_id — nullable
--     FKs (ON DELETE cascade), each covered by an index.
--
-- NULLABLE FIRST, ON PURPOSE. infra/live/updater.sh runs this migration while
-- the OLD api container is still serving, and the old code inserts token rows
-- without a family. A NOT NULL here would 500 every `/oauth/token` for the
-- seconds-to-a-minute until the new container is up. The new code therefore
-- reads `family_id IS NULL` as "the legacy family IS the grant" — exactly the
-- old grant-wide semantics — so both versions coexist during the swap. A
-- follow-up migration tightens both columns to NOT NULL after one deploy cycle
-- (it first gives any grant still holding NULL-family tokens its own legacy
-- family; the SQL is in the PR body / follow-up issue).
--
-- BACKFILL: every existing grant — revoked ones included, the grant flag keeps
-- their tokens dead — gets ONE legacy family (created_at / last_used_at copied
-- from the grant, no instance_id), and every existing token is attached to its
-- own grant's family with one set-based UPDATE per table. So every install of a
-- legacy grant shares one family until it signs in again; each new sign-in
-- starts a family of its own. The DO block then proves the backfill: zero
-- tokens without a family and zero tokens attached to another grant's family,
-- else it RAISES and drizzle's per-migration transaction rolls everything back.
--
-- CONCURRENCY. The ADD COLUMNs take ACCESS EXCLUSIVE on both token tables and
-- hold it to commit, so no old-code insert can land between the attach and the
-- check. `lock_timeout` bounds how long the migration may queue for those locks
-- (behind, e.g., a nightly pg_dump's ACCESS SHARE) while every bearer read queues
-- behind IT: past 10 s it fails cleanly and the updater retries next tick. An
-- in-flight old-code token transaction can, in a millisecond window, deadlock
-- with these lock upgrades; Postgres aborts one side — a single `/oauth/token`
-- 500 (its refresh token is not consumed; the retry succeeds) or this migration
-- (rolled back whole; retried next tick). Both are self-healing.
--
-- RE-RUNNABLE: IF NOT EXISTS everywhere, FKs/CHECKs inline in CREATE TABLE and
-- ADD COLUMN IF NOT EXISTS so a re-run skips them, the family insert is guarded
-- by NOT EXISTS and the attach only touches NULL rows — a second run is a no-op.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_token_families" (
	"id" uuid PRIMARY KEY NOT NULL,
	"grant_id" uuid NOT NULL CONSTRAINT "oauth_token_families_grant_id_oauth_grants_id_fk" REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action,
	"instance_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "oauth_token_families_instance_id_shape" CHECK ("instance_id" IS NULL OR "instance_id" ~ '^[A-Za-z0-9._~-]{16,64}$'),
	CONSTRAINT "oauth_token_families_revoked_reason_known" CHECK ("revoked_reason" IS NULL OR "revoked_reason" IN ('refresh_reuse', 'logout', 'revoke_endpoint', 'relogin')),
	CONSTRAINT "oauth_token_families_revocation_complete" CHECK (("revoked_at" IS NULL) = ("revoked_reason" IS NULL))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_token_families_grant_id_idx" ON "oauth_token_families" USING btree ("grant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_token_families_live_instance_unique" ON "oauth_token_families" USING btree ("grant_id","instance_id") WHERE "instance_id" IS NOT NULL AND "revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN IF NOT EXISTS "family_id" uuid CONSTRAINT "oauth_refresh_tokens_family_id_oauth_token_families_id_fk" REFERENCES "public"."oauth_token_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD COLUMN IF NOT EXISTS "family_id" uuid CONSTRAINT "oauth_access_tokens_family_id_oauth_token_families_id_fk" REFERENCES "public"."oauth_token_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "oauth_token_families" ("id", "grant_id", "created_at", "last_used_at")
SELECT gen_random_uuid(), g."id", g."created_at", g."last_used_at"
FROM "oauth_grants" g
WHERE NOT EXISTS (
	SELECT 1 FROM "oauth_token_families" f WHERE f."grant_id" = g."id"
);--> statement-breakpoint
UPDATE "oauth_refresh_tokens" t
SET "family_id" = lf."id"
FROM (
	SELECT DISTINCT ON ("grant_id") "id", "grant_id"
	FROM "oauth_token_families"
	ORDER BY "grant_id", "created_at", "id"
) lf
WHERE t."family_id" IS NULL AND t."grant_id" = lf."grant_id";--> statement-breakpoint
UPDATE "oauth_access_tokens" t
SET "family_id" = lf."id"
FROM (
	SELECT DISTINCT ON ("grant_id") "id", "grant_id"
	FROM "oauth_token_families"
	ORDER BY "grant_id", "created_at", "id"
) lf
WHERE t."family_id" IS NULL AND t."grant_id" = lf."grant_id";--> statement-breakpoint
DO $$
DECLARE
	refresh_orphans bigint;
	access_orphans bigint;
	crossed bigint;
BEGIN
	SELECT count(*) INTO refresh_orphans FROM "oauth_refresh_tokens" WHERE "family_id" IS NULL;
	SELECT count(*) INTO access_orphans FROM "oauth_access_tokens" WHERE "family_id" IS NULL;
	SELECT count(*) INTO crossed FROM (
		SELECT 1
		FROM "oauth_refresh_tokens" t
		JOIN "oauth_token_families" f ON f."id" = t."family_id"
		WHERE f."grant_id" <> t."grant_id"
		UNION ALL
		SELECT 1
		FROM "oauth_access_tokens" t
		JOIN "oauth_token_families" f ON f."id" = t."family_id"
		WHERE f."grant_id" <> t."grant_id"
	) cross_grant;
	IF refresh_orphans > 0 OR access_orphans > 0 OR crossed > 0 THEN
		RAISE EXCEPTION '0119_oauth_token_families backfill incomplete: % refresh and % access tokens without a family, % tokens on another grant''s family',
			refresh_orphans, access_orphans, crossed;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_tokens_family_id_idx" ON "oauth_refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_tokens_family_id_idx" ON "oauth_access_tokens" USING btree ("family_id");
