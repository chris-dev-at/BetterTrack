import { createHash } from 'node:crypto';

import type {
  BacktestBenchmark,
  BacktestPreviewPosition,
  BacktestPreviewRange,
  BacktestResponse,
  BacktestStats as BacktestStatsDto,
  HistoryRange,
  PricePoint as ProviderPricePoint,
} from '@bettertrack/contracts';
import type { Redis } from 'ioredis';

import type { AssetRepository } from '../../data/repositories/assetRepository';
import {
  backtest,
  BacktestError,
  type BacktestAsset,
  type BacktestResult,
  type BacktestStats,
} from '../../domain/backtest';
import { notFound, unprocessable } from '../../errors';
import type { MarketDataService } from '../../providers';
import type { CurrencyService } from '../currency/currencyService';

/**
 * Backtest preview service (PROJECTPLAN.md §6.5, §6.6).
 *
 * Assembles the inputs the pure {@link backtest} engine consumes and shapes its
 * `BacktestResult` into the wire response — it does not do money-math itself
 * (that all lives in the Fable-hardened `domain/backtest.ts`, unchanged here).
 * It exists so the Builder's live-preview panel can backtest an *unsaved* draft
 * basket over inline positions, and so the saved-conglomerate backtest endpoint
 * (a later issue) can reuse the exact same pipeline.
 *
 * The assembly reuses the portfolio-history pattern (§6.9): per-asset daily
 * closes come from {@link MarketDataService.getHistory} (warm `price_history`,
 * cached/coalesced/serve-stale), and EUR conversion routes exclusively through
 * the {@link CurrencyService} historical FX-at-date keystone (§5.4), injected
 * into the engine as its `CurrencyConverter`.
 *
 * Results are memoised in Redis for 1 h keyed by hash(positions+range+benchmark)
 * so slider-wiggling in the Builder stays cheap (§6.6). The key is additionally
 * namespaced by user id: the basket may reference the caller's *custom* assets,
 * whose ids resolve only for their owner (§10), so a shared cache must never let
 * one user read another's memoised preview.
 */

const PREVIEW_TTL_SECONDS = 3600; // 1 h (§6.6).

/** Calendar years back for each finite preview range. */
const RANGE_YEARS: Record<Exclude<BacktestPreviewRange, 'MAX'>, number> = {
  '1Y': 1,
  '3Y': 3,
  '5Y': 5,
};

/**
 * Provider history window to fetch per preview range. Deliberately generous (a
 * 3Y preview pulls the 5Y window) — the engine clips to the requested window,
 * so over-fetching is harmless while under-fetching would silently drop data.
 */
const PROVIDER_RANGE: Record<BacktestPreviewRange, HistoryRange> = {
  '1Y': '1Y',
  '3Y': '5Y',
  '5Y': '5Y',
  MAX: 'MAX',
};

/** Where each benchmark's prices come from + its native currency (§6.6). */
interface BenchmarkSpec {
  providerId: string;
  providerRef: string;
  currency: string;
}
const BENCHMARKS: Record<BacktestBenchmark, BenchmarkSpec> = {
  '^GSPC': { providerId: 'yahoo', providerRef: '^GSPC', currency: 'USD' },
  '^GDAXI': { providerId: 'yahoo', providerRef: '^GDAXI', currency: 'EUR' },
  URTH: { providerId: 'yahoo', providerRef: 'URTH', currency: 'USD' },
};

export interface BacktestPreviewInput {
  positions: BacktestPreviewPosition[];
  range: BacktestPreviewRange;
  benchmark?: BacktestBenchmark | null;
}

export interface BacktestServiceDeps {
  assetRepo: AssetRepository;
  marketData: MarketDataService;
  currencyService: CurrencyService;
  redis: Redis;
  /** Injectable clock (tests); defaults to the wall clock. */
  now?: () => number;
}

export interface BacktestService {
  /** Backtest an inline draft basket for the Builder live preview (§6.5). */
  runPreview(userId: string, input: BacktestPreviewInput): Promise<BacktestResponse>;
}

/**
 * Redis memo key for a preview — hash(positions+range+benchmark), namespaced by
 * user id so a custom-asset basket's result never leaks across users (§10).
 */
export function backtestPreviewCacheKey(userId: string, input: BacktestPreviewInput): string {
  const canonical = JSON.stringify({
    positions: input.positions.map((p) => ({ assetId: p.assetId, weight: p.weight })),
    range: input.range,
    benchmark: input.benchmark ?? null,
  });
  const hash = createHash('sha256').update(canonical).digest('hex');
  return `backtest:preview:${userId}:${hash}`;
}

export function createBacktestService(deps: BacktestServiceDeps): BacktestService {
  const { assetRepo, marketData, currencyService, redis } = deps;
  const now = deps.now ?? Date.now;

  /** Today's UTC calendar day — the last day of every preview window. */
  function todayIso(): string {
    return new Date(now()).toISOString().slice(0, 10);
  }

  /**
   * Daily closes for a provider ref over `range`. Best-effort like the portfolio
   * series: a provider outage past the stale window yields an empty series
   * (surfaced by the caller as a 422, never a 500).
   */
  async function loadDailyCloses(
    ref: { providerId: string; providerRef: string },
    range: HistoryRange,
  ): Promise<Array<{ date: string; close: number }>> {
    let points: readonly ProviderPricePoint[];
    try {
      const cached = await marketData.getHistory(ref, range, '1d');
      points = cached.value;
    } catch {
      points = [];
    }
    return toDailyCloses(points);
  }

  return {
    async runPreview(userId, input) {
      const key = backtestPreviewCacheKey(userId, input);
      const cached = await redis.get(key);
      if (cached) {
        try {
          return JSON.parse(cached) as BacktestResponse;
        } catch {
          // Corrupt entry — fall through and recompute (no history refetch on a hit).
        }
      }

      const providerRange = PROVIDER_RANGE[input.range];

      // 1. Resolve every position asset (ownership-scoped: another user's custom
      //    asset — or a missing id — is a 404, no existence leak §10) and load
      //    its daily closes through the market-data keystone (§5.2/§5.3).
      const assets: BacktestAsset[] = [];
      for (const pos of input.positions) {
        const row = await assetRepo.findByIdForUser(pos.assetId, userId);
        if (!row) throw notFound('Asset not found.', 'ASSET_NOT_FOUND');
        const prices = await loadDailyCloses(
          { providerId: row.providerId, providerRef: row.providerRef },
          providerRange,
        );
        if (prices.length === 0) {
          throw unprocessable(
            `No price history available for ${row.symbol} to backtest.`,
            'NO_PRICE_HISTORY',
          );
        }
        assets.push({ assetId: row.id, symbol: row.symbol, currency: row.currency, prices });
      }

      // 2. Optional benchmark overlay: the same pipeline at weight 100 (§6.6).
      let benchmarkAsset: BacktestAsset | null = null;
      if (input.benchmark) {
        const spec = BENCHMARKS[input.benchmark];
        const prices = await loadDailyCloses(
          { providerId: spec.providerId, providerRef: spec.providerRef },
          providerRange,
        );
        if (prices.length === 0) {
          throw unprocessable(
            `No price history available for benchmark ${input.benchmark}.`,
            'NO_PRICE_HISTORY',
          );
        }
        benchmarkAsset = {
          assetId: input.benchmark,
          symbol: input.benchmark,
          currency: spec.currency,
          prices,
        };
      }

      // 3. Requested window. The end is today; a finite range starts N years back
      //    and the engine clips it up to the common start (emitting the §6.6
      //    notice). MAX has no explicit start, so anchor it at the basket's common
      //    start — otherwise every MAX preview would carry a spurious "Limited by
      //    …" notice for a request that asked for the full overlapping history.
      const end = todayIso();
      const start =
        input.range === 'MAX' ? commonStart(assets) : yearsBefore(end, RANGE_YEARS[input.range]);

      // 4. Run the pure engine, injecting the CurrencyService as the historical
      //    FX-at-date converter (§5.4). Data-state failures (no overlapping
      //    window, a benchmark whose history starts after t₀) surface as a 422
      //    with the engine's message rather than a 500.
      let result: BacktestResult;
      try {
        result = await backtest({
          positions: input.positions.map((p) => ({ assetId: p.assetId, weight: p.weight })),
          assets,
          range: { start, end },
          converter: currencyService,
          baseCurrency: currencyService.baseCurrency,
          benchmark: benchmarkAsset,
        });
      } catch (err) {
        if (err instanceof BacktestError) {
          throw unprocessable(err.message, 'BACKTEST_UNAVAILABLE');
        }
        throw err;
      }

      const response = toResponse(result);
      await redis.set(key, JSON.stringify(response), 'EX', PREVIEW_TTL_SECONDS);
      return response;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collapse a provider price series to one adjusted close per calendar day (last
 * candle of a day wins, mirroring the portfolio series' `mergeDailyPrices`) in
 * the `{ date, close }` shape the engine consumes. Non-finite closes are dropped.
 */
function toDailyCloses(
  points: readonly ProviderPricePoint[],
): Array<{ date: string; close: number }> {
  const byDate = new Map<string, number>();
  for (const p of points) {
    if (!Number.isFinite(p.close)) continue;
    byDate.set(p.time.slice(0, 10), p.close);
  }
  return [...byDate].map(([date, close]) => ({ date, close }));
}

/**
 * The basket's common start: the latest first-available date across assets —
 * the same date the engine derives internally. Used only to anchor a MAX
 * window so it is not reported as "clipped".
 */
function commonStart(assets: readonly BacktestAsset[]): string {
  let start = '';
  for (const a of assets) {
    let earliest = '';
    for (const p of a.prices) {
      if (earliest === '' || p.date < earliest) earliest = p.date;
    }
    if (earliest !== '' && earliest > start) start = earliest;
  }
  return start;
}

/** ISO `YYYY-MM-DD` `years` calendar years before `today` (UTC). */
function yearsBefore(today: string, years: number): string {
  const d = new Date(`${today}T00:00:00.000Z`);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

/** Shape the engine's stats into the wire DTO (a faithful field-for-field mirror). */
function toStats(s: BacktestStats): BacktestStatsDto {
  return {
    totalReturnPct: s.totalReturnPct,
    cagrPct: s.cagrPct,
    maxDrawdownPct: s.maxDrawdownPct,
    volatilityPct: s.volatilityPct,
    bestDay: s.bestDay ? { date: s.bestDay.date, returnPct: s.bestDay.returnPct } : null,
    worstDay: s.worstDay ? { date: s.worstDay.date, returnPct: s.worstDay.returnPct } : null,
  };
}

/** Shape the engine's `BacktestResult` into the `backtestResponseSchema` DTO. */
function toResponse(r: BacktestResult): BacktestResponse {
  return {
    startDate: r.startDate,
    endDate: r.endDate,
    series: r.series.map((p) => ({ date: p.date, value: p.value })),
    stats: toStats(r.stats),
    contributions: r.contributions.map((c) => ({
      assetId: c.assetId,
      symbol: c.symbol,
      weight: c.weight,
      returnPct: c.returnPct,
      contributionPct: c.contributionPct,
    })),
    notice: r.notice,
    benchmark: r.benchmark
      ? {
          assetId: r.benchmark.assetId,
          symbol: r.benchmark.symbol,
          series: r.benchmark.series.map((p) => ({ date: p.date, value: p.value })),
          stats: toStats(r.benchmark.stats),
        }
      : null,
  };
}
