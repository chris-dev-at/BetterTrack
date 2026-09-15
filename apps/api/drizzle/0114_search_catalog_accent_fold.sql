-- V5-P1, #1876 — make the local catalog findable without diacritics, and
-- retire the tsvector GIN the read can never scan (§6.2).
--
-- (1) The fold. Every tier of `assetRepository.searchCatalog` compared raw
-- characters: `upper(symbol) = upper($q)`, `name ILIKE '%…%'`,
-- `to_tsvector('simple', …)` and `similarity()` are all accent-SENSITIVE, so
-- the ASCII spelling of a shipped DE/AT row returned nothing at all —
-- `Estee Lauder` missed `EL`, `Borse`/`Boerse` missed `DB1.DE`, and `Ruck`
-- returned `DTG.DE` ("Daimler TRUCK") while "Hannover Rück SE" and
-- "Münchener Rück AG" sat in the catalog unreachable. Each of those misses then
-- read as a thin catalog and spent a per-user enrichment slot fanning out to
-- providers for rows Postgres already held.
--
-- `unaccent` is not an option: it is a dictionary extension, its `unaccent()`
-- wrapper is only STABLE (so no generated column and no expression index may
-- call it), and it is not among the contrib modules the PGlite the test suite
-- runs on can load. These three SQL-language functions do the job with
-- `lower()`, `replace()` and `translate()` alone — IMMUTABLE by construction,
-- inlinable by the planner, and reproducible character-for-character by the JS
-- mirror the provider fallback ranks its hits with
-- (`services/search/catalogEnrichment.ts`; held to these by
-- `services/search/__tests__/rankParity.test.ts`).
--
-- FOLD is the ASCII spelling: lowercase, then every Latin-1/Latin-Extended-A
-- letter to its base letter (ö→o, é→e, ł→l), with the four ligature-ish ones
-- that need two characters done first (ß→ss, æ→ae, œ→oe, þ→th).
CREATE FUNCTION "bettertrack_search_fold"(t text)
RETURNS text
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
AS $$
	SELECT translate(
		replace(replace(replace(replace(lower(t), 'ß', 'ss'), 'æ', 'ae'), 'œ', 'oe'), 'þ', 'th'),
		'àáâãäåāăąçćĉċčďđðèéêëēĕėęěĝğġģĥħìíîïĩīĭįıĵķĺļľłñńņňòóôõöøōŏőŕŗřśŝşšţťŧùúûüũūŭůűųŵýÿŷźżž',
		'aaaaaaaaacccccdddeeeeeeeeegggghhiiiiiiiiijkllllnnnnooooooooorrrsssstttuuuuuuuuuuwyyyzzz'
	)
$$;--> statement-breakpoint
-- TRANSLIT is the German spelling of the same row: ä→ae, ö→oe, ü→ue (ß→ss the
-- fold already does), then folded. It exists because ONE normalised form cannot
-- serve both spellings a German name is searched by — `Borse` needs ö→o and
-- `Boerse` needs ö→oe — and folding the QUERY both ways instead would make a
-- query of `OE` an exact-symbol hit on `O`. The row carries both spellings; the
-- query is only ever folded.
CREATE FUNCTION "bettertrack_search_translit"(t text)
RETURNS text
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
AS $$
	SELECT "bettertrack_search_fold"(
		replace(replace(replace(lower(t), 'ä', 'ae'), 'ö', 'oe'), 'ü', 'ue')
	)
$$;--> statement-breakpoint
-- DOCUMENT is what the tsvector is built over: the fold, plus the transliteration
-- when it differs. The `CASE` is not an optimisation — it is what keeps a row
-- without umlauts byte-identical to the tsvector it had before this migration
-- (`to_tsvector('simple', …)` lowercases on its own), so nothing that carries a
-- stored `search_text` across a paranoid round trip (§13) has to be re-derived.
CREATE FUNCTION "bettertrack_search_document"(t text)
RETURNS text
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
AS $$
	SELECT CASE
		WHEN "bettertrack_search_translit"(t) = "bettertrack_search_fold"(t)
			THEN "bettertrack_search_fold"(t)
		ELSE "bettertrack_search_fold"(t) || ' ' || "bettertrack_search_translit"(t)
	END
$$;--> statement-breakpoint
-- (2) Retire `assets_search_text_gin`, for the reason 0110 retired the trigram
-- GIN beside it: the read cannot scan it. `search_text` appears in exactly one
-- place in the whole codebase — inside the `CASE` in the target list of
-- `searchCatalog`'s fenced subquery — never in a filter, and the `offset 0`
-- fence exists precisely so the planner cannot pull that `CASE` up into one.
-- An index that answers no predicate still costs a GIN write on every row the
-- catalog seed (600+ at boot) and the provider-fallback enrichment upsert, on
-- the hot catalog-growth path. If the catalog ever outgrows self-hosted scale
-- the answer is the two-pass read 0110 already names — index-servable tiers
-- first, fuzzy only on a miss — not this index.
DROP INDEX IF EXISTS "assets_search_text_gin";--> statement-breakpoint
-- A generated column's expression cannot be ALTERed; it is dropped and re-added.
ALTER TABLE "assets" DROP COLUMN "search_text";--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "search_text" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', "bettertrack_search_document"("assets"."symbol" || ' ' || "assets"."name"))) STORED;
