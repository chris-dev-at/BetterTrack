import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import type { Database } from '../db';
import { assetCatalogDeletions, assets, priceHistory } from '../schema';
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

/** Result of {@link AssetRepository.upsertGlobal}: the row plus whether it was just created. */
export interface UpsertGlobalResult {
  row: AssetRow;
  /** True only when this call inserted the row — the first touch (§6.2). */
  created: boolean;
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
     * Plan note (#1709): this is, deliberately, a full pass over the caller's
     * visible rows — the planner reaches them through `assets_owner_id_idx`,
     * then filters and sorts every one of them. No index can narrow the MATCH
     * arms: the fuzzy tier is a `similarity() >= τ` function call (unlike `%`,
     * whose threshold lives in the `pg_trgm.similarity_threshold` GUC, it is
     * not index-supported), and the tiers above it are `upper(symbol) LIKE` and
     * a `%…%` ILIKE with no expression index. The composite trigram GIN that
     * claimed to serve this scanned nothing and cost a write on every catalog
     * upsert, so migration 0110 dropped it. The premise that makes the pass
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
    ): Promise<CatalogSearchMatch[]> {
      const prefix = `${escapeLike(query)}%`;
      const substring = `%${escapeLike(query)}%`;
      const visibility = visibleTo(userId, options?.includeCustomAssets !== false);

      const result = await db.execute(sql`
        select "id", "providerId", "providerRef", "symbol", "name", "exchange", "currency",
               "type", "ownerId"
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
            case
              when upper(${assets.symbol}) = upper(${query}) then 0
              when upper(${assets.symbol}) like upper(${prefix}) then 1
              when ${assets.name} ilike ${substring}
                or ${assets.searchText} @@ plainto_tsquery('simple', ${query}) then 2
              else 3
            end as "tier",
            greatest(
              similarity(${assets.symbol}, ${query}),
              similarity(${assets.name}, ${query})
            ) as "sim"
          from ${assets}
          where ${visibility}
          offset 0
        ) ranked
        where "tier" < 3 or "sim" >= ${FUZZY_SIMILARITY_THRESHOLD}
        order by "tier", "sim" desc, "name"
        limit ${limit}
      `);

      return resultRows<CatalogSearchMatch>(result).map((r) => ({
        id: r.id,
        providerId: r.providerId,
        providerRef: r.providerRef,
        symbol: r.symbol,
        name: r.name,
        exchange: r.exchange ?? null,
        currency: r.currency,
        type: r.type,
        ownerId: r.ownerId ?? null,
      }));
    },

    /**
     * Freshness watermark for `userId`'s visible catalog (issue #555): the
     * creation time of the newest visible asset — every global market asset
     * plus the caller's own custom assets, the same visibility the search read
     * enforces. The `assets` table stores no per-row timestamp, but ids are
     * UUIDv7 (§4.4), whose leading 48 bits ARE the row's creation-ms, so
     * `max(id)` (uuid order == time order) yields it without a schema change.
     * Drives the catalog-search `Last-Modified`; null when the caller can see
     * no assets and nothing has ever been deleted. Deliberately
     * query-independent — over-invalidation (a 200 instead of a 304) is always
     * safe, and content edits (a rename that keeps the id) are caught by the
     * per-request body ETag, not this watermark.
     *
     * STEPS FORWARD ON DELETION (#1709). "Newest visible id" alone can move
     * BACKWARDS: delete the newest visible row — an owner deleting a custom
     * asset, the paranoid detach — and the watermark drops to the id before it,
     * so a follow-up `If-Modified-Since` carrying the pre-delete value is
     * satisfied by the smaller one and the caller is told 304 while still
     * rendering the deleted asset. The second term closes that:
     * `asset_catalog_deletions` is stamped by the statement-level AFTER DELETE
     * trigger in migration 0110, which puts it one whole HTTP-date second past
     * the newest row that is left (which dominates every caller's visible
     * maximum) and past the newest row the statement removed. So the max here
     * rises on EVERY deleting statement — including one whose row is older than
     * the current stamp, and one that removed something below the visible
     * maximum, both of which a merely-monotonic stamp would swallow. Both terms
     * are read from the same UUIDv7 clock (the trigger never reads `now()`), so
     * no server-clock skew enters the comparison.
     */
    async catalogWatermark(
      userId: string,
      options?: { includeCustomAssets?: boolean },
    ): Promise<Date | null> {
      // One round-trip, two scalar subqueries: the newest visible id (uuid order
      // == time order, an ORDER BY over the id index — no aggregate on the uuid
      // type, portable across engines) and the singleton deletion stamp, read as
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
            select (extract(epoch from ${assetCatalogDeletions.deletedThrough}) * 1000)::bigint
            from ${assetCatalogDeletions}
            limit 1
          ) as "deletedMs"
      `);

      const row = resultRows<{ newest: string | null; deletedMs: string | number | null }>(
        result,
      )[0];
      const newestMs = row?.newest != null ? uuidV7Millis(row.newest) : null;
      const deletedMs = row?.deletedMs != null ? Number(row.deletedMs) : null;
      if (newestMs === null && deletedMs === null) return null;
      return new Date(Math.max(newestMs ?? 0, deletedMs ?? 0));
    },

    /**
     * First-touch upsert of a global market asset (§6.2), idempotent on the
     * partial unique index `assets_global_provider_ref_unique`.
     *
     * `ON CONFLICT DO NOTHING ... RETURNING` returns the row only when this call
     * inserted it; an empty return means a concurrent caller won the race, so we
     * re-select the existing global row. Either way the caller learns whether the
     * insert happened, so a backfill is enqueued exactly once.
     *
     * The database's assets AFTER INSERT trigger owns the opaque identity
     * insert. Because AFTER triggers do not run for an ON CONFLICT candidate
     * that was skipped, this path can never strand a key for a losing upsert.
     */
    async upsertGlobal(input: GlobalAssetUpsert): Promise<UpsertGlobalResult> {
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

      if (inserted[0]) return { row: inserted[0], created: true };

      const existing = await this.findGlobal(input.providerId, input.providerRef);
      if (!existing) {
        // Unreachable in practice: the conflict implies a global row exists.
        throw new Error('Global asset upsert found no row after conflict');
      }
      return { row: existing, created: false };
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
