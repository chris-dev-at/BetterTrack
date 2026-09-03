-- V5-P1, #1709 — two search-keystone corrections (§6.2).
--
-- (1) Retire the dead trigram index. `assets_symbol_name_trgm_gin` shipped in
-- 0003 with the comment "so misspellings ('bayr') still resolve". That was
-- never true: `gin_trgm_ops` answers only `%`, `<%` and `<->`, and those
-- operators appear nowhere in the codebase. The catalog's fuzzy tier is a plain
-- `similarity(symbol|name, $q) >= 0.3` function call, which no GIN opclass can
-- serve, and it sits in an OR with `upper(symbol) LIKE …`, which is index-
-- unusable as well — so `GET /search` scanned and filtered every visible row
-- with the index present, exactly as it does without it (verified with EXPLAIN
-- over the 642-row seed catalog: the plan reaches the rows through
-- `assets_owner_id_idx` and never mentions the trigram index). What the index
-- did cost was real: a GIN write on every row the provider-fallback enrichment
-- upserts, on the hot catalog-growth path.
--
-- The pg_trgm EXTENSION stays (0003 creates it); `similarity()` is what makes
-- §6.2's misspelling tier work, and it is unaffected. If the catalog ever grows
-- orders of magnitude past self-hosted scale, the fix is a two-pass read
-- (indexed tiers first, fuzzy only on a miss) or a `%` predicate with a pinned
-- `pg_trgm.similarity_threshold` — not this index.
DROP INDEX IF EXISTS "assets_symbol_name_trgm_gin";--> statement-breakpoint
-- (2) A monotonic deletion watermark for the conditional search read.
--
-- `catalogWatermark` derives `Last-Modified` from the newest visible asset's
-- UUIDv7 creation time (the table has no per-row timestamp). Deleting the
-- newest visible row moves that value BACKWARDS, so a follow-up request
-- carrying `If-Modified-Since: <the watermark from before the delete>` is
-- satisfied by the smaller value and answers `304 Not Modified` — the client
-- keeps rendering an asset that no longer exists. Reachable from any caller
-- that sends only the date validator (bare API-key/CLI clients, or an
-- intermediary that strips ETags).
--
-- One row records the instant through which deletions are accounted for; the
-- read takes `greatest(newest visible, deleted_through)`, which cannot decrease.
CREATE TABLE "asset_catalog_deletions" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"deleted_through" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- The stamp is derived from the DELETED ROW'S OWN id, not from a server clock:
-- the UUIDv7 leading 48 bits are its creation ms (§4.4), which is the very
-- quantity the read side decodes for the other half of the `greatest`. Both
-- terms therefore come from one clock, so the comparison cannot be skewed by an
-- API host running ahead of the database host.
--
-- The one-second offset is the HTTP-date resolution: `If-Modified-Since` and
-- `Last-Modified` are second-granular, so a row created and deleted inside the
-- same second still has to push the watermark into the NEXT second, or the
-- floored comparison would keep answering 304.
--
-- Deliberately a row-level trigger with no user or asset column: the table
-- stores a timestamp and nothing else, so it identifies neither the account nor
-- the asset, and no delete path can bypass it — the owner-scoped custom-asset
-- delete, the paranoid detach function and the account-deletion cascade all
-- issue a DELETE on "assets".
CREATE FUNCTION "bettertrack_asset_catalog_deletion_mark"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	deleted_through timestamptz;
BEGIN
	deleted_through := to_timestamp(
		(('x' || substr(replace(OLD."id"::text, '-', ''), 1, 12))::bit(48)::bigint) / 1000.0
	) + interval '1 second';

	INSERT INTO "asset_catalog_deletions" ("singleton", "deleted_through")
	VALUES (true, deleted_through)
	ON CONFLICT ("singleton") DO UPDATE
		SET "deleted_through" = EXCLUDED."deleted_through"
		WHERE "asset_catalog_deletions"."deleted_through" < EXCLUDED."deleted_through";
	RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "assets_catalog_deletion_mark"
AFTER DELETE ON "assets"
FOR EACH ROW
EXECUTE FUNCTION "bettertrack_asset_catalog_deletion_mark"();
