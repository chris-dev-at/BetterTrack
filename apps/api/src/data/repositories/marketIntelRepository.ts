import { eq, gt, sql } from 'drizzle-orm';

import type { Database } from '../db';
import { assets, portfolios, transactions, workboardItems } from '../schema';

/**
 * Market-intelligence aggregation reads (PROJECTPLAN.md §13.5 V5-P5). The
 * earnings calendar (arc b) and the reminder scan job both need "every asset a
 * user holds or watches", resolved to a provider ref so the provider/cache
 * keystone can be asked for its earnings. Two shapes: one user's book (the
 * Workboard panel endpoint) and every user's book at once (the scan job).
 *
 * "Held" is a **net-positive** position — SUM(buy − sell) > 0 over the user's
 * transactions — so a fully-closed position drops out; "watched" is any
 * workboard item. An asset can be both (flags are independent). All reads are
 * strictly owner-scoped through `portfolios.user_id` / `workboard_items.user_id`.
 */

/** One held/watched asset, resolved to its provider ref (per user). */
export interface UserIntelAsset {
  assetId: string;
  symbol: string;
  name: string;
  providerId: string;
  providerRef: string;
  held: boolean;
  watched: boolean;
}

/** Same, tagged with the owning user — the scan job iterates every book. */
export interface UserIntelAssetWithUser extends UserIntelAsset {
  userId: string;
}

export interface MarketIntelRepository {
  /** Held (net > 0) + watched assets for one user, deduped by asset. */
  listUserWatchAndHoldAssets(userId: string): Promise<UserIntelAsset[]>;
  /** Held + watched assets across EVERY user, tagged with the owner. */
  listAllWatchAndHoldAssets(): Promise<UserIntelAssetWithUser[]>;
}

/** Signed quantity per transaction: +qty for a buy, −qty for a sell. */
const signedQuantity = sql<number>`sum(case when ${transactions.side} = 'buy' then ${transactions.quantity} else -${transactions.quantity} end)`;

export function createMarketIntelRepository(db: Database): MarketIntelRepository {
  /** Merge the held + watched rows for one user into one row per asset. */
  function merge(
    held: {
      assetId: string;
      symbol: string;
      name: string;
      providerId: string;
      providerRef: string;
    }[],
    watched: {
      assetId: string;
      symbol: string;
      name: string;
      providerId: string;
      providerRef: string;
    }[],
  ): UserIntelAsset[] {
    const byAsset = new Map<string, UserIntelAsset>();
    for (const row of held) {
      byAsset.set(row.assetId, { ...row, held: true, watched: false });
    }
    for (const row of watched) {
      const existing = byAsset.get(row.assetId);
      if (existing) existing.watched = true;
      else byAsset.set(row.assetId, { ...row, held: false, watched: true });
    }
    return [...byAsset.values()];
  }

  return {
    async listUserWatchAndHoldAssets(userId) {
      const held = await db
        .select({
          assetId: assets.id,
          symbol: assets.symbol,
          name: assets.name,
          providerId: assets.providerId,
          providerRef: assets.providerRef,
        })
        .from(transactions)
        .innerJoin(portfolios, eq(transactions.portfolioId, portfolios.id))
        .innerJoin(assets, eq(transactions.assetId, assets.id))
        .where(eq(portfolios.userId, userId))
        .groupBy(assets.id, assets.symbol, assets.name, assets.providerId, assets.providerRef)
        .having(gt(signedQuantity, sql`0`));

      const watched = await db
        .select({
          assetId: assets.id,
          symbol: assets.symbol,
          name: assets.name,
          providerId: assets.providerId,
          providerRef: assets.providerRef,
        })
        .from(workboardItems)
        .innerJoin(assets, eq(workboardItems.assetId, assets.id))
        .where(eq(workboardItems.userId, userId))
        .groupBy(assets.id, assets.symbol, assets.name, assets.providerId, assets.providerRef);

      return merge(held, watched);
    },

    async listAllWatchAndHoldAssets() {
      const held = await db
        .select({
          userId: portfolios.userId,
          assetId: assets.id,
          symbol: assets.symbol,
          name: assets.name,
          providerId: assets.providerId,
          providerRef: assets.providerRef,
        })
        .from(transactions)
        .innerJoin(portfolios, eq(transactions.portfolioId, portfolios.id))
        .innerJoin(assets, eq(transactions.assetId, assets.id))
        .groupBy(
          portfolios.userId,
          assets.id,
          assets.symbol,
          assets.name,
          assets.providerId,
          assets.providerRef,
        )
        .having(gt(signedQuantity, sql`0`));

      const watched = await db
        .select({
          userId: workboardItems.userId,
          assetId: assets.id,
          symbol: assets.symbol,
          name: assets.name,
          providerId: assets.providerId,
          providerRef: assets.providerRef,
        })
        .from(workboardItems)
        .innerJoin(assets, eq(workboardItems.assetId, assets.id));

      // Merge per (userId, assetId): a user holding AND watching the same asset
      // yields one row with both flags set.
      const byKey = new Map<string, UserIntelAssetWithUser>();
      for (const row of held) {
        byKey.set(`${row.userId}:${row.assetId}`, { ...row, held: true, watched: false });
      }
      for (const row of watched) {
        const key = `${row.userId}:${row.assetId}`;
        const existing = byKey.get(key);
        if (existing) existing.watched = true;
        else byKey.set(key, { ...row, held: false, watched: true });
      }
      return [...byKey.values()];
    },
  };
}
