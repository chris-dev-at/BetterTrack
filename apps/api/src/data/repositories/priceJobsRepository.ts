import { eq, inArray, sql } from 'drizzle-orm';

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
     */
    async upsertDailyCloses(assetId: string, closes: DailyClose[]): Promise<number> {
      if (closes.length === 0) return 0;
      let written = 0;
      for (let i = 0; i < closes.length; i += UPSERT_CHUNK) {
        const chunk = closes.slice(i, i + UPSERT_CHUNK);
        await db
          .insert(priceHistory)
          .values(chunk.map((c) => ({ assetId, date: c.date, close: c.close })))
          .onConflictDoUpdate({
            target: [priceHistory.assetId, priceHistory.date],
            set: { close: sql`excluded.close` },
          });
        written += chunk.length;
      }
      return written;
    },
  };
}

export type PriceJobsRepository = ReturnType<typeof createPriceJobsRepository>;
