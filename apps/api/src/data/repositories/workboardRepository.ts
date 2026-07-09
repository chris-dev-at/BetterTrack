import { and, asc, eq, inArray, max, sql } from 'drizzle-orm';

import type { Database } from '../db';
import { assets, watchlists, workboardItems } from '../schema';
import type { AssetRow, WorkboardItemRow } from '../schema';

export interface WorkboardItemWithAsset extends WorkboardItemRow {
  asset: {
    symbol: string;
    name: string;
    exchange: string | null;
    currency: string;
    type: AssetRow['type'];
  };
}

/** One named watchlist with its item count (§13.3 V3-P5). */
export interface WatchlistRow {
  id: string;
  name: string;
  isDefault: boolean;
  sortOrder: number;
  itemCount: number;
}

/** The item-select shape, shared by the list/find mappers. */
const ITEM_COLUMNS = {
  id: workboardItems.id,
  userId: workboardItems.userId,
  watchlistId: workboardItems.watchlistId,
  assetId: workboardItems.assetId,
  sortOrder: workboardItems.sortOrder,
  note: workboardItems.note,
  symbol: assets.symbol,
  name: assets.name,
  exchange: assets.exchange,
  currency: assets.currency,
  type: assets.type,
} as const;

type ItemJoinRow = {
  id: string;
  userId: string;
  watchlistId: string;
  assetId: string;
  sortOrder: number;
  note: string | null;
  symbol: string;
  name: string;
  exchange: string | null;
  currency: string;
  type: AssetRow['type'];
};

function toItem(row: ItemJoinRow): WorkboardItemWithAsset {
  return {
    id: row.id,
    userId: row.userId,
    watchlistId: row.watchlistId,
    assetId: row.assetId,
    sortOrder: row.sortOrder,
    note: row.note,
    asset: {
      symbol: row.symbol,
      name: row.name,
      exchange: row.exchange ?? null,
      currency: row.currency,
      type: row.type,
    },
  };
}

/**
 * Watchlist + item SQL. Items are always scoped by user_id (no IDOR, §10);
 * named lists (§13.3 V3-P5) are scoped by user_id too, and the owner's default
 * **General** list is the add-flow anchor.
 */
export function createWorkboardRepository(db: Database) {
  return {
    // ── Named watchlists ────────────────────────────────────────────────────

    /** The caller's lists (General first, then by name) with item counts. */
    async listWatchlists(userId: string): Promise<WatchlistRow[]> {
      const rows = await db
        .select({
          id: watchlists.id,
          name: watchlists.name,
          isDefault: watchlists.isDefault,
          sortOrder: watchlists.sortOrder,
          itemCount: sql<number>`count(${workboardItems.id})`.mapWith(Number),
        })
        .from(watchlists)
        .leftJoin(workboardItems, eq(workboardItems.watchlistId, watchlists.id))
        .where(eq(watchlists.userId, userId))
        .groupBy(watchlists.id)
        .orderBy(sql`${watchlists.isDefault} desc`, asc(watchlists.name));
      return rows;
    },

    /** A single list owned by the caller, or undefined (→ 404, no IDOR). */
    async findWatchlist(
      userId: string,
      watchlistId: string,
    ): Promise<{ id: string; name: string; isDefault: boolean } | undefined> {
      const [row] = await db
        .select({ id: watchlists.id, name: watchlists.name, isDefault: watchlists.isDefault })
        .from(watchlists)
        .where(and(eq(watchlists.id, watchlistId), eq(watchlists.userId, userId)))
        .limit(1);
      return row;
    },

    /**
     * The caller's default (General) list id, creating it on first need so a
     * post-migration account (or a fresh signup) always has a target list.
     * Idempotent against the one-default-per-user partial unique index.
     */
    async ensureDefaultWatchlist(userId: string): Promise<string> {
      const [existing] = await db
        .select({ id: watchlists.id })
        .from(watchlists)
        .where(and(eq(watchlists.userId, userId), eq(watchlists.isDefault, true)))
        .limit(1);
      if (existing) return existing.id;

      const [created] = await db
        .insert(watchlists)
        .values({ userId, name: 'General', isDefault: true, sortOrder: 0 })
        .onConflictDoNothing()
        .returning({ id: watchlists.id });
      if (created) return created.id;

      // Lost the race on the partial unique index — read the winner.
      const [row] = await db
        .select({ id: watchlists.id })
        .from(watchlists)
        .where(and(eq(watchlists.userId, userId), eq(watchlists.isDefault, true)))
        .limit(1);
      return row!.id;
    },

    /** Whether the caller already has a list with this name (case-insensitive). */
    async watchlistNameTaken(userId: string, name: string, excludeId?: string): Promise<boolean> {
      const rows = await db
        .select({ id: watchlists.id })
        .from(watchlists)
        .where(
          and(
            eq(watchlists.userId, userId),
            sql`lower(${watchlists.name}) = ${name.trim().toLowerCase()}`,
          ),
        );
      return rows.some((r) => r.id !== excludeId);
    },

    /** Create a non-default list. Caller checks the name first. */
    async createWatchlist(userId: string, name: string): Promise<string> {
      const [row] = await db
        .insert(watchlists)
        .values({ userId, name, isDefault: false, sortOrder: Date.now() % 1_000_000 })
        .returning({ id: watchlists.id });
      return row!.id;
    },

    /** Rename a list the caller owns. Returns false when not owned (→ 404). */
    async renameWatchlist(userId: string, watchlistId: string, name: string): Promise<boolean> {
      const rows = await db
        .update(watchlists)
        .set({ name, updatedAt: new Date() })
        .where(and(eq(watchlists.id, watchlistId), eq(watchlists.userId, userId)))
        .returning({ id: watchlists.id });
      return rows.length > 0;
    },

    /** Delete a list (cascades its items). Returns false when not owned (→ 404). */
    async deleteWatchlist(userId: string, watchlistId: string): Promise<boolean> {
      const rows = await db
        .delete(watchlists)
        .where(and(eq(watchlists.id, watchlistId), eq(watchlists.userId, userId)))
        .returning({ id: watchlists.id });
      return rows.length > 0;
    },

    // ── Items ───────────────────────────────────────────────────────────────

    /** All items across the caller's lists (owner view + membership set). */
    async list(userId: string): Promise<WorkboardItemWithAsset[]> {
      const rows = await db
        .select(ITEM_COLUMNS)
        .from(workboardItems)
        .innerJoin(assets, eq(workboardItems.assetId, assets.id))
        .where(eq(workboardItems.userId, userId))
        .orderBy(workboardItems.sortOrder);
      return rows.map(toItem);
    },

    /** Items in one of the caller's lists. */
    async listByWatchlistForUser(
      userId: string,
      watchlistId: string,
    ): Promise<WorkboardItemWithAsset[]> {
      const rows = await db
        .select(ITEM_COLUMNS)
        .from(workboardItems)
        .innerJoin(assets, eq(workboardItems.assetId, assets.id))
        .where(and(eq(workboardItems.userId, userId), eq(workboardItems.watchlistId, watchlistId)))
        .orderBy(workboardItems.sortOrder);
      return rows.map(toItem);
    },

    /** Items in one list by id (owner-agnostic) — for the authorized shared read. */
    async listByWatchlist(watchlistId: string): Promise<WorkboardItemWithAsset[]> {
      const rows = await db
        .select(ITEM_COLUMNS)
        .from(workboardItems)
        .innerJoin(assets, eq(workboardItems.assetId, assets.id))
        .where(eq(workboardItems.watchlistId, watchlistId))
        .orderBy(workboardItems.sortOrder);
      return rows.map(toItem);
    },

    async findOneWithAsset(userId: string, itemId: string): Promise<WorkboardItemWithAsset | null> {
      const rows = await db
        .select(ITEM_COLUMNS)
        .from(workboardItems)
        .innerJoin(assets, eq(workboardItems.assetId, assets.id))
        .where(and(eq(workboardItems.id, itemId), eq(workboardItems.userId, userId)))
        .limit(1);
      const row = rows[0];
      return row ? toItem(row) : null;
    },

    async assetExists(assetId: string): Promise<boolean> {
      const rows = await db
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.id, assetId))
        .limit(1);
      return rows.length > 0;
    },

    /**
     * Append an asset to a specific list. Returns null on the UNIQUE conflict
     * (asset already in that list). `sortOrder` continues from the list's max.
     */
    async add(
      userId: string,
      watchlistId: string,
      assetId: string,
    ): Promise<WorkboardItemRow | null> {
      const [agg] = await db
        .select({ maxOrder: max(workboardItems.sortOrder) })
        .from(workboardItems)
        .where(eq(workboardItems.watchlistId, watchlistId));
      const nextOrder = (agg?.maxOrder ?? -1) + 1;

      const rows = await db
        .insert(workboardItems)
        .values({ userId, watchlistId, assetId, sortOrder: nextOrder })
        .onConflictDoNothing()
        .returning();
      return rows[0] ?? null;
    },

    /** Deletes scoped to the caller. Returns false when the itemId is not the caller's. */
    async remove(userId: string, itemId: string): Promise<boolean> {
      const rows = await db
        .delete(workboardItems)
        .where(and(eq(workboardItems.id, itemId), eq(workboardItems.userId, userId)))
        .returning({ id: workboardItems.id });
      return rows.length > 0;
    },

    /** Assigns sort positions 0,1,2,… to the provided item IDs; foreign ids ignored. */
    async reorder(userId: string, itemIds: string[]): Promise<void> {
      if (itemIds.length === 0) return;
      const owned = await db
        .select({ id: workboardItems.id })
        .from(workboardItems)
        .where(and(eq(workboardItems.userId, userId), inArray(workboardItems.id, itemIds)));
      const ownedSet = new Set(owned.map((r) => r.id));

      let pos = 0;
      for (const id of itemIds) {
        if (ownedSet.has(id)) {
          await db
            .update(workboardItems)
            .set({ sortOrder: pos++ })
            .where(eq(workboardItems.id, id));
        }
      }
    },
  };
}

export type WorkboardRepository = ReturnType<typeof createWorkboardRepository>;
