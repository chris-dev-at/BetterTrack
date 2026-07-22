import { createHash } from 'node:crypto';

import type {
  BacktestBenchmark,
  BacktestBenchmarkInput,
  BacktestBenchmarkKind,
  BacktestBenchmarkResult,
  BacktestComparisonResponse,
  BacktestMode,
  BacktestPreviewPosition,
  BacktestPreviewRange,
  BacktestResponse,
  BacktestStats as BacktestStatsDto,
  ComparisonMetrics,
  HistoryRange,
  PricePoint as ProviderPricePoint,
  RebalanceFrequency,
} from '@bettertrack/contracts';
import type { Redis } from 'ioredis';

import type { AssetRepository } from '../../data/repositories/assetRepository';
import type {
  ConglomerateConstituentRow,
  ConglomerateRepository,
} from '../../data/repositories/conglomerateRepository';
import {
  backtest,
  BacktestError,
  type BacktestAsset,
  type BacktestResult,
  type BacktestStats,
} from '../../domain/backtest';
import { compareSeriesStats } from '../../domain/seriesStats';
import { notFound, unprocessable } from '../../errors';
import type { MarketDataService } from '../../providers';
import { flattenConglomerate } from '../conglomerate/nesting';
import { FxRateUnavailableError, type CurrencyService } from '../currency/currencyService';

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
 * The optional benchmark (V4-P7) — a one-click preset, any catalog asset, or
 * one of the caller's own conglomerates — is a SECOND run of the same engine
 * over the primary's effective window with the same base currency,
 * late-listing mode and rebalance schedule, so its full stat set is
 * apples-to-apples with the primary basket by construction.
 *
 * Results are memoised in Redis for 1 h keyed by hash(positions+range+benchmark)
 * so slider-wiggling in the Builder stays cheap (§6.6). The key is additionally
 * namespaced by user id: the basket may reference the caller's *custom* assets
 * and conglomerates, whose ids resolve only for their owner (§10), so a shared
 * cache must never let one user read another's memoised preview.
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

/**
 * Where each one-click preset's prices come from + its native currency (§6.6).
 * Since V4-P7 a preset is sugar over the catalog: it resolves to its catalog
 * asset when seeded, and this spec is only the fallback identity for an
 * unseeded catalog.
 */
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
  /** Benchmark choice (V4-P7): exactly one of preset / catalog asset / own conglomerate. */
  benchmark?: BacktestBenchmarkInput | null;
  /** Late-listing mode (§14); defaults to `clip` (the pre-§14 behavior). */
  mode?: BacktestMode;
  /** Rebalance schedule (V4-P7); defaults to `none` (buy-and-hold, today's behavior). */
  rebalance?: RebalanceFrequency;
}

/**
 * N-way conglomerate comparison input (§13.5 V5-P6): a set of the caller's own
 * conglomerate ids (2–6, contract-capped) plus the same window/late-listing/
 * rebalance knobs a single backtest takes. The FIRST id is the primary — its
 * effective window is the shared axis every other series runs over (exactly as
 * a V4-P7 benchmark runs over the primary basket's window). `baselineId`
 * (default: the first id) chooses the delta reference only.
 */
export interface BacktestComparisonInput {
  conglomerateIds: string[];
  range: BacktestPreviewRange;
  mode?: BacktestMode;
  rebalance?: RebalanceFrequency;
  baselineId?: string;
}

/**
 * Shared-conglomerate what-if sandbox input (§13.5 V5-P6 arc c): the shared
 * conglomerate the viewer is looking at plus their locally-tweaked TOP-LEVEL
 * weights keyed by each asset constituent's `assetId`. Same window/late-listing/
 * rebalance knobs a single preview takes; no benchmark and no nested tweaking
 * (recursive re-weighting is #592, out of scope here).
 */
export interface BacktestSharedSandboxInput {
  conglomerateId: string;
  positions: Array<{ id: string; weight: number }>;
  range: BacktestPreviewRange;
  mode?: BacktestMode;
  rebalance?: RebalanceFrequency;
}

export interface BacktestServiceDeps {
  assetRepo: AssetRepository;
  conglomerateRepo: ConglomerateRepository;
  marketData: MarketDataService;
  currencyService: CurrencyService;
  redis: Redis;
  /**
   * Share-read authorization for the V5-P6 sandbox (arc c) — the SAME guard the
   * read-only shared conglomerate view uses (the §6.9 audience model): resolves
   * the owner when the viewer may see the basket, else `undefined` (→ 404).
   * Optional so the pure preview/compare paths construct without the social
   * layer; {@link BacktestService.runSharedSandboxPreview} 404s when it is absent.
   */
  authorizeConglomerateRead?: (
    viewerId: string,
    conglomerateId: string,
  ) => Promise<{ ownerId: string } | undefined>;
  /** Injectable clock (tests); defaults to the wall clock. */
  now?: () => number;
}

/** A benchmark resolved to a runnable basket plus its wire identity (V4-P7). */
interface ResolvedBenchmark {
  kind: BacktestBenchmarkKind;
  refId: string;
  label: string;
  positions: Array<{ assetId: string; weight: number }>;
  assets: BacktestAsset[];
}

/** One of the caller's conglomerates resolved to a runnable basket (V4-P7 / V5-P6). */
interface ResolvedConglomerateBasket {
  id: string;
  name: string;
  positions: Array<{ assetId: string; weight: number }>;
  assets: BacktestAsset[];
}

export interface BacktestService {
  /**
   * Backtest an inline draft basket for the Builder live preview (§6.5),
   * computed in `opts.baseCurrency` (the caller's per-user base, §5.4/V3-P10d;
   * EUR when omitted). The base changes the *result*, not just labels — a USD
   * investor's return on a EUR-priced asset carries the FX leg.
   */
  runPreview(
    userId: string,
    input: BacktestPreviewInput,
    opts?: { baseCurrency?: string },
  ): Promise<BacktestResponse>;

  /**
   * Compare 2–6 of the caller's own conglomerates on one shared window (§13.5
   * V5-P6): each is run through the same engine as the primary (the first id),
   * so every series' stats are apples-to-apples, and the response carries each
   * series' base-100 curve, full stats and per-metric deltas vs `baselineId`.
   * A conglomerate whose history does not cover the primary's window is a 422,
   * the same outcome the V4-P7 overlay produced for a short benchmark.
   */
  runComparison(
    userId: string,
    input: BacktestComparisonInput,
    opts?: { baseCurrency?: string },
  ): Promise<BacktestComparisonResponse>;

  /**
   * Backtest a FRIEND-SHARED conglomerate with the viewer's local weight tweaks
   * for the read-only "what-if" sandbox (§13.5 V5-P6 arc c). Authorized through
   * the exact same share guard the shared view uses (`authorizeConglomerateRead`)
   * — an unauthorized viewer gets a 404, never data. The tweak set is pinned to
   * the shared basket's real asset constituents (a foreign / missing id is a
   * 422), and every constituent is resolved as a PUBLIC catalog asset: a private
   * custom asset (its manual valuations are absent from the share) and a nested
   * child (arc-c tweaks no recursion) both make the basket un-sandboxable (422),
   * so the curve leaks nothing beyond the share's existing exposure. Purely a
   * read: no state is ever written. `reset to shared` is just this call with the
   * original weights, so it reproduces the shared curve exactly.
   */
  runSharedSandboxPreview(
    viewerId: string,
    input: BacktestSharedSandboxInput,
    opts?: { baseCurrency?: string },
  ): Promise<BacktestResponse>;
}

/**
 * Redis memo key for a preview —
 * hash(positions+range+benchmark+mode+rebalance+base), namespaced by user id so
 * a custom-asset basket's result never leaks across users (§10). The mode is
 * normalised to `clip` and the rebalance frequency to `none` so an omitted
 * field and its explicit default share one memo entry — and two different
 * modes or frequencies never collide. The base currency is part of the
 * identity (V3-P10d): the same basket backtested in USD is a different result,
 * not a different rendering.
 */
export function backtestPreviewCacheKey(
  userId: string,
  input: BacktestPreviewInput,
  baseCurrency: string,
): string {
  const canonical = JSON.stringify({
    positions: input.positions.map((p) => ({ assetId: p.assetId, weight: p.weight })),
    range: input.range,
    benchmark: input.benchmark ?? null,
    mode: input.mode ?? 'clip',
    rebalance: input.rebalance ?? 'none',
    baseCurrency,
  });
  const hash = createHash('sha256').update(canonical).digest('hex');
  return `backtest:preview:${userId}:${hash}`;
}

/**
 * Redis memo key for a comparison's **baseline-independent core** (the per-series
 * backtests) — hash(orderedIds+range+mode+rebalance+base), namespaced by user id
 * (§10). `baselineId` is deliberately NOT part of the key: it only selects the
 * delta reference, so re-picking it hits the same cached backtests and just
 * re-runs the cheap delta math. The id order IS part of the key — the first id
 * defines the shared window, so `[A,B]` and `[B,A]` are different comparisons.
 */
export function backtestComparisonCacheKey(
  userId: string,
  input: BacktestComparisonInput,
  baseCurrency: string,
): string {
  const canonical = JSON.stringify({
    conglomerateIds: input.conglomerateIds,
    range: input.range,
    mode: input.mode ?? 'clip',
    rebalance: input.rebalance ?? 'none',
    baseCurrency,
  });
  const hash = createHash('sha256').update(canonical).digest('hex');
  return `backtest:compare:${userId}:${hash}`;
}

export function createBacktestService(deps: BacktestServiceDeps): BacktestService {
  const { assetRepo, conglomerateRepo, marketData, currencyService, redis } = deps;
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

  /**
   * Resolve one basket member: ownership-scoped asset lookup (another user's
   * custom asset — or a missing id — is a 404, no existence leak §10) plus its
   * daily closes through the market-data keystone (§5.2/§5.3). Shared by the
   * primary basket and every benchmark constituent so both go through the
   * exact same path.
   */
  async function loadBasketAsset(
    userId: string,
    assetId: string,
    providerRange: HistoryRange,
    opts?: { globalOnly?: boolean },
  ): Promise<BacktestAsset> {
    const row = await assetRepo.findByIdForUser(assetId, userId);
    if (!row) throw notFound('Asset not found.', 'ASSET_NOT_FOUND');
    // Share-scoped sandbox (V5-P6 arc c): a custom asset's price history is the
    // owner's private manual valuations — absent from the read-only share — so a
    // viewer's backtest must never surface it. The existence is already exposed
    // (its symbol/name are in the shared view), so this is a plain 422, not a 404.
    if (opts?.globalOnly && row.ownerId !== null) {
      throw unprocessable(
        `${row.symbol} is a private custom asset and can’t be backtested in a shared sandbox.`,
        'SANDBOX_PRIVATE_ASSET',
      );
    }
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
    return { assetId: row.id, symbol: row.symbol, currency: row.currency, prices };
  }

  /**
   * Resolve one of the caller's own conglomerates into a runnable basket
   * (ownership enforced at query time → 404, no existence leak §10; an empty or
   * unpriced basket is a 422). Shared by the V4-P7 benchmark path and the V5-P6
   * N-way comparison so a conglomerate runs through the exact same pipeline in
   * both — the "generalise, don't fork" mandate. A NESTED conglomerate (V5-P6)
   * is flattened to its effective asset weights through the one shared
   * resolution function first, so its backtest equals the backtest of its
   * hand-flattened equivalent by construction; a basket that flattens to
   * nothing (empty, or only empty children) is a 422.
   */
  async function resolveConglomerateBasket(
    userId: string,
    conglomerateId: string,
    providerRange: HistoryRange,
  ): Promise<ResolvedConglomerateBasket> {
    const detail = await conglomerateRepo.findByIdForOwner(userId, conglomerateId);
    if (!detail) throw notFound('Conglomerate not found.', 'CONGLOMERATE_NOT_FOUND');
    const flat = await flattenConglomerate(
      // The root is already loaded — reuse it; children load owner-scoped.
      (id) =>
        id === conglomerateId
          ? Promise.resolve(detail)
          : conglomerateRepo.findByIdForOwner(userId, id),
      conglomerateId,
    );
    if (!flat || flat.positions.length === 0) {
      throw unprocessable(
        `Conglomerate ${detail.name} has no positions to backtest.`,
        'BACKTEST_UNAVAILABLE',
      );
    }
    const assets: BacktestAsset[] = [];
    for (const pos of flat.positions) {
      assets.push(await loadBasketAsset(userId, pos.assetId, providerRange));
    }
    return {
      id: detail.id,
      name: detail.name,
      positions: flat.positions.map((p) => ({ assetId: p.assetId, weight: p.weightPct })),
      assets,
    };
  }

  /**
   * Resolve the benchmark choice (V4-P7) into a runnable basket:
   *
   *  - `conglomerateId` — one of the CALLER's own conglomerates (ownership
   *    enforced at query time → 404, §10), as a whole second basket;
   *  - `assetId` — any catalog asset from local search (§6.2), as a
   *    single-constituent basket;
   *  - `preset` — a one-click ticker, resolved to its catalog asset when
   *    seeded; an unseeded catalog falls back to the static provider spec so
   *    the presets keep working on a fresh instance.
   */
  async function resolveBenchmark(
    userId: string,
    choice: BacktestBenchmarkInput,
    providerRange: HistoryRange,
  ): Promise<ResolvedBenchmark> {
    if ('conglomerateId' in choice) {
      const basket = await resolveConglomerateBasket(userId, choice.conglomerateId, providerRange);
      return {
        kind: 'conglomerate',
        refId: basket.id,
        label: basket.name,
        positions: basket.positions,
        assets: basket.assets,
      };
    }

    if ('assetId' in choice) {
      const asset = await loadBasketAsset(userId, choice.assetId, providerRange);
      return {
        kind: 'asset',
        refId: asset.assetId,
        label: asset.symbol,
        positions: [{ assetId: asset.assetId, weight: 1 }],
        assets: [asset],
      };
    }

    const spec = BENCHMARKS[choice.preset];
    const row = await assetRepo.findGlobal(spec.providerId, spec.providerRef);
    const identity = row
      ? { assetId: row.id, symbol: row.symbol, currency: row.currency }
      : { assetId: choice.preset, symbol: choice.preset, currency: spec.currency };
    const prices = await loadDailyCloses(
      { providerId: spec.providerId, providerRef: spec.providerRef },
      providerRange,
    );
    if (prices.length === 0) {
      throw unprocessable(
        `No price history available for benchmark ${choice.preset}.`,
        'NO_PRICE_HISTORY',
      );
    }
    return {
      kind: 'asset',
      refId: identity.assetId,
      label: identity.symbol,
      positions: [{ assetId: identity.assetId, weight: 1 }],
      assets: [{ ...identity, prices }],
    };
  }

  return {
    async runPreview(userId, input, opts) {
      const fx =
        opts?.baseCurrency === undefined
          ? currencyService
          : currencyService.withBase(opts.baseCurrency);
      const key = backtestPreviewCacheKey(userId, input, fx.baseCurrency);
      const cached = await redis.get(key);
      if (cached) {
        try {
          return JSON.parse(cached) as BacktestResponse;
        } catch {
          // Corrupt entry — fall through and recompute (no history refetch on a hit).
        }
      }

      const providerRange = PROVIDER_RANGE[input.range];

      // 1. Resolve every position asset and load its daily closes (shared
      //    ownership-scoped path, see loadBasketAsset).
      const assets: BacktestAsset[] = [];
      for (const pos of input.positions) {
        assets.push(await loadBasketAsset(userId, pos.assetId, providerRange));
      }

      // 2. Optional benchmark (V4-P7): resolve the choice — preset, catalog
      //    asset, or one of the caller's own conglomerates — into a second
      //    basket that will run through the same engine below.
      const resolvedBenchmark = input.benchmark
        ? await resolveBenchmark(userId, input.benchmark, providerRange)
        : null;

      // 3. Requested window. The end is today; a finite range starts N years back
      //    and the engine clips it up to the common start (emitting the §6.6
      //    notice). MAX has no explicit start, so anchor it at the basket's common
      //    start — otherwise every MAX preview would carry a spurious "Limited by
      //    …" notice for a request that asked for the full overlapping history.
      //    In the §14 full-window modes "all available history" means the
      //    EARLIEST first-available date instead (the engine only clips up to
      //    that), so MAX anchors there and late constituents stay late.
      const mode = input.mode ?? 'clip';
      const end = todayIso();
      const start =
        input.range === 'MAX'
          ? mode === 'clip'
            ? commonStart(assets)
            : earliestStart(assets)
          : yearsBefore(end, RANGE_YEARS[input.range]);

      // 4. Run the pure engine, injecting the CurrencyService as the historical
      //    FX-at-date converter (§5.4). Data-state failures (e.g. no
      //    overlapping window) surface as a 422 with the engine's message
      //    rather than a 500.
      //
      //    FX unavailability is a data state too, but unlike the portfolio
      //    series' probe-and-drop degrade (portfolioService), silently dropping
      //    an unconvertible position would re-weight the basket and change the
      //    result — so a backtest fails the whole preview with a 422 instead.
      let result: BacktestResult;
      try {
        result = await backtest({
          positions: input.positions.map((p) => ({ assetId: p.assetId, weight: p.weight })),
          assets,
          range: { start, end },
          converter: fx,
          baseCurrency: fx.baseCurrency,
          mode,
          rebalance: input.rebalance,
        });
      } catch (err) {
        throw mapEngineError(err);
      }

      // 5. Benchmark run (V4-P7): the SAME engine over the primary's effective
      //    window with the SAME base currency, late-listing mode and rebalance
      //    schedule — apples-to-apples by construction. A benchmark whose data
      //    starts after the primary t₀ would silently compare a shorter window
      //    (the engine reports that via its clip notice), so it is rejected as
      //    a 422 instead — the same outcome the pre-V4-P7 overlay produced for
      //    a benchmark short of t₀.
      let benchmark: BacktestBenchmarkResult | null = null;
      if (resolvedBenchmark) {
        let benchResult: BacktestResult;
        try {
          benchResult = await backtest({
            positions: resolvedBenchmark.positions,
            assets: resolvedBenchmark.assets,
            range: { start: result.startDate, end: result.endDate },
            converter: fx,
            baseCurrency: fx.baseCurrency,
            mode,
            rebalance: input.rebalance,
          });
        } catch (err) {
          throw mapEngineError(err);
        }
        if (benchResult.notice !== null) {
          throw unprocessable(
            `Benchmark ${resolvedBenchmark.label} does not cover the backtest window — ${benchResult.notice}.`,
            'BACKTEST_UNAVAILABLE',
          );
        }
        benchmark = {
          kind: resolvedBenchmark.kind,
          refId: resolvedBenchmark.refId,
          label: resolvedBenchmark.label,
          series: benchResult.series.map((p) => ({ date: p.date, value: p.value })),
          stats: toStats(benchResult.stats),
        };
      }

      const response = toResponse(result, benchmark);
      await redis.set(key, JSON.stringify(response), 'EX', PREVIEW_TTL_SECONDS);
      return response;
    },

    async runComparison(userId, input, opts) {
      const fx =
        opts?.baseCurrency === undefined
          ? currencyService
          : currencyService.withBase(opts.baseCurrency);
      const mode = input.mode ?? 'clip';
      const rebalance = input.rebalance ?? 'none';
      // The delta baseline is contract-guaranteed to be one of the ids (or the
      // first when omitted); it steers only the deltas, never the window.
      const baselineId = input.baselineId ?? input.conglomerateIds[0]!;

      // The per-series backtests are baseline-independent, so they memoise under
      // a key WITHOUT the baseline: re-picking the baseline hits this core and
      // only the cheap delta math re-runs.
      const key = backtestComparisonCacheKey(userId, input, fx.baseCurrency);
      let core: ComparisonCore | null = null;
      const cached = await redis.get(key);
      if (cached) {
        try {
          core = JSON.parse(cached) as ComparisonCore;
        } catch {
          // Corrupt entry — fall through and recompute.
        }
      }
      if (core === null) {
        core = await computeComparisonCore(userId, input, fx, mode, rebalance);
        await redis.set(key, JSON.stringify(core), 'EX', PREVIEW_TTL_SECONDS);
      }

      // Deltas vs the chosen baseline — pure domain math over the shared-window
      // stats (compareSeriesStats preserves input order, so index i lines up
      // with core.series[i]).
      const comparison = compareSeriesStats(
        core.series.map((s) => ({ id: s.conglomerateId, metrics: metricsFor(s.stats) })),
        baselineId,
      );

      return {
        startDate: core.startDate,
        endDate: core.endDate,
        baselineId,
        mode: core.mode,
        rebalance: core.rebalance,
        series: core.series.map((s, i) => {
          const d = comparison.series[i]!.deltas;
          return {
            conglomerateId: s.conglomerateId,
            name: s.name,
            series: s.series,
            stats: s.stats,
            deltas: {
              totalReturnPct: d.totalReturnPct,
              cagrPct: d.cagrPct,
              maxDrawdownPct: d.maxDrawdownPct,
              volatilityPct: d.volatilityPct,
              bestDayPct: d.bestDayPct,
              worstDayPct: d.worstDayPct,
            },
          };
        }),
      };
    },

    async runSharedSandboxPreview(viewerId, input, opts) {
      // Same guard, same outcome as the read-only shared view (§6.9): resolve the
      // owner when the viewer may see this basket, otherwise a 404 — never a 403,
      // never data. Also covers the service constructed without the social guard.
      const authorize = deps.authorizeConglomerateRead;
      const owner = authorize ? await authorize(viewerId, input.conglomerateId) : undefined;
      if (!owner) throw notFound('Conglomerate not found.', 'CONGLOMERATE_NOT_FOUND');

      // Read the basket AS THE OWNER — the viewer gains no owner scope; we only
      // read what they are already authorized to see.
      const detail = await conglomerateRepo.findByIdForOwner(owner.ownerId, input.conglomerateId);
      if (!detail) throw notFound('Conglomerate not found.', 'CONGLOMERATE_NOT_FOUND');

      // Arc c re-weights TOP-LEVEL asset constituents only. A nested child would
      // need recursive re-weighting (#592, out of scope) and flattening it would
      // fold in the child's own (unshared) internal weights — so any nested
      // constituent makes the basket un-sandboxable.
      const constituents = detail.positions.filter(
        (p): p is Extract<ConglomerateConstituentRow, { kind: 'asset' }> => p.kind === 'asset',
      );
      if (constituents.length !== detail.positions.length) {
        throw unprocessable(
          'This conglomerate contains a nested basket and can’t be used in a what-if sandbox.',
          'SANDBOX_NESTED_UNSUPPORTED',
        );
      }

      // Pin the tweak set to the shared basket's real constituents: the viewer may
      // re-weight only what the share already exposes, never add or drop an id. An
      // id set that doesn't match exactly (a foreign id, a missing one, or a basket
      // that changed under the viewer) is a 422 — the client refetches and resets.
      const tweak = new Map(input.positions.map((p) => [p.id, p.weight]));
      const idSetMatches =
        tweak.size === constituents.length && constituents.every((p) => tweak.has(p.assetId));
      if (!idSetMatches) {
        throw unprocessable(
          'Sandbox weights must cover exactly the shared basket’s constituents.',
          'SANDBOX_POSITIONS_MISMATCH',
        );
      }

      const fx =
        opts?.baseCurrency === undefined
          ? currencyService
          : currencyService.withBase(opts.baseCurrency);
      const providerRange = PROVIDER_RANGE[input.range];

      // The tweaked basket: each shared constituent at the viewer's new weight,
      // resolved as a PUBLIC catalog asset (globalOnly) so no private valuation
      // history is ever pulled into the curve.
      const positions = constituents.map((p) => ({
        assetId: p.assetId,
        weight: tweak.get(p.assetId)!,
      }));
      const assets: BacktestAsset[] = [];
      for (const pos of positions) {
        assets.push(
          await loadBasketAsset(owner.ownerId, pos.assetId, providerRange, { globalOnly: true }),
        );
      }

      // Window resolution mirrors runPreview exactly (§6.6/§14) so the sandbox
      // curve is apples-to-apples with the shared basket's own backtest.
      const mode = input.mode ?? 'clip';
      const end = todayIso();
      const start =
        input.range === 'MAX'
          ? mode === 'clip'
            ? commonStart(assets)
            : earliestStart(assets)
          : yearsBefore(end, RANGE_YEARS[input.range]);

      let result: BacktestResult;
      try {
        result = await backtest({
          positions,
          assets,
          range: { start, end },
          converter: fx,
          baseCurrency: fx.baseCurrency,
          mode,
          rebalance: input.rebalance,
        });
      } catch (err) {
        throw mapEngineError(err);
      }
      // No Redis memo and no writes: a viewer's slider-wiggle recomputes off the
      // already-warm provider history, and the sandbox never persists a thing.
      return toResponse(result, null);
    },
  };

  /**
   * Run the baseline-independent core of a comparison: resolve every
   * conglomerate (ownership-scoped, in request order), run the FIRST as the
   * primary to fix the shared window, then run every other over that exact
   * window with identical settings. A non-primary that can't cover the window
   * is a 422 (the V4-P7 short-benchmark outcome). The primary's own clip notice
   * is expected and never an error — it just means the window is shorter than
   * requested.
   */
  async function computeComparisonCore(
    userId: string,
    input: BacktestComparisonInput,
    fx: CurrencyService,
    mode: BacktestMode,
    rebalance: RebalanceFrequency,
  ): Promise<ComparisonCore> {
    const providerRange = PROVIDER_RANGE[input.range];

    const baskets: ResolvedConglomerateBasket[] = [];
    for (const id of input.conglomerateIds) {
      baskets.push(await resolveConglomerateBasket(userId, id, providerRange));
    }

    const end = todayIso();
    const primary = baskets[0]!;
    const primaryStart =
      input.range === 'MAX'
        ? mode === 'clip'
          ? commonStart(primary.assets)
          : earliestStart(primary.assets)
        : yearsBefore(end, RANGE_YEARS[input.range]);

    let primaryResult: BacktestResult;
    try {
      primaryResult = await backtest({
        positions: primary.positions,
        assets: primary.assets,
        range: { start: primaryStart, end },
        converter: fx,
        baseCurrency: fx.baseCurrency,
        mode,
        rebalance,
      });
    } catch (err) {
      throw mapEngineError(err);
    }

    const window = { start: primaryResult.startDate, end: primaryResult.endDate };
    const series: ComparisonCore['series'] = [
      {
        conglomerateId: primary.id,
        name: primary.name,
        series: primaryResult.series.map((p) => ({ date: p.date, value: p.value })),
        stats: toStats(primaryResult.stats),
      },
    ];

    for (let i = 1; i < baskets.length; i += 1) {
      const basket = baskets[i]!;
      let result: BacktestResult;
      try {
        result = await backtest({
          positions: basket.positions,
          assets: basket.assets,
          range: window,
          converter: fx,
          baseCurrency: fx.baseCurrency,
          mode,
          rebalance,
        });
      } catch (err) {
        throw mapEngineError(err);
      }
      if (result.notice !== null) {
        throw unprocessable(
          `Conglomerate ${basket.name} does not cover the comparison window — ${result.notice}.`,
          'BACKTEST_UNAVAILABLE',
        );
      }
      series.push({
        conglomerateId: basket.id,
        name: basket.name,
        series: result.series.map((p) => ({ date: p.date, value: p.value })),
        stats: toStats(result.stats),
      });
    }

    return { startDate: window.start, endDate: window.end, mode, rebalance, series };
  }
}

/**
 * The baseline-independent core of a comparison (Redis-cached): the shared
 * window + each conglomerate's base-100 series and full stats. Deltas are
 * layered on per request against the caller's chosen baseline, so a baseline
 * switch reuses this core.
 */
interface ComparisonCore {
  startDate: string;
  endDate: string;
  mode: BacktestMode;
  rebalance: RebalanceFrequency;
  series: Array<{
    conglomerateId: string;
    name: string;
    series: Array<{ date: string; value: number }>;
    stats: BacktestStatsDto;
  }>;
}

/**
 * Flatten a wire `BacktestStats` to the comparison's numeric metric vector: the
 * best/worst-day blocks collapse to their `returnPct` (the grid compares the
 * magnitude; the date stays on the per-series `stats`).
 */
function metricsFor(stats: BacktestStatsDto): ComparisonMetrics {
  return {
    totalReturnPct: stats.totalReturnPct,
    cagrPct: stats.cagrPct,
    maxDrawdownPct: stats.maxDrawdownPct,
    volatilityPct: stats.volatilityPct,
    bestDayPct: stats.bestDay?.returnPct ?? null,
    worstDayPct: stats.worstDay?.returnPct ?? null,
  };
}

/** Map engine data-state failures to 422s (never 500s); rethrow everything else. */
function mapEngineError(err: unknown): unknown {
  if (err instanceof BacktestError) {
    return unprocessable(err.message, 'BACKTEST_UNAVAILABLE');
  }
  if (err instanceof FxRateUnavailableError) {
    return unprocessable(
      `Currency conversion required by this backtest is unavailable: ${err.message}`,
      'FX_UNAVAILABLE',
    );
  }
  return err;
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

/**
 * The basket's earliest first-available date across assets — the §14
 * full-window analogue of {@link commonStart}: anchoring MAX here keeps the
 * oldest constituent's entire history in the window (and every younger
 * constituent late) without a spurious clip notice.
 */
function earliestStart(assets: readonly BacktestAsset[]): string {
  let start = '';
  for (const a of assets) {
    for (const p of a.prices) {
      if (start === '' || p.date < start) start = p.date;
    }
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

/** Shape the engine's `BacktestResult` (+ the separately-run benchmark) into the wire DTO. */
function toResponse(
  r: BacktestResult,
  benchmark: BacktestBenchmarkResult | null,
): BacktestResponse {
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
    benchmark,
    mode: r.mode,
    rebalance: r.rebalance,
    entryEvents: r.entryEvents.map((e) => ({
      assetId: e.assetId,
      symbol: e.symbol,
      date: e.date,
    })),
    rebalanceEvents: r.rebalanceEvents.map((e) => ({ date: e.date })),
    idleCashAvgPct: r.idleCashAvgPct,
  };
}
