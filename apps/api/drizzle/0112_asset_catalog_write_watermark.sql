-- V5-P1, #1762 — the catalog freshness watermark must step forward on EVERY
-- statement that changes what `GET /search` returns, not only on DELETE.
--
-- 0110 gave the watermark a forward-stepping stamp for deletions. Two classes
-- of write were left uncovered, and both produce a stale `304 Not Modified` on
-- the `If-Modified-Since` rail — the rail used by exactly the callers that do
-- not send an ETag (bare API-key/CLI clients, intermediaries that strip them):
--
--   * UPDATE. `assets` carries no per-row timestamp, so the read side's other
--     term — `max(id)` decoded as the UUIDv7 creation instant — cannot see a
--     content edit at all. Renaming a custom asset ("ACME Immobilien" →
--     "Zeta Immobilien") changes what search returns AND how it ranks
--     (`assetRepository.searchCatalog` matches and orders on `name`), while the
--     watermark stands perfectly still. Nothing repairs it: the old name is
--     served under a 304 until some unrelated instance-wide insert or delete
--     happens to move the watermark.
--   * INSERT inside the current second. `Last-Modified` / `If-Modified-Since`
--     are second-granular, so a row created at 12:00:03.800 does not lift a
--     watermark that already reads 12:00:03.100 above the client's stored
--     `12:00:03` — the §6.2 "Searching providers…" refetch loop revalidates and
--     is told 304, so its stored validator never advances and the enriched row
--     stays invisible. This is precisely the second-boundary problem the delete
--     trigger compensates for with `date_trunc('second', …) + 1s`; the insert
--     side never got the same compensation.
--
-- The fix is to stop treating the stamp as a deletion detail: it is the
-- catalog's write watermark, and every content-changing statement — insert,
-- update, delete — steps it at least one whole HTTP-date second past the newest
-- row anyone can still see. The read side then compares exactly (no flooring,
-- see `http/middleware/conditional.ts`), because the value it advertises is
-- already a whole second.
--
-- (1) The table and column are renamed to say what they now record. Same single
-- row, same singleton primary key, same instance-wide semantics; only deletions
-- were ever stamped before, so no stored value changes meaning.
ALTER TABLE "asset_catalog_deletions" RENAME TO "asset_catalog_watermark";--> statement-breakpoint
ALTER TABLE "asset_catalog_watermark" RENAME COLUMN "deleted_through" TO "mutated_through";--> statement-breakpoint
-- (2) One stamping function for all three events. plpgsql resolves a statement
-- the first time its branch executes, so the DELETE branch's reference to the
-- OLD transition table is never parsed under an INSERT/UPDATE trigger and vice
-- versa. Three triggers rather than one: PostgreSQL refuses transition tables on
-- a trigger declared for more than one event.
DROP TRIGGER IF EXISTS "assets_catalog_deletion_mark" ON "assets";--> statement-breakpoint
DROP FUNCTION IF EXISTS "bettertrack_asset_catalog_deletion_mark"();--> statement-breakpoint
CREATE FUNCTION "bettertrack_asset_catalog_mark"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	touched_newest timestamptz;
	table_newest timestamptz;
BEGIN
	IF TG_OP = 'DELETE' THEN
		SELECT max("bettertrack_uuidv7_instant"("id"))
			INTO touched_newest
			FROM "bettertrack_catalog_old_rows";
	ELSE
		SELECT max("bettertrack_uuidv7_instant"("id"))
			INTO touched_newest
			FROM "bettertrack_catalog_new_rows";
	END IF;
	-- An AFTER STATEMENT trigger also fires for a statement that matched no row
	-- (a no-op UPDATE, an `ON CONFLICT DO NOTHING` upsert that inserted nothing).
	IF touched_newest IS NULL THEN
		RETURN NULL;
	END IF;

	-- uuid order == time order, so this is an index scan on the primary key, not
	-- an aggregate over the table. NULL (catalog now empty, only reachable under
	-- DELETE) drops out of `greatest`, which ignores NULL arguments.
	SELECT "bettertrack_uuidv7_instant"("id")
		INTO table_newest
		FROM "assets"
		ORDER BY "id" DESC
		LIMIT 1;

	-- The stamp must land strictly above every instant the read side could still
	-- be looking at, which is `greatest(newest visible to that caller, stamp)`.
	-- The newest row LEFT IN THE TABLE dominates every caller's visible maximum,
	-- and the newest row this statement touched covers the row a DELETE just
	-- removed. One HTTP-date second past that maximum is the resolution that
	-- matters: pushing past the millisecond would still land inside the second
	-- the client has stored.
	--
	-- The conflict arm also steps past the STORED value, so a statement whose own
	-- rows are older than the current stamp — renaming an asset created last
	-- year, deleting a row below the visible maximum — still advances it. Unlike
	-- 0110's arm it steps by exactly one second rather than truncating the
	-- greatest and adding one on top; the guarantee ("strictly greater than both
	-- the stored stamp and the touched maximum, on a whole-second boundary") is
	-- the same, with less drift when statements arrive in bursts.
	INSERT INTO "asset_catalog_watermark" ("singleton", "mutated_through")
	VALUES (
		true,
		date_trunc('second', greatest(touched_newest, table_newest)) + interval '1 second'
	)
	ON CONFLICT ("singleton") DO UPDATE
		SET "mutated_through" = greatest(
			"asset_catalog_watermark"."mutated_through" + interval '1 second',
			EXCLUDED."mutated_through"
		);
	RETURN NULL;
END;
$$;--> statement-breakpoint
-- Statement-level with a transition table, so a bulk catalog seed, an
-- account-deletion cascade or a paranoid purge stamps ONCE for the whole
-- statement instead of once per row: one shared row updated per content-changing
-- STATEMENT (concurrent writers on "assets" serialise on it until commit), and
-- not at all for a statement that touched nothing. The table still carries no
-- user and no asset column — a timestamp and nothing else — and no write path
-- can bypass it, which is why this lives in the database and not in a
-- repository: the custom-asset PATCH, the re-categorize sweep, the paranoid
-- detach function, the provider-fallback upserts and the account cascade all
-- reach `assets` through plain DML.
--
-- Deliberate consequence, unchanged from 0110: N content-changing statements
-- inside one second leave the stamp up to N seconds ahead of the newest row. It
-- decays as soon as writes arrive slower than one per second (the next
-- statement's own instant overtakes the stamp) and it is always the safe
-- direction — a 200 instead of a 304 — so correctness never depends on it.
CREATE TRIGGER "assets_catalog_insert_mark"
AFTER INSERT ON "assets"
REFERENCING NEW TABLE AS "bettertrack_catalog_new_rows"
FOR EACH STATEMENT
EXECUTE FUNCTION "bettertrack_asset_catalog_mark"();--> statement-breakpoint
-- Deliberately column-agnostic: ANY update stamps. A `WHEN` clause listing
-- today's search projection (symbol, name, exchange, currency, type, provider
-- id/ref, owner) would silently stop covering the projection the day a column is
-- added to it, and the cost of over-stamping is a 200 instead of a 304.
CREATE TRIGGER "assets_catalog_update_mark"
AFTER UPDATE ON "assets"
REFERENCING NEW TABLE AS "bettertrack_catalog_new_rows"
FOR EACH STATEMENT
EXECUTE FUNCTION "bettertrack_asset_catalog_mark"();--> statement-breakpoint
CREATE TRIGGER "assets_catalog_delete_mark"
AFTER DELETE ON "assets"
REFERENCING OLD TABLE AS "bettertrack_catalog_old_rows"
FOR EACH STATEMENT
EXECUTE FUNCTION "bettertrack_asset_catalog_mark"();
