import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';

import { PORTFOLIO_KINDS, type PortfolioKind } from '@bettertrack/contracts';
import { VALUATION_PRICE_BASIS, type PriceBasis } from '@bettertrack/domain/holdings';

import type { Database } from '../db';
import { lockPortfolioMutationInTransaction } from './cashMovementRepository';
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
  /**
   * Which price basis {@link close} is on (§16 2026-09-03). The value engine
   * merges only rows matching the basis it is building, so a legacy adjusted row
   * outside the nightly heal window can never land in an unadjusted series.
   */
  basis: PriceBasis;
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
  /** ISO-8601 archive timestamp, or null while active (§13.2 V2-P8). */
  archivedAt: string | null;
  /** Purpose category ("Icon"), or null when the user never chose (board #69). */
  kind: PortfolioKind | null;
  /** Non-null means this is a content-free locked vault stub (paranoid E2). */
  vaultId: string | null;
  /** Cleartext locked-stub label; null on plain portfolios. */
  vaultAlias: string | null;
}

/** The default portfolio's canonical name (§5.5). */
const DEFAULT_PORTFOLIO_NAME = 'Main';

const KIND_TOKENS: ReadonlySet<string> = new Set(PORTFOLIO_KINDS);

/**
 * Narrow the bare-text `kind` column back onto the contract's token set. The
 * column carries no pg enum and no CHECK (see the schema comment), so a value
 * written by anything other than the validated service path — a hand-run SQL
 * fix, a restored dump, a kind retired from a later release — must degrade to
 * "unclassified" here rather than escape as an unparseable DTO and 500 a whole
 * portfolio list on the way out.
 */
function toKind(value: string | null): PortfolioKind | null {
  return value !== null && KIND_TOKENS.has(value) ? (value as PortfolioKind) : null;
}

function toSummary(
  row: {
    id: string;
    name: string;
    visibility: 'private' | 'friends';
    sortOrder: number;
    defaultPayFromCash: boolean;
    archivedAt: Date | string | null;
    kind: string | null;
    vaultId: string | null;
    vaultAlias: string | null;
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
    archivedAt: row.archivedAt ? new Date(row.archivedAt).toISOString() : null,
    kind: toKind(row.kind),
    vaultId: row.vaultId,
    vaultAlias: row.vaultAlias,
  };
}

/** The summary column projection reused by every read below. */
const summaryColumns = {
  id: portfolios.id,
  name: portfolios.name,
  visibility: portfolios.visibility,
  sortOrder: portfolios.sortOrder,
  defaultPayFromCash: portfolios.defaultPayFromCash,
  archivedAt: portfolios.archivedAt,
  kind: portfolios.kind,
  vaultId: portfolios.vaultId,
  vaultAlias: portfolios.vaultAlias,
} as const;

/**
 * The default portfolio among a user's rows: the lowest `sort_order`, breaking
 * ties on the oldest row (ascending UUIDv7 id ⇒ creation order). Derived from a
 * stable key rather than the name, so renaming the default never changes which
 * row is default (§6.8). Only *active* (non-archived) rows are eligible — an
 * archived portfolio is never the default (§13.2 V2-P8). Returns null when the
 * user has no active rows.
 */
function pickDefaultId(
  rows: readonly { id: string; sortOrder: number; archivedAt: Date | string | null }[],
): string | null {
  let best: { id: string; sortOrder: number } | null = null;
  for (const row of rows) {
    if (row.archivedAt) continue;
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
   * `sort_order`, then oldest row by UUIDv7 id) among *active* rows, or null
   * when the user has no active portfolios yet. Never keys on the name, so a
   * renamed default is still found; never returns an archived row (§13.2 V2-P8).
   */
  async function selectDefaultId(userId: string): Promise<string | null> {
    const rows = await db
      .select({ id: portfolios.id })
      .from(portfolios)
      .where(and(eq(portfolios.userId, userId), isNull(portfolios.archivedAt)))
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
     * Archived portfolios are excluded unless `includeArchived` is set (§13.2
     * V2-P8). `isDefault` is always computed from the *active* set, so an
     * archived row (when included) is never marked default.
     */
    async listForUser(
      userId: string,
      opts: { includeArchived?: boolean } = {},
    ): Promise<PortfolioSummaryRow[]> {
      const where = opts.includeArchived
        ? eq(portfolios.userId, userId)
        : and(eq(portfolios.userId, userId), isNull(portfolios.archivedAt));
      const rows = await db
        .select(summaryColumns)
        .from(portfolios)
        .where(where)
        .orderBy(asc(portfolios.sortOrder), asc(portfolios.name));
      const defaultId = pickDefaultId(rows);
      return rows.map((row) => toSummary(row, row.id === defaultId));
    },

    /** Count of the user's *active* (non-archived) portfolios (§13.2 V2-P8). */
    async countActive(userId: string): Promise<number> {
      const rows = await db
        .select({ n: count() })
        .from(portfolios)
        .where(and(eq(portfolios.userId, userId), isNull(portfolios.archivedAt)));
      return Number(rows[0]?.n ?? 0);
    },

    /**
     * Whether the user already owns a *different* portfolio with this exact name
     * (§13.2 V2-P8). Checks *all* rows — the `portfolios_user_name_unique` index
     * spans archived rows too — so create/rename can 4xx cleanly before hitting
     * the DB constraint. Pass `excludeId` when renaming so a portfolio keeping its
     * own name (or a no-op re-save) is not treated as a collision with itself.
     */
    async nameExists(userId: string, name: string, excludeId?: string): Promise<boolean> {
      const rows = await db
        .select({ id: portfolios.id })
        .from(portfolios)
        .where(
          and(
            eq(portfolios.userId, userId),
            eq(portfolios.name, name),
            ...(excludeId ? [ne(portfolios.id, excludeId)] : []),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    /**
     * Create a named portfolio (§13.2 V2-P8). New rows take the next
     * `sort_order` above the user's current max, so the auto-created "Main"
     * (sort_order 0) stays the default until the user explicitly changes it.
     */
    async createPortfolio(
      userId: string,
      name: string,
      visibility: 'private' | 'friends' = 'private',
      kind: PortfolioKind | null = null,
    ): Promise<PortfolioSummaryRow> {
      const [maxRow] = await db
        .select({ sortOrder: portfolios.sortOrder })
        .from(portfolios)
        .where(eq(portfolios.userId, userId))
        .orderBy(desc(portfolios.sortOrder))
        .limit(1);
      const nextSortOrder = (maxRow?.sortOrder ?? -1) + 1;
      const [row] = await db
        .insert(portfolios)
        .values({ userId, name, sortOrder: nextSortOrder, visibility, kind })
        .returning(summaryColumns);
      if (!row) throw new Error('Portfolio insert returned no row');
      // A freshly created portfolio can never be the default (Main outranks it).
      return toSummary(row, false);
    },

    /**
     * Soft-archive an owned, currently-active portfolio (§13.2 V2-P8). Scoped to
     * the owner at the DB layer (§8); the `IS NULL` guard makes re-archiving a
     * no-op that returns null. Returns null when the id is unknown, another
     * user's, or already archived.
     */
    async archivePortfolio(
      userId: string,
      portfolioId: string,
      archivedAt: Date,
    ): Promise<PortfolioSummaryRow | null> {
      return db.transaction(async (tx) => {
        // Standing-order execution takes this same lock across its final active
        // check, claim and money write. Whichever transition acquires it first
        // defines the boundary; no booking can commit after archival.
        await lockPortfolioMutationInTransaction(tx, portfolioId);
        const rows = await tx
          .update(portfolios)
          .set({ archivedAt })
          .where(
            and(
              eq(portfolios.id, portfolioId),
              eq(portfolios.userId, userId),
              isNull(portfolios.archivedAt),
            ),
          )
          .returning(summaryColumns);
        const row = rows[0];
        if (!row) return null;
        // Archived → never the default.
        return toSummary(row, false);
      });
    },

    /**
     * Restore an owned, currently-archived portfolio (§13.2 V2-P8). Returns null
     * when the id is unknown, another user's, or already active.
     *
     * Deliberately takes NO portfolio mutation lock, unlike `archivePortfolio`
     * above. The load-bearing invariant lives one layer up:
     * `portfolioService.restore` calls
     * `standingOrders.skipDuePeriodsForPortfolioRestore` BEFORE this UPDATE, so
     * every elapsed period is already durably claimed and each order's
     * watermark advanced while the row is still archived (and thus invisible to
     * the scanner's `listActive`). A stale pre-archive worker that resumes
     * after this flip is rejected by the watermark recheck inside
     * `withActivePortfolioLock`/`claimPeriod` — not by this transition. Do not
     * call this method on any path that has not pre-claimed those watermarks.
     */
    async restorePortfolio(
      userId: string,
      portfolioId: string,
    ): Promise<PortfolioSummaryRow | null> {
      const rows = await db
        .update(portfolios)
        .set({ archivedAt: null })
        .where(
          and(
            eq(portfolios.id, portfolioId),
            eq(portfolios.userId, userId),
            isNotNull(portfolios.archivedAt), // archived only
          ),
        )
        .returning(summaryColumns);
      const row = rows[0];
      if (!row) return null;
      const defaultId = await selectDefaultId(userId);
      return toSummary(row, row.id === defaultId);
    },

    /**
     * Hard-delete an owned portfolio and everything the schema cascades with it
     * (portfolio hard-delete, beside soft-archive §13.2). `transactions`,
     * `portfolio_cash_sources`, `dividends` and `portfolio_cash_movements` all
     * carry `ON DELETE CASCADE` on `portfolio_id`, so this single ownership-scoped
     * DELETE removes the entire dependent-row graph in one statement (the
     * `source_id`/`counterpart_source_id` `NO ACTION` FKs resolve because every
     * referencing movement/dividend is deleted in the same statement — the design
     * the `dividends`/`portfolio_cash_movements` schema comments describe).
     *
     * Scoped to the owner at the DB layer (§8): a foreign/unknown id deletes
     * nothing and returns false, so the caller 404s without leaking existence — no
     * IDOR, never a 403. Polymorphic bare-ref rows that carry NO FK to the
     * portfolio (the sharing audience + its public links) are cleared by the
     * service after this returns, mirroring conglomerate/watchlist deletion.
     */
    async deletePortfolio(userId: string, portfolioId: string): Promise<boolean> {
      const rows = await db
        .delete(portfolios)
        .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
        .returning({ id: portfolios.id });
      return rows.length > 0;
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
     * Update a portfolio's mutable fields (name, visibility, kind), scoped to the
     * owner at the DB layer (§8). Returns the updated summary, or null when the id
     * is not one of the caller's own portfolios.
     */
    async updatePortfolio(
      userId: string,
      portfolioId: string,
      patch: {
        name?: string;
        visibility?: 'private' | 'friends';
        defaultPayFromCash?: boolean;
        kind?: PortfolioKind;
      },
    ): Promise<PortfolioSummaryRow | null> {
      const set: Partial<{
        name: string;
        visibility: 'private' | 'friends';
        defaultPayFromCash: boolean;
        kind: PortfolioKind;
      }> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.visibility !== undefined) set.visibility = patch.visibility;
      if (patch.defaultPayFromCash !== undefined) set.defaultPayFromCash = patch.defaultPayFromCash;
      if (patch.kind !== undefined) set.kind = patch.kind;

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
          basis: priceHistory.basis,
        })
        .from(priceHistory)
        .where(inArray(priceHistory.assetId, [...ids]))
        .orderBy(asc(priceHistory.assetId), asc(priceHistory.date));
      return rows
        .map((r): AssetPriceRow => {
          // An unrecognised label is treated as `adjusted`, i.e. NOT usable for
          // valuation: unknown provenance must fail closed on the money path.
          const basis: PriceBasis = r.basis === 'unadjusted' ? 'unadjusted' : 'adjusted';
          return { assetId: r.assetId, date: r.date, close: Number(r.close), basis };
        })
        .filter((r) => Number.isFinite(r.close));
    },

    /**
     * Each asset's LATEST stored close/value point (issue #553): the snapshot
     * read path's fallback price for the fresh "today" point when the live
     * quote is unavailable — mirroring how the value engine would carry the
     * last known close forward.
     *
     * Restricted to the valuation basis (§16 2026-09-03): this price is
     * multiplied by an as-transacted quantity exactly like every point of the
     * series, so an adjusted row would put the LAST point of the curve on a
     * different basis from the rest. An asset with no row on that basis is
     * simply absent, and the caller carries yesterday's value forward instead.
     */
    async latestClosesForAssets(ids: readonly string[]): Promise<Map<string, number>> {
      if (ids.length === 0) return new Map();
      const rows = await db
        .selectDistinctOn([priceHistory.assetId], {
          assetId: priceHistory.assetId,
          close: priceHistory.close,
        })
        .from(priceHistory)
        .where(
          and(
            inArray(priceHistory.assetId, [...ids]),
            eq(priceHistory.basis, VALUATION_PRICE_BASIS),
          ),
        )
        .orderBy(asc(priceHistory.assetId), desc(priceHistory.date));
      const latest = new Map<string, number>();
      for (const row of rows) {
        const close = Number(row.close);
        if (Number.isFinite(close)) latest.set(row.assetId, close);
      }
      return latest;
    },
  };
}

export type PortfolioRepository = ReturnType<typeof createPortfolioRepository>;
