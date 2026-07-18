import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '../db';
import { assets, portfolios, transactions, workboardItems } from '../schema';

/**
 * Read side of the portfolio-level dividend intelligence surfaces (§13.5 V5-P5,
 * arc a). Two aggregations the calendar + projected-income service and the
 * dividend-event scan job consume:
 *
 *  - **held positions** — the net (buy − sell) quantity of each asset a user
 *    currently holds across their *active* (non-archived) portfolios, joined to
 *    the asset's provider ref/currency so the caller can fetch dividend events
 *    without a second lookup. A fully-closed position (net ≤ 0) drops out.
 *  - **watchlist assets** — the distinct assets on any of the user's watchlists,
 *    for the forward calendar's "held OR watched" scope.
 *
 * Everything is strictly `user_id`-scoped through the owning portfolio /
 * watchlist row (§10), except {@link listHeldAssetHoldersAllUsers}, which the
 * background scan job uses to fan out over every user at once.
 */

/** A currently-held position with its asset's provider ref for a dividend fetch. */
export interface HeldPositionRow {
  assetId: string;
  providerId: string;
  providerRef: string;
  symbol: string;
  name: string;
  /** The asset's own quote/trade currency (dividend currency falls back to it). */
  currency: string;
  /** Net held quantity across the user's active portfolios (> 0). */
  quantity: number;
}

/** A watchlisted asset (no quantity — it is only a forward-calendar subject). */
export interface WatchedAssetRow {
  assetId: string;
  providerId: string;
  providerRef: string;
  symbol: string;
  name: string;
  currency: string;
}

/** One (user, asset) holding pair for the fan-out scan job. */
export interface HeldAssetHolderRow {
  userId: string;
  assetId: string;
  providerId: string;
  providerRef: string;
  symbol: string;
  name: string;
  currency: string;
}

export interface MarketIntelRepository {
  listHeldPositionsForUser(userId: string): Promise<HeldPositionRow[]>;
  listWatchlistAssetsForUser(userId: string): Promise<WatchedAssetRow[]>;
  listHeldAssetHoldersAllUsers(): Promise<HeldAssetHolderRow[]>;
}

/** `sum(buy) − sum(sell)` — the net signed quantity a group holds. */
const netQuantitySql = sql<number>`sum(case when ${transactions.side} = 'buy' then ${transactions.quantity} else -${transactions.quantity} end)`;

export function createMarketIntelRepository(db: Database): MarketIntelRepository {
  return {
    async listHeldPositionsForUser(userId) {
      const rows = await db
        .select({
          assetId: transactions.assetId,
          providerId: assets.providerId,
          providerRef: assets.providerRef,
          symbol: assets.symbol,
          name: assets.name,
          currency: assets.currency,
          quantity: netQuantitySql.mapWith(Number),
        })
        .from(transactions)
        .innerJoin(portfolios, eq(transactions.portfolioId, portfolios.id))
        .innerJoin(assets, eq(transactions.assetId, assets.id))
        .where(and(eq(portfolios.userId, userId), isNull(portfolios.archivedAt)))
        .groupBy(
          transactions.assetId,
          assets.providerId,
          assets.providerRef,
          assets.symbol,
          assets.name,
          assets.currency,
        )
        .having(sql`${netQuantitySql} > 0`);
      return rows;
    },

    async listWatchlistAssetsForUser(userId) {
      return db
        .selectDistinct({
          assetId: workboardItems.assetId,
          providerId: assets.providerId,
          providerRef: assets.providerRef,
          symbol: assets.symbol,
          name: assets.name,
          currency: assets.currency,
        })
        .from(workboardItems)
        .innerJoin(assets, eq(workboardItems.assetId, assets.id))
        .where(eq(workboardItems.userId, userId));
    },

    async listHeldAssetHoldersAllUsers() {
      const rows = await db
        .select({
          userId: portfolios.userId,
          assetId: transactions.assetId,
          providerId: assets.providerId,
          providerRef: assets.providerRef,
          symbol: assets.symbol,
          name: assets.name,
          currency: assets.currency,
        })
        .from(transactions)
        .innerJoin(portfolios, eq(transactions.portfolioId, portfolios.id))
        .innerJoin(assets, eq(transactions.assetId, assets.id))
        .where(isNull(portfolios.archivedAt))
        .groupBy(
          portfolios.userId,
          transactions.assetId,
          assets.providerId,
          assets.providerRef,
          assets.symbol,
          assets.name,
          assets.currency,
        )
        .having(sql`${netQuantitySql} > 0`);
      return rows;
    },
  };
}
