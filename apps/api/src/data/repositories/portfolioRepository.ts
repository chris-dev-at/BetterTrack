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

/** A portfolio row for the list / single-portfolio views (§6.8, §7.2). */
export interface PortfolioSummaryRow {
  id: string;
  name: string;
  visibility: 'private' | 'friends';
  sortOrder: number;
  /** True for the auto-created "Main" portfolio (§6.8). */
  isDefault: boolean;
  /** Sticky default funding source for transaction entry (§14, #220). */
  defaultPayFromCash: boolean;
}

/** The default portfolio's canonical name (§5.5). */
const DEFAULT_PORTFOLIO_NAME = 'Main';

function toSummary(
  row: {
    id: string;
    name: string;
    visibility: 'private' | 'friends';
    sortOrder: number;
    defaultPayFromCash: boolean;
  },
  isDefault: boolean,
): PortfolioSummaryRow {
  return {
    id: row.id,
    name: row.name,
    visibility: row.visibility,
    sortOrder: row.sortOrder,
    isDefault,
    defaultPayFromCash: row.defaultPayFromCash,
  };
}

/** The summary column projection reused by every read below. */
const summaryColumns = {
  id: portfolios.id,
  name: portfolios.name,
  visibility: portfolios.visibility,
  sortOrder: portfolios.sortOrder,
  defaultPayFromCash: portfolios.defaultPayFromCash,
} as const;

/**
 * The default portfolio among a user's rows: the lowest `sort_order`, breaking
 * ties on the oldest row (ascending UUIDv7 id ⇒ creation order). Derived from a
 * stable key rather than the name, so renaming the default never changes which
 * row is default (§6.8). Returns null for an empty set.
 */
function pickDefaultId(rows: readonly { id: string; sortOrder: number }[]): string | null {
  let best: { id: string; sortOrder: number } | null = null;
  for (const row of rows) {
    if (
      best === null ||
      row.sortOrder < best.sortOrder ||
      (row.sortOrder === best.sortOrder && row.id < best.id)
    ) {
      best = row;
    }
  }
  return best?.id ?? null;
}

export function createPortfolioRepository(db: Database) {
  /**
   * The user's default portfolio id — resolved from a stable key (lowest
   * `sort_order`, then oldest row by UUIDv7 id), or null when the user has no
   * portfolios yet. Never keys on the name, so a renamed default is still found.
   */
  async function selectDefaultId(userId: string): Promise<string | null> {
    const rows = await db
      .select({ id: portfolios.id })
      .from(portfolios)
      .where(eq(portfolios.userId, userId))
      .orderBy(asc(portfolios.sortOrder), asc(portfolios.id))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  /**
   * The user's default portfolio id, provisioning the auto-created "Main" only
   * when the user has *zero* portfolios. Keying on existence (not the literal
   * name) means a renamed default is returned as-is rather than resurrecting a
   * phantom empty "Main" on the next read (§6.8). Idempotent under concurrency
   * via the `portfolios_user_name_unique` index.
   */
  async function getOrCreateMain(userId: string): Promise<string> {
    const existing = await selectDefaultId(userId);
    if (existing) return existing;
    await db
      .insert(portfolios)
      .values({ userId, name: DEFAULT_PORTFOLIO_NAME })
      .onConflictDoNothing();
    const created = await selectDefaultId(userId);
    if (!created) throw new Error('Default portfolio vanished after upsert');
    return created;
  }

  return {
    /** The id of the user's "Main" portfolio, creating it on first touch. */
    getOrCreateMain,

    /**
     * Provision the default "Main" portfolio at account creation (§5.5): a
     * newly created/invited *user* account starts with exactly one portfolio,
     * while *admin* accounts get none. Idempotent, so re-running the seed or a
     * retried signup never duplicates it.
     */
    createDefault: getOrCreateMain,

    /**
     * Every portfolio a user owns, ordered `sort_order` then name (§6.8, §7.2).
     * V1 returns just the default; additional rows appear here with no code
     * change, which is the whole point of the `portfolio_id`-scoped model.
     */
    async listForUser(userId: string): Promise<PortfolioSummaryRow[]> {
      const rows = await db
        .select(summaryColumns)
        .from(portfolios)
        .where(eq(portfolios.userId, userId))
        .orderBy(asc(portfolios.sortOrder), asc(portfolios.name));
      const defaultId = pickDefaultId(rows);
      return rows.map((row) => toSummary(row, row.id === defaultId));
    },

    /**
     * A single portfolio scoped to its owner (§8): returns null when the id is
     * unknown *or* belongs to another user, so callers 404 without leaking
     * existence — no IDOR by construction.
     */
    async findByIdForUser(
      userId: string,
      portfolioId: string,
    ): Promise<PortfolioSummaryRow | null> {
      const rows = await db
        .select(summaryColumns)
        .from(portfolios)
        .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const defaultId = await selectDefaultId(userId);
      return toSummary(row, row.id === defaultId);
    },

    /**
     * Update a portfolio's mutable fields (name, visibility), scoped to the owner
     * at the DB layer (§8). Returns the updated summary, or null when the id is
     * not one of the caller's own portfolios.
     */
    async updatePortfolio(
      userId: string,
      portfolioId: string,
      patch: { name?: string; visibility?: 'private' | 'friends'; defaultPayFromCash?: boolean },
    ): Promise<PortfolioSummaryRow | null> {
      const set: Partial<{
        name: string;
        visibility: 'private' | 'friends';
        defaultPayFromCash: boolean;
      }> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.visibility !== undefined) set.visibility = patch.visibility;
      if (patch.defaultPayFromCash !== undefined) set.defaultPayFromCash = patch.defaultPayFromCash;

      // Nothing to change — return the current row (still ownership-scoped).
      if (Object.keys(set).length === 0) {
        const rows = await db
          .select(summaryColumns)
          .from(portfolios)
          .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
          .limit(1);
        const row = rows[0];
        if (!row) return null;
        const defaultId = await selectDefaultId(userId);
        return toSummary(row, row.id === defaultId);
      }

      const rows = await db
        .update(portfolios)
        .set(set)
        .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
        .returning(summaryColumns);
      const row = rows[0];
      if (!row) return null;
      const defaultId = await selectDefaultId(userId);
      return toSummary(row, row.id === defaultId);
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
