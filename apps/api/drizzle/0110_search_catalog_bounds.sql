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
-- (2) A forward-stepping deletion watermark for the conditional search read.
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
-- read takes `greatest(newest visible, deleted_through)`. The trigger below
-- moves that stamp strictly past every instant the read could still be showing,
-- so the watermark does not merely stop decreasing — it advances by at least
-- one HTTP-date second on every deleting statement.
CREATE TABLE "asset_catalog_deletions" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"deleted_through" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- The UUIDv7 leading 48 bits are the row's creation ms (§4.4) — the very
-- quantity the read side decodes for the other half of the `greatest`, so
-- deriving the stamp from row ids keeps BOTH terms on one clock and no
-- server-clock skew (an API host running ahead of the database host) can enter
-- the comparison. `now()` is deliberately never read here.
CREATE FUNCTION "bettertrack_uuidv7_instant"(asset_id uuid)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE STRICT
AS $$
	SELECT to_timestamp(
		(('x' || substr(replace(asset_id::text, '-', ''), 1, 12))::bit(48)::bigint) / 1000.0
	)
$$;
--> statement-breakpoint
-- The stamp must STEP FORWARD on every deletion, not merely never rewind.
-- Monotonicity alone leaves the original false 304 fully reachable:
--
--   * stamp already ahead. Delete a NEWER asset first (anyone's — the stamp is
--     instance-wide), then the newest one still visible: the second deletion's
--     own instant is below the stamp, so a `greatest(stamp, row)` write is a
--     no-op, the watermark does not move, and the client's `If-Modified-Since`
--     from before that deletion is still satisfied.
--   * a NON-newest row. `greatest(newest visible, stamp)` is unchanged by
--     deleting anything below the maximum, so the response shrinks while the
--     watermark stands still.
--
-- Both close the same way: take the largest instant the read side could
-- possibly be looking at — the newest row this statement deleted AND the newest
-- row left in the table, which dominates every caller's visible maximum — and
-- put the stamp one HTTP-second past it. `date_trunc('second', …) + 1s` is that
-- resolution: `Last-Modified` / `If-Modified-Since` are second-granular, so
-- pushing past the millisecond is not enough, the NEXT second has to be
-- reached. The `ON CONFLICT` arm re-applies the step to the stored value, so a
-- deletion whose own row is older than the current stamp still advances it.
--
-- Consequence, deliberate: N successive delete statements with no intervening
-- insert leave the stamp N seconds ahead of the newest row, during which a
-- newly created asset does not raise the watermark. That is bounded by the
-- number of content-changing statements and is the same second-granularity
-- limit RFC 9110 date validators have anyway (which is why the read also emits
-- an ETag); the alternative — a stamp that sometimes does not move — is the
-- unbounded staleness above.
--
-- Statement-level with a transition table, so an account-deletion cascade or a
-- paranoid purge stamps ONCE for the whole DELETE instead of once per row: it
-- takes the shared row's lock a single time per statement (concurrent deletes
-- on "assets" serialise on it until commit) and not at all for a statement that
-- deleted nothing. The table carries no user or asset column — a timestamp and
-- nothing else, identifying neither account nor asset — and no delete path can
-- bypass it: the owner-scoped custom-asset delete, the paranoid detach function
-- and the account-deletion cascade all issue a DELETE on "assets".
CREATE FUNCTION "bettertrack_asset_catalog_deletion_mark"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	deleted_newest timestamptz;
	remaining_newest timestamptz;
BEGIN
	SELECT max("bettertrack_uuidv7_instant"("id"))
		INTO deleted_newest
		FROM "bettertrack_deleted_assets";
	-- An AFTER STATEMENT trigger also fires for a DELETE that matched no row.
	IF deleted_newest IS NULL THEN
		RETURN NULL;
	END IF;

	-- uuid order == time order, so this is an index scan on the primary key, not
	-- an aggregate over the table. NULL (catalog now empty) drops out of
	-- `greatest`, which ignores NULL arguments.
	SELECT "bettertrack_uuidv7_instant"("id")
		INTO remaining_newest
		FROM "assets"
		ORDER BY "id" DESC
		LIMIT 1;

	INSERT INTO "asset_catalog_deletions" ("singleton", "deleted_through")
	VALUES (
		true,
		date_trunc('second', greatest(deleted_newest, remaining_newest)) + interval '1 second'
	)
	ON CONFLICT ("singleton") DO UPDATE
		SET "deleted_through" = date_trunc(
			'second',
			greatest("asset_catalog_deletions"."deleted_through", EXCLUDED."deleted_through")
		) + interval '1 second';
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "assets_catalog_deletion_mark"
AFTER DELETE ON "assets"
REFERENCING OLD TABLE AS "bettertrack_deleted_assets"
FOR EACH STATEMENT
EXECUTE FUNCTION "bettertrack_asset_catalog_deletion_mark"();
