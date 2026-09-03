import type { PriceBasis } from '@bettertrack/domain/holdings';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';

import type { Database } from '../db';
import {
  assets,
  conglomeratePositions,
  priceHistory,
  transactions,
  workboardItems,
} from '../schema';
import type { AssetRow } from '../schema';

/**
 * Persistence for the market-data jobs (PROJECTPLAN.md §9): the read queries that
 * decide *which* assets a price job touches, and the idempotent write of daily
 * closes into `price_history`.
 *
 * Unlike {@link AssetRepository}, these queries are **not** user-scoped — the
 * background worker operates over the whole system (every referenced asset, every
 * FX pair), not on behalf of a logged-in user.
 */

/** The asset fields a price job needs to route a provider call and persist the result. */
export interface JobAsset {
  id: string;
  providerId: string;
  providerRef: string;
  type: AssetRow['type'];
  currency: string;
  symbol: string;
}

/** A single daily close to upsert: ISO `YYYY-MM-DD` date + the close as a numeric string. */
export interface DailyClose {
  date: string;
  /** Stored verbatim into `numeric` — full precision, no mid-pipeline rounding (§5.4). */
  close: string;
}

/** The asset columns every job query selects. */
const ASSET_COLUMNS = {
  id: assets.id,
  providerId: assets.providerId,
  providerRef: assets.providerRef,
  type: assets.type,
  currency: assets.currency,
  symbol: assets.symbol,
} as const;

/** Largest batch of rows per upsert statement (well under Postgres' 65535-param cap). */
const UPSERT_CHUNK = 500;

export function createPriceJobsRepository(db: Database) {
  return {
    /**
     * Every asset referenced by any workboard item, conglomerate position, or
     * transaction (§9: "every asset referenced by any
     * workboard/conglomerate/portfolio"). De-duplicated across the three sources.
     */
    async listReferencedAssets(): Promise<JobAsset[]> {
      const [fromWorkboards, fromConglomerates, fromTransactions] = await Promise.all([
        db.select({ id: workboardItems.assetId }).from(workboardItems),
        db.select({ id: conglomeratePositions.assetId }).from(conglomeratePositions),
        db.select({ id: transactions.assetId }).from(transactions),
      ]);
      // Conglomerate rows may be nested-conglomerate constituents (V5-P6,
      // `asset_id IS NULL`) — their leaf assets appear via the child's own
      // rows in the same scan, so nulls are simply dropped here.
      const ids = [
        ...new Set(
          [...fromWorkboards, ...fromConglomerates, ...fromTransactions].flatMap((r) =>
            r.id !== null ? [r.id] : [],
          ),
        ),
      ];
      if (ids.length === 0) return [];
      return db.select(ASSET_COLUMNS).from(assets).where(inArray(assets.id, ids));
    },

    /** Every FX-pair asset (§5.1: "FX pairs are just assets") — the "FX pairs in use". */
    async listFxAssets(): Promise<JobAsset[]> {
      return db.select(ASSET_COLUMNS).from(assets).where(eq(assets.type, 'fx'));
    },

    /** A single asset by id, regardless of owner (the worker is not user-scoped). */
    async findAssetById(id: string): Promise<JobAsset | null> {
      const rows = await db.select(ASSET_COLUMNS).from(assets).where(eq(assets.id, id)).limit(1);
      return rows[0] ?? null;
    },

    /**
     * Upsert daily closes for one asset, idempotent on the `(asset_id, date)`
     * primary key: a re-run overwrites the close with the latest value rather than
     * erroring or duplicating (§9: backfill/refresh must be idempotent). Returns
     * the number of rows written. Callers must pass at most one row per date — a
     * single `ON CONFLICT DO UPDATE` statement cannot touch the same row twice.
     *
     * `basis` travels with the close and is overwritten on conflict alongside it
     * (§16 2026-09-03): a row's basis is a property of the value stored in it,
     * so a re-run that replaces an `adjusted` close with the raw one must
     * relabel the row in the same statement — otherwise the pair would disagree
     * and the value engine would filter on a lie.
     */
    async upsertDailyCloses(
      assetId: string,
      closes: DailyClose[],
      basis: PriceBasis = 'unadjusted',
    ): Promise<number> {
      if (closes.length === 0) return 0;
      let written = 0;
      for (let i = 0; i < closes.length; i += UPSERT_CHUNK) {
        const chunk = closes.slice(i, i + UPSERT_CHUNK);
        await db
          .insert(priceHistory)
          .values(chunk.map((c) => ({ assetId, date: c.date, close: c.close, basis })))
          .onConflictDoUpdate({
            target: [priceHistory.assetId, priceHistory.date],
            set: { close: sql`excluded.close`, basis: sql`excluded.basis` },
          });
        written += chunk.length;
      }
      return written;
    },

    /**
     * Of `assetIds`, those still holding at least one `price_history` row on a
     * basis OTHER than `basis` — the assets whose durable fallback layer is
     * (partly or wholly) invisible to the value engine (§16 2026-09-03).
     *
     * This is the repair trigger, not a diagnostic. Migration `0110` labelled
     * every pre-existing upstream row `adjusted`, and nothing would otherwise
     * rewrite the ones outside the nightly month: `prices.backfill` is only ever
     * enqueued for an asset with NO history at all. Left alone, the fallback
     * would stay permanently empty for every asset that existed before the rule
     * — so on a provider outage the asset would contribute nothing at all,
     * which the curve renders as a silent zero.
     */
    async listAssetsOffBasis(
      assetIds: readonly string[],
      basis: PriceBasis = 'unadjusted',
    ): Promise<string[]> {
      if (assetIds.length === 0) return [];
      const rows = await db
        .selectDistinct({ assetId: priceHistory.assetId })
        .from(priceHistory)
        .where(and(inArray(priceHistory.assetId, [...assetIds]), ne(priceHistory.basis, basis)));
      return rows.map((r) => r.assetId);
    },

    /**
     * Drop one asset's `price_history` rows that are NOT on `basis`, returning
     * how many went. Called only after a successful full-range rewrite: the
     * survivors are dates the provider could not replace, and a row the value
     * engine may never read is not a fallback — keeping it would only make
     * {@link listAssetsOffBasis} re-enqueue the same repair every night.
     *
     * Deleting is safe because these rows are derived market data, re-fetchable
     * from the provider, never user input: custom-asset value marks are on the
     * valuation basis by construction (§5.1) and so are never selected here.
     */
    async deleteOffBasisRows(assetId: string, basis: PriceBasis = 'unadjusted'): Promise<number> {
      const deleted = await db
        .delete(priceHistory)
        .where(and(eq(priceHistory.assetId, assetId), ne(priceHistory.basis, basis)))
        .returning({ date: priceHistory.date });
      return deleted.length;
    },
  };
}

export type PriceJobsRepository = ReturnType<typeof createPriceJobsRepository>;
