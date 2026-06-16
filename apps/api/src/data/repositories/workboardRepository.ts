import { and, eq, inArray, max } from 'drizzle-orm';

import type { Database } from '../db';
import { assets, workboardItems } from '../schema';
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

/** All workboard SQL, always scoped by user_id to prevent IDOR (PROJECTPLAN.md §10). */
export function createWorkboardRepository(db: Database) {
  return {
    async list(userId: string): Promise<WorkboardItemWithAsset[]> {
      const rows = await db
        .select({
          id: workboardItems.id,
          userId: workboardItems.userId,
          assetId: workboardItems.assetId,
          sortOrder: workboardItems.sortOrder,
          note: workboardItems.note,
          symbol: assets.symbol,
          name: assets.name,
          exchange: assets.exchange,
          currency: assets.currency,
          type: assets.type,
        })
        .from(workboardItems)
        .innerJoin(assets, eq(workboardItems.assetId, assets.id))
        .where(eq(workboardItems.userId, userId))
        .orderBy(workboardItems.sortOrder);

      return rows.map((row) => ({
        id: row.id,
        userId: row.userId,
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
      }));
    },

    async findOneWithAsset(userId: string, itemId: string): Promise<WorkboardItemWithAsset | null> {
      const rows = await db
        .select({
          id: workboardItems.id,
          userId: workboardItems.userId,
          assetId: workboardItems.assetId,
          sortOrder: workboardItems.sortOrder,
          note: workboardItems.note,
          symbol: assets.symbol,
          name: assets.name,
          exchange: assets.exchange,
          currency: assets.currency,
          type: assets.type,
        })
        .from(workboardItems)
        .innerJoin(assets, eq(workboardItems.assetId, assets.id))
        .where(and(eq(workboardItems.id, itemId), eq(workboardItems.userId, userId)))
        .limit(1);

      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        userId: row.userId,
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
    },

    async assetExists(assetId: string): Promise<boolean> {
      const rows = await db
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.id, assetId))
        .limit(1);
      return rows.length > 0;
    },

    /** Appends at end. Returns null if the item already exists (UNIQUE conflict). */
    async add(userId: string, assetId: string): Promise<WorkboardItemRow | null> {
      const [agg] = await db
        .select({ maxOrder: max(workboardItems.sortOrder) })
        .from(workboardItems)
        .where(eq(workboardItems.userId, userId));
      const nextOrder = (agg?.maxOrder ?? -1) + 1;

      const rows = await db
        .insert(workboardItems)
        .values({ userId, assetId, sortOrder: nextOrder })
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

    /**
     * Assigns sort positions 0, 1, 2, … to the provided item IDs in order.
     * IDs not owned by the caller are silently ignored (no cross-user mutation).
     */
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
