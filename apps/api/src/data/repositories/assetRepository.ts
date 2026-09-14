import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { AnyColumn, SQL } from 'drizzle-orm';

import type { Database } from '../db';
import { assetCatalogWatermark, assets, priceHistory } from '../schema';
import type { AssetRow } from '../schema';

/**
 * Asset persistence for the market-data read API (PROJECTPLAN.md §6.2, §6.3).
 *
 * Two access rules are enforced here, in the repository, not the controller
 * (§10 — "no IDOR by construction"):
 *  - a **global market asset** (`owner_id IS NULL`) is readable by every user;
 *  - a **custom asset** (`owner_id = user`) is readable only by its owner.
 */

/**
 * Trigram floor for the fuzzy tier (§6.2): pg_trgm's default cutoff. Below it a
 * match is noise ("bay" vs "Deutsche Telekom"), at/above it a near-miss like
 * "bayr" → BAYN.DE still resolves.
 */
export const FUZZY_SIMILARITY_THRESHOLD = 0.3;

/**
 * Milliseconds encoded in a UUIDv7's leading 48 bits — the row's creation time.
 * (UUIDv7 layout: `unix_ts_ms(48) | ver | rand`, big-endian, §4.4.)
 */
function uuidV7Millis(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

/**
 * The caller's visible slice of the catalog (§10): every global market asset,
 * plus their own custom assets unless the privacy lock excludes them.
 */
function visibleTo(userId: string, includeCustomAssets: boolean): SQL {
  return includeCustomAssets
    ? sql`(${assets.ownerId} is null or ${assets.ownerId} = cast(${userId} as uuid))`
    : sql`${assets.ownerId} is null`;
}

/**
 * Rows of a raw `db.execute`: postgres-js returns its RowList directly, PGlite
 * wraps it in `rows`. Both shapes are recognised explicitly, and a third one
 * throws rather than degrading to `[]` — an empty array is a valid answer for
 * both readers below ("no catalog match", "no watermark"), so a blind cast
 * would turn an unsupported driver into a wrong answer served with a 200.
 */
function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows: unknown = (result as { rows?: unknown } | null)?.rows;
  if (Array.isArray(rows)) return rows as T[];
  throw new Error('Unsupported database driver result shape for a raw catalog read');
}

/** One ranked hit from the local catalog (§6.2): a global market asset or the caller's own custom asset. */
export interface CatalogSearchMatch {
  id: string;
  providerId: string;
  providerRef: string;
  symbol: string;
  name: string;
  exchange: string | null;
  currency: string;
  type: AssetRow['type'];
  /** NULL = global market asset; the caller's id = their custom asset. */
  ownerId: string | null;
}

/**
 * One page of the ranked catalog read (§6.2): the display window, plus the size
 * of the market slice it was cut from.
 *
 * The two are separate answers to separate questions and MUST NOT be conflated
 * (#1794). `matches` is what the user sees — at most `limit` rows, market rows
 * and the caller's own custom rows competing in one ranking, exactly as §6.2
 * requires. `marketMatchTotal` is what the provider-fallback threshold is
 * measured against: counting market rows *inside the window* answers "how many
 * market rows fit next to this caller's custom rows", which twenty custom
 * assets can drive to zero against a catalog that holds the answer.
 */
export interface CatalogSearchPage {
  /** The ranked display window — at most `limit` rows (§6.2). */
  matches: CatalogSearchMatch[];
  /**
   * How many MARKET rows (`owner_id IS NULL`) qualified across the whole
   * visible catalog, counted BEFORE the limit. Custom rows are excluded — a
   * provider can never enrich one, so they can neither prove nor disprove a
   * catalog miss.
   */
  marketMatchTotal: number;
}

/** The shape a first-touch upsert needs from a provider search result (§6.2). */
export interface GlobalAssetUpsert {
  providerId: string;
  providerRef: string;
  type: AssetRow['type'];
  symbol: string;
  name: string;
  exchange: string | null;
  currency: string;
}

/** Result of {@link AssetRepository.upsertGlobal}: the row plus what this call did to it. */
export interface UpsertGlobalResult {
  row: AssetRow;
  /** True only when this call inserted the row — the first touch (§6.2). */
  created: boolean;
  /**
   * True when the row already existed and this call CORRECTED at least one of
   * its provider-owned descriptive columns (#1810). Always false on a create,
   * false when the caller asked for no refresh, and false when the incoming
   * values matched what was stored — the unchanged re-seed / re-enrichment
   * writes nothing at all.
   */
  refreshed: boolean;
}

/**
 * The descriptive columns an existing global row's refresh may correct, in the
 * order the UPDATE writes them. `id`, `owner_id` and `meta` are deliberately
 * absent: a correction is an in-place edit of what a source describes, never a
 * re-identify (every transaction, holding and watchlist row points at `id`).
 */
export const REFRESHABLE_ASSET_FIELDS = ['type', 'symbol', 'name', 'exchange', 'currency'] as const;

export type RefreshableAssetField = (typeof REFRESHABLE_ASSET_FIELDS)[number];

/**
 * Which of {@link REFRESHABLE_ASSET_FIELDS} THIS caller is allowed to correct.
 *
 * The set is per caller and not a property of the table (#1810 review), because
 * the two writers know different things. The shipped seed list is curated: it
 * carries a hand-checked type, exchange and native currency per row, so it may
 * refresh everything. A provider *search* hit is a projection built to fill a
 * picker: `yahooProvider.search` has no currency field to read at all, so
 * `currencyForSearchResult` derives one from the symbol shape and otherwise
 * defaults to `'USD'`, and `mapAssetType` falls back to `'stock'` for an unknown
 * quote type — documented as safe precisely because "an imperfect guess here
 * only affects the picker badge, never a stored amount" (`yahooMapping.ts`).
 * That contract held only while an existing row was write-once. So the
 * enrichment passes the narrow set (`services/search/catalogEnrichment.ts`):
 * `currency` is money — `portfolioService` converts persisted cash movements
 * through it, and tax, snapshots, import validation and paranoid rehydration
 * all read the same column — so the projection's own currency is never written
 * over a stored one.
 *
 * It is nonetheless refreshABLE, because a wrong denomination has to be
 * fixable (#1875): the enrichment names `currency` exactly when the value it
 * passes was re-read from the authoritative `getMeta` + `normalizeCurrency`
 * path — which it now genuinely calls for a hit the provider flagged as
 * defaulted, rather than leaving the correction to a caller that never existed.
 *
 * Omitting the option entirely keeps the pre-#1810 behaviour: insert or nothing.
 */
export interface UpsertGlobalOptions {
  refresh?: readonly RefreshableAssetField[];
}

/** The `SET` payload of a refresh: a subset of the descriptive columns. */
type AssetRefreshValues = Partial<Pick<typeof assets.$inferInsert, RefreshableAssetField>>;

/**
 * The catalog read's ranking TIER for one row (§6.2), as SQL: exact symbol (0)
 * → symbol prefix (1) → name substring **or** simple-config word match (2) →
 * everything else (3).
 *
 * Every arm compares ACCENT-FOLDED text (#1876): the query is folded once, and
 * each row arm is tried against both the row's fold and its German
 * transliteration — see {@link fold} / {@link translit} for why the row carries
 * two spellings and the query only one.
 *
 * Exported because {@link searchCatalog} is not its only consumer: the provider
 * fallback ranks a provider's hits by these same tiers before capping how many
 * it may write (`services/search/catalogEnrichment.ts` — a JS mirror, since
 * those hits are not rows yet). The two ranking rules drifted apart once
 * already (#1810: the mirror had only the ILIKE half of tier 2 and no
 * similarity ordering, so the cap shed exactly the hits the follow-up read
 * ranks highest), and a mirror can only be held to an expression it can be
 * tested against. `__tests__/rankParity.test.ts` runs this builder over a
 * fixture set and asserts the JS ranker agrees.
 */
export function catalogTierSql(query: string): SQL {
  const needle = fold(query);
  const prefix = fold(`${escapeLike(query)}%`);
  const substring = fold(`%${escapeLike(query)}%`);
  return sql`case
    when ${fold(assets.symbol)} = ${needle} or ${translit(assets.symbol)} = ${needle} then 0
    when ${fold(assets.symbol)} like ${prefix} or ${translit(assets.symbol)} like ${prefix} then 1
    when ${fold(assets.name)} like ${substring} or ${translit(assets.name)} like ${substring}
      or ${assets.searchText} @@ plainto_tsquery('simple', ${needle}) then 2
    else 3
  end`;
}

/**
 * The catalog read's trigram score for one row (§6.2): the best of the folded
 * symbol and name similarities, which orders every tier and gates the fuzzy one
 * at {@link FUZZY_SIMILARITY_THRESHOLD}. Exported for the same reason as
 * {@link catalogTierSql}.
 *
 * Four `similarity()` calls where there used to be two, for the same reason the
 * tiers grew a second arm each: a row is scored on its BEST spelling. For the
 * ASCII majority `translit(x) = fold(x)`, so the extra pair scores identically
 * and only costs CPU on a scan whose bound is stated in {@link searchCatalog};
 * for "Münchener Rück AG" it is what lets `Muenchener` outrank a stray trigram
 * neighbour instead of merely qualifying.
 */
export function catalogSimilaritySql(query: string): SQL {
  const needle = fold(query);
  return sql`greatest(
    similarity(${fold(assets.symbol)}, ${needle}),
    similarity(${translit(assets.symbol)}, ${needle}),
    similarity(${fold(assets.name)}, ${needle}),
    similarity(${translit(assets.name)}, ${needle})
  )`;
}

/**
 * The ASCII spelling of `value` (#1876, migration 0114): lowercased, with every
 * Latin-1/Latin-Extended-A letter folded to its base letter. Applied to BOTH
 * sides of every comparison above, which is what makes the whole read
 * accent-insensitive — `upper()`, `ILIKE`, `to_tsvector('simple', …)` and
 * `similarity()` are every one of them accent-SENSITIVE, so before this the
 * ASCII spelling of a shipped DE/AT row matched nothing at all.
 *
 * A LIKE pattern may be folded whole: the fold touches no `%`, `_` or `\`, so
 * `fold(escapeLike(q) || '%')` is `fold(escapeLike(q)) || '%'`.
 */
function fold(value: SQL | AnyColumn | string): SQL {
  return sql`"bettertrack_search_fold"(${value})`;
}

/**
 * The German spelling of the same value: ä→ae, ö→oe, ü→ue, ß→ss, then folded.
 *
 * The row carries both spellings and the QUERY is only ever folded, because one
 * normalised form cannot serve both — `Borse` needs ö→o and `Boerse` needs
 * ö→oe — and expanding the query instead would make a query of `OE` an
 * exact-symbol hit on `O`. Only the row's own alternative spelling is ever
 * matched, so nothing that was not already a hit becomes one.
 */
function translit(value: SQL | AnyColumn | string): SQL {
  return sql`"bettertrack_search_translit"(${value})`;
}

export function createAssetRepository(db: Database) {
  return {
    /**
     * The asset for `id`, visible to `userId`: a global market asset, or the
     * caller's own custom asset. Another user's custom asset returns null — same
     * as a missing id, so no existence is leaked (§10).
     */
    async findByIdForUser(
      id: string,
      userId: string,
      options?: { includeCustomAssets?: boolean },
    ): Promise<AssetRow | null> {
      const rows = await db
        .select()
        .from(assets)
        .where(
          and(
            eq(assets.id, id),
            options?.includeCustomAssets === false
              ? isNull(assets.ownerId)
              : or(isNull(assets.ownerId), eq(assets.ownerId, userId)),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    /**
     * Batch form of {@link findByIdForUser}: one database read for an aggregate
     * quote/sparkline request, with the identical global-or-owned boundary.
     * Ordering is intentionally unspecified; the service restores input order.
     */
    async findByIdsForUser(ids: readonly string[], userId: string): Promise<AssetRow[]> {
      if (ids.length === 0) return [];
      return db
        .select()
        .from(assets)
        .where(
          and(inArray(assets.id, [...ids]), or(isNull(assets.ownerId), eq(assets.ownerId, userId))),
        );
    },

    /**
     * Ranked local-catalog search (§6.2): one Postgres round-trip over the
     * caller's visible assets — every global market asset plus their own custom
     * assets (another user's custom assets are invisible by construction, §10).
     *
     * A row qualifies through any of four tiers, and is ranked by the best tier
     * it hits: exact symbol (0) → symbol prefix (1) → name word/substring (2) →
     * trigram fuzzy (3). Ties break on trigram similarity, then name, so the
     * closest spelling wins within a tier. All tiers are case-insensitive and
     * LIKE wildcards in the query are treated literally.
     *
     * Shape: the tier and the trigram score are computed ONCE per scanned row,
     * in the target list of a fenced subquery, and the qualifying filter and the
     * sort both read those computed values. `tier <= 2` is exactly the first
     * three match arms (a row reaches tier 3 only when none of them hold), so
     * `tier < 3 or sim >= τ` is a literal rewrite of the four-armed OR this
     * query used to carry — with the fuzzy expression evaluated once instead of
     * four times (twice in the filter, twice again in `ORDER BY`). `offset 0`
     * is the fence: without it the planner pulls the subquery up and re-inlines
     * the expression into both places, undoing exactly that.
     *
     * The market-match total (#1794) rides on the SAME pass: an `over ()`
     * window aggregate is evaluated after the qualifying filter and BEFORE the
     * `ORDER BY … LIMIT`, so it counts every market row the catalog holds for
     * this query while costing no second scan, no second round-trip and no
     * duplicated predicate. Ranking, ordering and the limit are untouched.
     *
     * Plan note (#1709, #1876): this is, deliberately, a full pass over the
     * caller's visible rows — the planner reaches them through
     * `assets_owner_id_idx`, then filters and sorts every one of them. No index
     * can narrow the MATCH arms: the fuzzy tier is a `similarity() >= τ`
     * function call (unlike `%`, whose threshold lives in the
     * `pg_trgm.similarity_threshold` GUC, it is not index-supported), and the
     * tiers above it are a folded `symbol LIKE` and a folded `%…%` with no
     * expression index. Neither GIN that claimed to serve this could be scanned
     * — the composite trigram one because no arm speaks its operators (0110),
     * the `search_text` one because `search_text` never appears in a filter and
     * the `offset 0` fence exists so it cannot (0114) — and each cost a write
     * on every catalog upsert, so both are dropped. The premise that makes the pass
     * cheap — a self-hosted catalog of thousands of rows, LIMIT ~20 — is no
     * longer something a single account can destroy either: the interactive
     * provider fallback that grows the global catalog now carries a per-user
     * budget (`services/search/enrichmentBudget.ts`). If the catalog ever does
     * grow orders of magnitude, the answer is a two-pass read (index-servable
     * tiers first, fuzzy only on a miss) or a `%` predicate with a pinned
     * similarity GUC — not a re-added index.
     */
    async searchCatalog(
      userId: string,
      query: string,
      limit: number,
      options?: { includeCustomAssets?: boolean },
    ): Promise<CatalogSearchPage> {
      const visibility = visibleTo(userId, options?.includeCustomAssets !== false);

      const result = await db.execute(sql`
        select "id", "providerId", "providerRef", "symbol", "name", "exchange", "currency",
               "type", "ownerId",
               (count(*) filter (where "ownerId" is null) over ())::int as "marketTotal"
        from (
          select
            ${assets.id} as "id",
            ${assets.providerId} as "providerId",
            ${assets.providerRef} as "providerRef",
            ${assets.symbol} as "symbol",
            ${assets.name} as "name",
            ${assets.exchange} as "exchange",
            ${assets.currency} as "currency",
            ${assets.type} as "type",
            ${assets.ownerId} as "ownerId",
            ${catalogTierSql(query)} as "tier",
            ${catalogSimilaritySql(query)} as "sim"
          from ${assets}
          where ${visibility}
          offset 0
        ) ranked
        where "tier" < 3 or "sim" >= ${FUZZY_SIMILARITY_THRESHOLD}
        order by "tier", "sim" desc, "name"
        limit ${limit}
      `);

      const rows = resultRows<CatalogSearchMatch & { marketTotal: number | string }>(result);
      return {
        matches: rows.map((r) => ({
          id: r.id,
          providerId: r.providerId,
          providerRef: r.providerRef,
          symbol: r.symbol,
          name: r.name,
          exchange: r.exchange ?? null,
          currency: r.currency,
          type: r.type,
          ownerId: r.ownerId ?? null,
        })),
        // Every row of one result set carries the same window aggregate; an
        // empty page qualified nothing at all, market rows included.
        marketMatchTotal: rows.length === 0 ? 0 : Number(rows[0]!.marketTotal),
      };
    },

    /**
     * Freshness watermark for `userId`'s visible catalog (issue #555): the
     * creation time of the newest visible asset — every global market asset
     * plus the caller's own custom assets, the same visibility the search read
     * enforces — raised by the instance-wide catalog write stamp. The `assets`
     * table stores no per-row timestamp, but ids are UUIDv7 (§4.4), whose
     * leading 48 bits ARE the row's creation-ms, so `max(id)` (uuid order ==
     * time order) yields it without a schema change. Drives the catalog-search
     * `Last-Modified`; null only on a catalog that is empty and has never been
     * written. Deliberately query-independent — over-invalidation (a 200 instead
     * of a 304) is always safe.
     *
     * STEPS FORWARD ON EVERY CATALOG WRITE (#1709, #1762). "Newest visible id"
     * alone is blind three ways, and each one produces a stale 304 on the
     * `If-Modified-Since` rail — the rail whose whole audience is the callers
     * that send no ETag, so "the body ETag catches it" is not an answer:
     *
     *  - it moves BACKWARDS on a delete of the newest visible row (an owner
     *    deleting a custom asset, the paranoid detach), so a follow-up request
     *    carrying the pre-delete value is satisfied by the smaller one and the
     *    caller keeps rendering the deleted asset;
     *  - it does not move at all on an UPDATE, because a rename keeps the id —
     *    and `name` is exactly what `searchCatalog` returns and ranks on;
     *  - it does not clear the HTTP-date second boundary on an INSERT: a row
     *    created at 12:00:03.800 leaves a watermark of 12:00:03.100 advertising
     *    the same `12:00:03`, so the §6.2 "Searching providers…" refetch loop
     *    revalidates into a 304 and never sees the enriched row.
     *
     * The second term closes all three: `asset_catalog_watermark` is stamped by
     * the statement-level AFTER INSERT / UPDATE / DELETE triggers in migrations
     * 0110 + 0112, which put it one whole HTTP-date second past the newest row
     * left in the table (which dominates every caller's visible maximum) and
     * past the newest row the statement touched. So the max here rises on EVERY
     * content-changing statement — including one whose rows are older than the
     * current stamp, and one that touched something below the visible maximum,
     * both of which a merely-monotonic stamp would swallow. Because the stamp is
     * always a whole second and always above the other term, what this returns
     * is what `Last-Modified` can carry losslessly, which is what lets the
     * middleware compare exactly instead of flooring (`middleware/conditional`).
     * Both terms are read from the same UUIDv7 clock (the triggers never read
     * `now()`), so no server-clock skew enters the comparison.
     */
    async catalogWatermark(
      userId: string,
      options?: { includeCustomAssets?: boolean },
    ): Promise<Date | null> {
      // One round-trip, two scalar subqueries: the newest visible id (uuid order
      // == time order, an ORDER BY over the id index — no aggregate on the uuid
      // type, portable across engines) and the singleton write stamp, read as
      // epoch ms so no driver-specific timestamp parsing enters the comparison.
      const visibility = visibleTo(userId, options?.includeCustomAssets !== false);
      const result = await db.execute(sql`
        select
          (
            select ${assets.id} from ${assets}
            where ${visibility}
            order by ${assets.id} desc
            limit 1
          ) as "newest",
          (
            select (extract(epoch from ${assetCatalogWatermark.mutatedThrough}) * 1000)::bigint
            from ${assetCatalogWatermark}
            limit 1
          ) as "mutatedMs"
      `);

      const row = resultRows<{ newest: string | null; mutatedMs: string | number | null }>(
        result,
      )[0];
      const newestMs = row?.newest != null ? uuidV7Millis(row.newest) : null;
      const mutatedMs = row?.mutatedMs != null ? Number(row.mutatedMs) : null;
      if (newestMs === null && mutatedMs === null) return null;
      return new Date(Math.max(newestMs ?? 0, mutatedMs ?? 0));
    },

    /**
     * Upsert of a global market asset (§6.2), idempotent on the partial unique
     * index `assets_global_provider_ref_unique`: first touch INSERTs, a later
     * touch REFRESHES the descriptive columns its caller is authoritative for.
     *
     * `ON CONFLICT DO NOTHING ... RETURNING` returns the row only when this call
     * inserted it; an empty return means the row already exists (or a concurrent
     * caller won the race), so the caller learns whether the insert happened and
     * a backfill is enqueued exactly once.
     *
     * The refresh arm (#1810) is the second half. Until it existed a global row
     * was WRITE-ONCE — nothing in the repo could correct one, because the custom
     * -asset update is gated on `owner_id = user AND provider_id = 'manual'` and
     * there is no admin asset editor. So a correction shipped in the curated
     * seed list (a renamed issuer, a re-listed exchange, a wrong `currency` —
     * the denomination `portfolioService` books a persisted cash movement in)
     * was a no-op on every existing install, and a name a provider has since
     * fixed stayed frozen at first touch. `name` is the sharpest case: it is
     * what `searchCatalog` both returns AND ranks on, so a stale one makes the
     * row unfindable by its real name, permanently.
     *
     * Four properties keep the arm narrow:
     *  - it happens only for the columns THIS caller named in
     *    {@link UpsertGlobalOptions.refresh}, so a caller whose input is a
     *    best-effort projection cannot overwrite a column it merely guessed —
     *    the reason a re-enrichment writes `currency` only when it re-read one
     *    authoritatively (see {@link UpsertGlobalOptions}). No `refresh` at all
     *    means insert-or-nothing;
     *  - it is scoped to `owner_id IS NULL`, so a user's custom asset can never
     *    be overwritten by a global refresh — same boundary as §10 everywhere
     *    else, restated in the WHERE rather than assumed from the unique index;
     *  - `id` (every transaction, holding and watchlist row points at it),
     *    `owner_id` and `meta` are never refreshable, so a correction is an
     *    in-place edit, not a re-identify;
     *  - it is guarded by an `IS DISTINCT FROM` over exactly the named columns,
     *    so an unchanged re-seed or re-enrichment issues no write at all. That
     *    is not just I/O: the statement-level catalog-watermark trigger
     *    (migrations 0110/0112) stamps once per content-changing STATEMENT, so
     *    600 unconditional no-op updates at boot would push the search
     *    `Last-Modified` 600 seconds into the future for every client.
     *
     * The database's assets AFTER INSERT trigger owns the opaque identity
     * insert. Because AFTER triggers do not run for an ON CONFLICT candidate
     * that was skipped, this path can never strand a key for a losing upsert;
     * the refresh is an UPDATE, so it does not run that trigger at all.
     */
    async upsertGlobal(
      input: GlobalAssetUpsert,
      options?: UpsertGlobalOptions,
    ): Promise<UpsertGlobalResult> {
      const inserted = await db
        .insert(assets)
        .values({
          providerId: input.providerId,
          providerRef: input.providerRef,
          ownerId: null,
          type: input.type,
          symbol: input.symbol,
          name: input.name,
          exchange: input.exchange,
          currency: input.currency,
        })
        .onConflictDoNothing()
        .returning();

      if (inserted[0]) return { row: inserted[0], created: true, refreshed: false };

      const wanted = new Set(options?.refresh ?? []);
      if (wanted.size > 0) {
        const values: AssetRefreshValues = {};
        // Only when something actually differs (see above). `type` is an enum
        // and `currency` a char(3); both are compared as text so no parameter
        // -type inference rides on this predicate.
        const changed: SQL[] = [];
        if (wanted.has('type')) {
          values.type = input.type;
          changed.push(sql`${assets.type}::text is distinct from ${input.type}`);
        }
        if (wanted.has('symbol')) {
          values.symbol = input.symbol;
          changed.push(sql`${assets.symbol} is distinct from ${input.symbol}`);
        }
        if (wanted.has('name')) {
          values.name = input.name;
          changed.push(sql`${assets.name} is distinct from ${input.name}`);
        }
        if (wanted.has('exchange')) {
          values.exchange = input.exchange;
          changed.push(sql`${assets.exchange} is distinct from ${input.exchange}::text`);
        }
        if (wanted.has('currency')) {
          values.currency = input.currency;
          changed.push(sql`${assets.currency}::text is distinct from ${input.currency}`);
        }

        const refreshed = await db
          .update(assets)
          .set(values)
          .where(
            and(
              eq(assets.providerId, input.providerId),
              eq(assets.providerRef, input.providerRef),
              isNull(assets.ownerId),
              or(...changed),
            ),
          )
          .returning();

        if (refreshed[0]) return { row: refreshed[0], created: false, refreshed: true };
      }

      const existing = await this.findGlobal(input.providerId, input.providerRef);
      if (!existing) {
        // Unreachable in practice: the conflict implies a global row exists.
        throw new Error('Global asset upsert found no row after conflict');
      }
      return { row: existing, created: false, refreshed: false };
    },

    /**
     * Whether at least one `price_history` row exists for this asset — the
     * emptiness probe behind the first-reference backfill trigger (§6.2/§9,
     * `services/assets/referenceBackfill.ts`).
     */
    async hasPriceHistory(assetId: string): Promise<boolean> {
      const rows = await db
        .select({ assetId: priceHistory.assetId })
        .from(priceHistory)
        .where(eq(priceHistory.assetId, assetId))
        .limit(1);
      return rows.length > 0;
    },

    /** The global (owner-less) asset for its public id, or null. */
    async findGlobalById(id: string): Promise<AssetRow | null> {
      const rows = await db
        .select()
        .from(assets)
        .where(and(eq(assets.id, id), isNull(assets.ownerId)))
        .limit(1);
      return rows[0] ?? null;
    },

    /** The global (owner-less) asset for a provider ref, or null. */
    async findGlobal(providerId: string, providerRef: string): Promise<AssetRow | null> {
      const rows = await db
        .select()
        .from(assets)
        .where(
          and(
            eq(assets.providerId, providerId),
            eq(assets.providerRef, providerRef),
            isNull(assets.ownerId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
  };
}

/** Escape LIKE wildcards so a user's query is treated as a literal substring. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export type AssetRepository = ReturnType<typeof createAssetRepository>;
