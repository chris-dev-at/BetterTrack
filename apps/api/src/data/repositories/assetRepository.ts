import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';

import type { Database } from '../db';
import { assets, priceHistory } from '../schema';
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
    async findByIdForUser(id: string, userId: string): Promise<AssetRow | null> {
      const rows = await db
        .select()
        .from(assets)
        .where(and(eq(assets.id, id), or(isNull(assets.ownerId), eq(assets.ownerId, userId))))
        .limit(1);
      return rows[0] ?? null;
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
     * Plan note: this is a deliberate sequential scan. The OR of four match
     * arms defeats index use regardless of the fuzzy arm — `upper(symbol) LIKE`
     * has no expression index, and `similarity() >= τ` (unlike the `%` operator,
     * whose threshold lives in the `pg_trgm.similarity_threshold` GUC) is not
     * index-supported. At self-hosted catalog scale (thousands of rows, LIMIT
     * ~20) that's sub-millisecond; revisit with `%` + an expression index on
     * `upper(symbol)` only if the catalog grows orders of magnitude.
     */
    async searchCatalog(
      userId: string,
      query: string,
      limit: number,
    ): Promise<CatalogSearchMatch[]> {
      const prefix = `${escapeLike(query)}%`;
      const substring = `%${escapeLike(query)}%`;
      const similarity = sql<number>`greatest(similarity(${assets.symbol}, ${query}), similarity(${assets.name}, ${query}))`;
      const rank = sql<number>`case
        when upper(${assets.symbol}) = upper(${query}) then 0
        when upper(${assets.symbol}) like upper(${prefix}) then 1
        when ${assets.name} ilike ${substring}
          or ${assets.searchText} @@ plainto_tsquery('simple', ${query}) then 2
        else 3
      end`;

      const rows = await db
        .select({
          id: assets.id,
          providerId: assets.providerId,
          providerRef: assets.providerRef,
          symbol: assets.symbol,
          name: assets.name,
          exchange: assets.exchange,
          currency: assets.currency,
          type: assets.type,
          ownerId: assets.ownerId,
        })
        .from(assets)
        .where(
          and(
            or(isNull(assets.ownerId), eq(assets.ownerId, userId)),
            or(
              sql`upper(${assets.symbol}) like upper(${prefix})`,
              ilike(assets.name, substring),
              sql`${assets.searchText} @@ plainto_tsquery('simple', ${query})`,
              sql`${similarity} >= ${FUZZY_SIMILARITY_THRESHOLD}`,
            ),
          ),
        )
        .orderBy(rank, desc(similarity), assets.name)
        .limit(limit);

      return rows.map((r) => ({ ...r, exchange: r.exchange ?? null, ownerId: r.ownerId ?? null }));
    },

    /**
     * First-touch upsert of a global market asset (§6.2), idempotent on the
     * partial unique index `assets_global_provider_ref_unique`.
     *
     * `ON CONFLICT DO NOTHING ... RETURNING` returns the row only when this call
     * inserted it; an empty return means a concurrent caller won the race, so we
     * re-select the existing global row. Either way the caller learns whether the
     * insert happened, so a backfill is enqueued exactly once.
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
