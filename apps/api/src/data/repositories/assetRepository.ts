import { and, eq, ilike, isNull, or } from 'drizzle-orm';

import type { Database } from '../db';
import { assets } from '../schema';
import type { AssetRow } from '../schema';

/**
 * Asset persistence for the market-data read API (PROJECTPLAN.md §6.2, §6.3).
 *
 * Two access rules are enforced here, in the repository, not the controller
 * (§10 — "no IDOR by construction"):
 *  - a **global market asset** (`owner_id IS NULL`) is readable by every user;
 *  - a **custom asset** (`owner_id = user`) is readable only by its owner.
 */

/** A custom-asset search match scoped to its owner (§6.2). */
export interface CustomAssetMatch {
  id: string;
  providerId: string;
  providerRef: string;
  symbol: string;
  name: string;
  exchange: string | null;
  currency: string;
  type: AssetRow['type'];
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
     * The caller's own custom assets whose name matches `query`
     * (case-insensitive substring), ordered by name (§6.2). Owner-scoped.
     */
    async searchCustomByName(userId: string, query: string): Promise<CustomAssetMatch[]> {
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
        })
        .from(assets)
        .where(and(eq(assets.ownerId, userId), ilike(assets.name, `%${escapeLike(query)}%`)))
        .orderBy(assets.name);
      return rows.map((r) => ({ ...r, exchange: r.exchange ?? null }));
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
