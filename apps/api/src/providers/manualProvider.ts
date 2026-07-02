import type {
  AssetMeta,
  AssetRef,
  AssetSearchResult,
  HistoryInterval,
  HistoryRange,
  PricePoint,
  Quote,
} from '@bettertrack/contracts';
import { and, asc, eq } from 'drizzle-orm';

import type { Database } from '../data/db';
import { assets, priceHistory } from '../data/schema';
import { notFound } from '../errors';

import type { AssetProvider } from './AssetProvider';
import { rangeStartMs } from './historyWindow';

/**
 * The `manual` provider for custom investments (PROJECTPLAN.md §5.1). A custom
 * asset's value points live in the same `price_history` table as market closes,
 * so a house and a stock look identical to the rest of the system — portfolio
 * charts, totals and P/L need zero special-casing.
 *
 * Routing key contract: because {@link AssetRef} carries no owner, a manual
 * asset's `providerRef` must be globally unique (it is the asset row's id), so
 * `findAsset(providerRef)` resolves to exactly one row.
 */

const PROVIDER_ID = 'manual';

export interface ManualAssetRecord {
  id: string;
  symbol: string;
  name: string;
  exchange: string | null;
  currency: string;
  type: AssetMeta['type'];
}

/** One stored value point of a custom asset: a value on a calendar day. */
export interface ManualValuePoint {
  /** ISO `YYYY-MM-DD`. */
  date: string;
  value: number;
}

/**
 * Data the manual provider needs, behind an interface so the provider is
 * unit-testable without a database. {@link createManualAssetSource} is the
 * Drizzle-backed implementation.
 */
export interface ManualAssetSource {
  /** The custom asset for this ref, or null if none exists. */
  findAsset(providerRef: string): Promise<ManualAssetRecord | null>;
  /** Value points for an asset, ascending by date. */
  valuePoints(assetId: string): Promise<ManualValuePoint[]>;
}

/** Drizzle-backed {@link ManualAssetSource} over `assets` + `price_history` (§5.5). */
export function createManualAssetSource(db: Database): ManualAssetSource {
  return {
    async findAsset(providerRef) {
      const rows = await db
        .select({
          id: assets.id,
          symbol: assets.symbol,
          name: assets.name,
          exchange: assets.exchange,
          currency: assets.currency,
          type: assets.type,
        })
        .from(assets)
        .where(and(eq(assets.providerId, PROVIDER_ID), eq(assets.providerRef, providerRef)))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        symbol: row.symbol,
        name: row.name,
        exchange: row.exchange ?? null,
        currency: row.currency,
        type: row.type,
      };
    },

    async valuePoints(assetId) {
      const rows = await db
        .select({ date: priceHistory.date, close: priceHistory.close })
        .from(priceHistory)
        .where(eq(priceHistory.assetId, assetId))
        .orderBy(asc(priceHistory.date));
      return rows
        .map((r) => ({ date: r.date, value: Number(r.close) }))
        .filter((p) => Number.isFinite(p.value));
    },
  };
}

export interface CreateManualProviderDeps {
  source: ManualAssetSource;
  /** Injectable clock (tests) used to derive history windows. */
  now?: () => number;
}

/** Epoch ms at UTC midnight of a `YYYY-MM-DD` day. */
function dayStartMs(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

/** ISO-8601 timestamp at UTC midnight of a `YYYY-MM-DD` day. */
function dayIso(date: string): string {
  return `${date}T00:00:00.000Z`;
}

export function createManualProvider(deps: CreateManualProviderDeps): AssetProvider {
  const { source } = deps;
  const now = deps.now ?? Date.now;

  async function requireAsset(ref: AssetRef): Promise<ManualAssetRecord> {
    const asset = await source.findAsset(ref.providerRef);
    if (!asset) {
      throw notFound(`No custom asset for ref "${ref.providerRef}".`, 'MANUAL_ASSET_NOT_FOUND');
    }
    return asset;
  }

  async function search(_query: string): Promise<AssetSearchResult[]> {
    // Custom assets are private to their owner and folded into search results by
    // the search service with the correct user scope (§6.2). The provider
    // abstraction has no user context, so it adds nothing to the fan-out.
    return [];
  }

  async function getQuote(ref: AssetRef): Promise<Quote> {
    const asset = await requireAsset(ref);
    const points = await source.valuePoints(asset.id);
    const latest = points.at(-1);
    if (!latest) {
      throw notFound(
        `Custom asset "${ref.providerRef}" has no value points.`,
        'MANUAL_ASSET_EMPTY',
      );
    }
    // The latest value point IS the quote (§5.1). A custom asset has no
    // meaningful intraday reference, so prevClose / dayChangePct are null rather
    // than a fabricated day move.
    return {
      price: latest.value,
      currency: asset.currency,
      prevClose: null,
      dayChangePct: null,
      asOf: dayIso(latest.date),
    };
  }

  async function getHistory(
    ref: AssetRef,
    range: HistoryRange,
    _interval: HistoryInterval,
  ): Promise<PricePoint[]> {
    const asset = await requireAsset(ref);
    const points = await source.valuePoints(asset.id);
    if (points.length === 0) return [];

    const end = now();
    const startMs = rangeStartMs(end, range);

    // Source rows are ascending by date, so this preserves order.
    const enriched = points
      .map((p) => ({ ms: dayStartMs(p.date), date: p.date, value: p.value }))
      .filter((p) => !Number.isNaN(p.ms) && p.ms <= end);

    let carried: { value: number } | null = null;
    const within: Array<{ ms: number; date: string; value: number }> = [];
    for (const p of enriched) {
      if (p.ms < startMs) carried = p;
      else within.push(p);
    }

    const series: PricePoint[] = [];
    // Carry-forward (step, §5.1): if the asset already had a value before the
    // window opened, begin the series flat at that value so a chart/backtest
    // sees a continuous line instead of an empty left edge.
    const first = within[0];
    if (carried && (!first || first.ms > startMs)) {
      series.push({ time: new Date(startMs).toISOString(), close: carried.value });
    }
    for (const p of within) series.push({ time: dayIso(p.date), close: p.value });
    return series;
  }

  async function getMeta(ref: AssetRef): Promise<AssetMeta> {
    const asset = await requireAsset(ref);
    return {
      providerId: PROVIDER_ID,
      providerRef: ref.providerRef,
      symbol: asset.symbol,
      name: asset.name,
      exchange: asset.exchange,
      currency: asset.currency,
      type: asset.type,
    };
  }

  // `local: true`: values live in our own DB, so the market-data service skips
  // the §5.3 TTL/negative caching — an edited value point is visible immediately.
  return { id: PROVIDER_ID, local: true, search, getQuote, getHistory, getMeta };
}
