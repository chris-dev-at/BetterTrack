import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import type { Database } from '../db';
import { assets, portfolios, transactions, users, workboardItems } from '../schema';

/**
 * Market-intelligence aggregation reads (PROJECTPLAN.md §13.5 V5-P5).
 *
 * The **earnings** surfaces (arc b) need "every asset a user holds or watches",
 * resolved to a provider ref so the provider/cache keystone can be asked for its
 * earnings: one user's book (the Workboard panel endpoint) and every user's book
 * at once (the reminder scan job). "Held" is a **net-positive** position —
 * SUM(buy − sell) > 0 — so a fully-closed position drops out; "watched" is any
 * workboard item; an asset can be both (flags are independent).
 *
 * The **dividend** surfaces (arc a) need finer shapes: the held position's net
 * quantity + the asset's currency (for the projected-income math), the watchlist
 * assets on their own (the "held OR watched" forward calendar), and every
 * (user, asset) holding pair for the dividend-event scan job to fan out over.
 *
 * All reads are strictly owner-scoped through `portfolios.user_id` /
 * `workboard_items.user_id`, except {@link listAllWatchAndHoldAssets} /
 * {@link listHeldAssetHoldersAllUsers}, which the background scan jobs use to
 * fan out over every user at once.
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

/** One (user, asset) holding pair for the fan-out dividend-event scan job. */
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
  /** Held (net > 0) + watched assets for one user, deduped by asset (earnings). */
  listUserWatchAndHoldAssets(userId: string): Promise<UserIntelAsset[]>;
  /**
   * GLOBAL watchlisted assets for one user, without touching portfolio
   * transactions and without reading any account-owned (custom) asset row —
   * the unguarded/paranoid earnings branch. A custom asset's symbol, name and
   * provider ref are that account's own content, so they are never selected
   * here; the guarded branch reads them through
   * {@link listUserWatchAndHoldAssets} instead.
   */
  listUserWatchAssets(userId: string): Promise<UserIntelAsset[]>;
  /** Held + watched assets across EVERY user, tagged with the owner (earnings). */
  listAllWatchAndHoldAssets(): Promise<UserIntelAssetWithUser[]>;
  /**
   * GLOBAL watchlisted assets across every user — the scan job's unguarded
   * first pass. Account-owned (custom) assets are excluded for the same
   * provenance reason as {@link listUserWatchAssets}; the job picks them up
   * per user inside that account's transition lock.
   */
  listAllWatchAssets(): Promise<UserIntelAssetWithUser[]>;
  /** Active normal user ids; holding jobs lock each id before reading transactions. */
  listNormalUserIds(): Promise<string[]>;
  /** Net-held positions (qty + currency) for one user's active portfolios (dividends). */
  listHeldPositionsForUser(userId: string): Promise<HeldPositionRow[]>;
  /** Distinct watchlist assets for one user (dividend forward calendar). */
  listWatchlistAssetsForUser(userId: string): Promise<WatchedAssetRow[]>;
  /** Every (user, held-asset) pair across all users (dividend-event scan job). */
  listHeldAssetHoldersAllUsers(): Promise<HeldAssetHolderRow[]>;
  /** One normal user's holding pairs; callers hold that user's transition lock. */
  listHeldAssetHoldersForUser(userId: string): Promise<HeldAssetHolderRow[]>;
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
        .where(and(eq(portfolios.userId, userId), isNull(portfolios.vaultId)))
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

    async listUserWatchAssets(userId) {
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
        .where(and(eq(workboardItems.userId, userId), isNull(assets.ownerId)))
        .groupBy(assets.id, assets.symbol, assets.name, assets.providerId, assets.providerRef);
      return merge([], watched);
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
        .where(isNull(portfolios.vaultId))
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

    async listAllWatchAssets() {
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
        .innerJoin(assets, eq(workboardItems.assetId, assets.id))
        .where(isNull(assets.ownerId))
        .groupBy(
          workboardItems.userId,
          assets.id,
          assets.symbol,
          assets.name,
          assets.providerId,
          assets.providerRef,
        );
      return watched.map((row) => ({ ...row, held: false, watched: true }));
    },

    async listNormalUserIds() {
      return db
        .select({ id: users.id })
        .from(users)
        .where(
          and(eq(users.role, 'user'), eq(users.status, 'active'), eq(users.privacyMode, 'normal')),
        )
        .then((rows) => rows.map((row) => row.id));
    },

    async listHeldPositionsForUser(userId) {
      const rows = await db
        .select({
          assetId: transactions.assetId,
          providerId: assets.providerId,
          providerRef: assets.providerRef,
          symbol: assets.symbol,
          name: assets.name,
          currency: assets.currency,
          quantity: signedQuantity.mapWith(Number),
        })
        .from(transactions)
        .innerJoin(portfolios, eq(transactions.portfolioId, portfolios.id))
        .innerJoin(assets, eq(transactions.assetId, assets.id))
        .where(
          and(
            eq(portfolios.userId, userId),
            isNull(portfolios.archivedAt),
            isNull(portfolios.vaultId),
          ),
        )
        .groupBy(
          transactions.assetId,
          assets.providerId,
          assets.providerRef,
          assets.symbol,
          assets.name,
          assets.currency,
        )
        .having(gt(signedQuantity, sql`0`));
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
        .where(and(isNull(portfolios.archivedAt), isNull(portfolios.vaultId)))
        .groupBy(
          portfolios.userId,
          transactions.assetId,
          assets.providerId,
          assets.providerRef,
          assets.symbol,
          assets.name,
          assets.currency,
        )
        .having(gt(signedQuantity, sql`0`));
      return rows;
    },

    async listHeldAssetHoldersForUser(userId) {
      return db
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
        .where(
          and(
            eq(portfolios.userId, userId),
            isNull(portfolios.archivedAt),
            isNull(portfolios.vaultId),
          ),
        )
        .groupBy(
          portfolios.userId,
          transactions.assetId,
          assets.providerId,
          assets.providerRef,
          assets.symbol,
          assets.name,
          assets.currency,
        )
        .having(gt(signedQuantity, sql`0`));
    },
  };
}
