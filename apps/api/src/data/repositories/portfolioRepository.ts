import { and, asc, eq, inArray } from 'drizzle-orm';

import type { Database } from '../db';
import { assets, portfolios, priceHistory } from '../schema';
import type { AssetRow } from '../schema';

/**
 * Portfolio-scoped persistence (PROJECTPLAN.md §6.9). A user has exactly one
 * portfolio in v1 ("Main"), created lazily on the first write. Reads never
 * create it, so a brand-new user's `GET /portfolio` is an honest empty result
 * rather than a side effect.
 *
 * This repository also owns the two read seams the portfolio *service* needs to
 * feed `domain/holdings`: the asset rows behind a set of transacted asset ids
 * (currency + provider ref for live quotes) and their stored daily prices /
 * value points from `price_history` (for the value-over-time series).
 */

/** One stored daily price or custom-asset value point (§5.5). */
export interface AssetPriceRow {
  assetId: string;
  /** ISO `YYYY-MM-DD`. */
  date: string;
  close: number;
}

export function createPortfolioRepository(db: Database) {
  return {
    /**
     * The id of the user's "Main" portfolio, creating it on first touch.
     * Idempotent on the `portfolios_user_name_unique` index: a concurrent
     * caller's insert is swallowed and we re-select the row either way.
     */
    async getOrCreateMain(userId: string): Promise<string> {
      await db.insert(portfolios).values({ userId, name: 'Main' }).onConflictDoNothing();
      const rows = await db
        .select({ id: portfolios.id })
        .from(portfolios)
        .where(and(eq(portfolios.userId, userId), eq(portfolios.name, 'Main')))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error('Main portfolio vanished after upsert');
      return row.id;
    },

    /** The user's "Main" portfolio id, or null when they have none yet (read path). */
    async findMain(userId: string): Promise<string | null> {
      const rows = await db
        .select({ id: portfolios.id })
        .from(portfolios)
        .where(and(eq(portfolios.userId, userId), eq(portfolios.name, 'Main')))
        .limit(1);
      return rows[0]?.id ?? null;
    },

    /** The asset rows for a set of ids (currency, provider ref, meta). */
    async assetsByIds(ids: readonly string[]): Promise<AssetRow[]> {
      if (ids.length === 0) return [];
      return db
        .select()
        .from(assets)
        .where(inArray(assets.id, [...ids]));
    },

    /**
     * Stored daily prices / value points for a set of assets, ascending by date
     * (§5.5). Market assets contribute their closes; custom assets contribute
     * their value points — both live in `price_history`, so the value-over-time
     * series needs no special-casing.
     */
    async pricesForAssets(ids: readonly string[]): Promise<AssetPriceRow[]> {
      if (ids.length === 0) return [];
      const rows = await db
        .select({
          assetId: priceHistory.assetId,
          date: priceHistory.date,
          close: priceHistory.close,
        })
        .from(priceHistory)
        .where(inArray(priceHistory.assetId, [...ids]))
        .orderBy(asc(priceHistory.assetId), asc(priceHistory.date));
      return rows
        .map((r) => ({ assetId: r.assetId, date: r.date, close: Number(r.close) }))
        .filter((r) => Number.isFinite(r.close));
    },
  };
}

export type PortfolioRepository = ReturnType<typeof createPortfolioRepository>;
