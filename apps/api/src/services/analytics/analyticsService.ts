import type {
  AnalyticsContributionRow,
  AnalyticsMode,
  AnalyticsSeries,
  AnalyticsSeriesPoint,
  AnalyticsSeriesQuery,
  AnalyticsSeriesResponse,
  PortfolioAsset,
} from '@bettertrack/contracts';

import type { AssetRepository } from '../../data/repositories/assetRepository';
import {
  computeContributions,
  computeSeriesStats,
  deflateSeries,
  toPerformanceSeries,
  type Deflator,
  type StatSeriesPoint,
} from '../../domain/seriesStats';
import { badRequest, notFound } from '../../errors';
import type { MarketDataService } from '../../providers';
import type { BacktestService } from '../backtest/backtestService';
import type { ConglomerateService } from '../conglomerate/conglomerateService';
import type { PortfolioService } from '../portfolio/portfolioService';
import { INFLATION_INDEX_SERIES } from './inflationSeries';

/**
 * Analytics deep-dive service (PROJECTPLAN §13.3 V3-P9).
 *
 * Assembles the configurable main graph + contribution table for the Portfolio
 * → Analytics page from the smoothing-aware per-asset value series
 * ({@link PortfolioService.getAssetValueSeries}). It masks visibility, filters
 * by category/type, resolves an optional compare benchmark (a catalog asset,
 * another own portfolio, or an own conglomerate — ownership enforced), applies
 * an optional real-terms inflation transform, and computes per-series stats +
 * per-asset contributions via the pure `domain/seriesStats`.
 *
 * Denominated in EUR (the storage base): the per-asset value pipeline converts
 * with historical daily FX to EUR; non-EUR presentation bases are the overview's
 * V3-P10d concern and out of scope here.
 */
export interface AnalyticsServiceDeps {
  portfolio: PortfolioService;
  conglomerate: ConglomerateService;
  backtest: BacktestService;
  assetRepo: AssetRepository;
  marketData: MarketDataService;
}

export interface AnalyticsService {
  getSeries(
    userId: string,
    portfolioId: string,
    query: AnalyticsSeriesQuery,
  ): Promise<AnalyticsSeriesResponse>;
}

/** ISO `YYYY-MM-DD` ascending comparator (lexicographic is correct for this format). */
const byDate = (a: { date: string }, b: { date: string }): number =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : 0;

/** The bucket an asset filters by: market assets by `type`, custom assets by `category`. */
const groupKeyOf = (asset: PortfolioAsset): string =>
  asset.isCustom ? (asset.category ?? 'other') : asset.type;

export function createAnalyticsService(deps: AnalyticsServiceDeps): AnalyticsService {
  const { portfolio, conglomerate, backtest, assetRepo, marketData } = deps;

  /** Sum a set of per-asset value maps over a shared date grid (missing day → 0). */
  function sumOverGrid(
    grid: readonly string[],
    maps: ReadonlyArray<Map<string, number>>,
  ): StatSeriesPoint[] {
    return grid.map((date) => ({
      date,
      value: maps.reduce((sum, map) => sum + (map.get(date) ?? 0), 0),
    }));
  }

  /** Resolve the query's inflation knob to a pure {@link Deflator}, or `null` (nominal). */
  function resolveDeflator(query: AnalyticsSeriesQuery): Deflator | null {
    if (!query.inflation) return null;
    if (query.inflation === 'flat') {
      // Required-field check the flat-object schema can't express (see contracts).
      if (query.inflationRate === undefined) {
        throw badRequest('inflationRate is required for flat inflation.', 'VALIDATION_ERROR');
      }
      return { kind: 'flat', pctPerYear: query.inflationRate };
    }
    return { kind: 'index', monthly: INFLATION_INDEX_SERIES[query.inflation].monthly };
  }

  /** Value series → response points in the requested render mode. */
  function applyMode(
    value: readonly StatSeriesPoint[],
    mode: AnalyticsMode,
  ): AnalyticsSeriesPoint[] {
    if (mode === 'perf') {
      return toPerformanceSeries(value).map((p) => ({ date: p.date, value: p.pct }));
    }
    return value.map((p) => ({ date: p.date, value: p.value }));
  }

  /**
   * A nominal value series → a rendered {@link AnalyticsSeries}: inflation-deflate
   * first (so stats + points are both real-terms), then compute stats on the value
   * series (mode-invariant) and project the points into the render mode.
   */
  function buildSeries(
    kind: AnalyticsSeries['kind'],
    label: string,
    nominal: readonly StatSeriesPoint[],
    deflator: Deflator | null,
    mode: AnalyticsMode,
  ): AnalyticsSeries {
    const value = deflator ? deflateSeries(nominal, deflator) : nominal.map((p) => ({ ...p }));
    return { kind, label, points: applyMode(value, mode), stats: computeSeriesStats(value) };
  }

  /** Compare vs a catalog asset/index: its own daily close series (native currency). */
  async function resolveCompareAsset(
    userId: string,
    assetId: string,
    from: string,
    to: string,
  ): Promise<{ label: string; series: StatSeriesPoint[] }> {
    const row = await assetRepo.findByIdForUser(assetId, userId);
    if (!row) throw notFound('Asset not found.', 'ASSET_NOT_FOUND');
    let closes: readonly { time: string; close: number }[] = [];
    try {
      const cached = await marketData.getHistory(
        { providerId: row.providerId, providerRef: row.providerRef },
        'MAX',
        '1d',
      );
      closes = cached.value;
    } catch {
      closes = [];
    }
    // One close per day (last candle wins), non-finite dropped, sliced to [from,to].
    const perDay = new Map<string, number>();
    for (const point of closes) {
      if (!Number.isFinite(point.close)) continue;
      perDay.set(point.time.slice(0, 10), point.close);
    }
    const series = [...perDay.entries()]
      .map(([date, value]) => ({ date, value }))
      .filter((p) => p.date >= from && p.date <= to)
      .sort(byDate);
    return { label: row.symbol, series };
  }

  /** Compare vs another OWN portfolio: its total value curve (ownership enforced → 404). */
  async function resolveComparePortfolio(
    userId: string,
    comparePortfolioId: string,
    from: string,
    to: string,
  ): Promise<{ label: string; series: StatSeriesPoint[] }> {
    const src = await portfolio.getAssetValueSeries(userId, comparePortfolioId);
    const dates = new Set<string>();
    const maps: Map<string, number>[] = [];
    for (const entry of src.assets) {
      const map = new Map<string, number>();
      for (const point of entry.points) {
        map.set(point.date, point.valueEur);
        if (point.date >= from && point.date <= to) dates.add(point.date);
      }
      maps.push(map);
    }
    const grid = [...dates].sort();
    return { label: src.name, series: sumOverGrid(grid, maps) };
  }

  /** Compare vs an OWN conglomerate: its base-100 backtest index (ownership enforced → 404). */
  async function resolveCompareConglomerate(
    userId: string,
    conglomerateId: string,
    from: string,
    to: string,
  ): Promise<{ label: string; series: StatSeriesPoint[] }> {
    const detail = await conglomerate.get(userId, conglomerateId);
    if (detail.positions.length === 0) {
      throw badRequest('Conglomerate has no positions to compare.', 'VALIDATION_ERROR');
    }
    const preview = await backtest.runPreview(userId, {
      positions: detail.positions.map((p) => ({ assetId: p.assetId, weight: p.weightPct })),
      range: 'MAX',
      mode: 'clip',
    });
    const series = preview.series
      .map((p) => ({ date: p.date, value: p.value }))
      .filter((p) => p.date >= from && p.date <= to);
    return { label: detail.name, series };
  }

  async function resolveCompare(
    userId: string,
    query: AnalyticsSeriesQuery,
    from: string,
    to: string,
    deflator: Deflator | null,
  ): Promise<AnalyticsSeries | null> {
    if (!query.compareKind) return null;
    if (!query.compareId) {
      throw badRequest('compareId is required with compareKind.', 'VALIDATION_ERROR');
    }
    let resolved: { label: string; series: StatSeriesPoint[] };
    let kind: AnalyticsSeries['kind'];
    switch (query.compareKind) {
      case 'asset':
        resolved = await resolveCompareAsset(userId, query.compareId, from, to);
        kind = 'asset';
        break;
      case 'portfolio':
        resolved = await resolveComparePortfolio(userId, query.compareId, from, to);
        kind = 'portfolio';
        break;
      case 'conglomerate':
        resolved = await resolveCompareConglomerate(userId, query.compareId, from, to);
        kind = 'conglomerate';
        break;
    }
    return buildSeries(kind, resolved.label, resolved.series, deflator, query.mode);
  }

  return {
    async getSeries(userId, portfolioId, query) {
      if (query.compareId && !query.compareKind) {
        throw badRequest('compareKind is required with compareId.', 'VALIDATION_ERROR');
      }
      if (query.from && query.to && query.from > query.to) {
        throw badRequest('`from` must be on or before `to`.', 'VALIDATION_ERROR');
      }
      const deflator = resolveDeflator(query);

      // Per-asset EUR value series (smoothing-aware). Ownership 404s here.
      const src = await portfolio.getAssetValueSeries(userId, portfolioId);
      const baseCurrency = src.baseCurrency;

      // Visibility mask: per-asset `hide`, plus include (`groups`) / exclude
      // (`hideGroups`) filters over the market-type / custom-category buckets.
      const hidden = new Set(query.hide ?? []);
      const includeGroups = query.groups && query.groups.length > 0 ? new Set(query.groups) : null;
      const excludeGroups = new Set(query.hideGroups ?? []);
      const isVisible = (asset: PortfolioAsset): boolean => {
        if (hidden.has(asset.id)) return false;
        const key = groupKeyOf(asset);
        if (includeGroups && !includeGroups.has(key)) return false;
        if (excludeGroups.has(key)) return false;
        return true;
      };

      // Per-asset value maps; the grid is the union of ALL assets' dates within
      // the window, so hiding an asset changes the curve's VALUES but not its
      // x-axis. Missing day → 0 (asset not yet held that day).
      const dates = new Set<string>();
      const assetById = new Map<string, { asset: PortfolioAsset; map: Map<string, number> }>();
      for (const entry of src.assets) {
        const map = new Map<string, number>();
        for (const point of entry.points) {
          map.set(point.date, point.valueEur);
          if ((!query.from || point.date >= query.from) && (!query.to || point.date <= query.to)) {
            dates.add(point.date);
          }
        }
        assetById.set(entry.asset.id, { asset: entry.asset, map });
      }
      const grid = [...dates].sort();
      const from = grid[0] ?? query.from ?? src.today;
      const to = grid[grid.length - 1] ?? query.to ?? src.today;

      const visibleEntries = src.assets
        .map((e) => assetById.get(e.asset.id))
        .filter((e): e is { asset: PortfolioAsset; map: Map<string, number> } => e !== undefined)
        .filter((e) => isVisible(e.asset));

      const nominalPrimary = sumOverGrid(
        grid,
        visibleEntries.map((e) => e.map),
      );
      const primary = buildSeries('portfolio', src.name, nominalPrimary, deflator, query.mode);

      // Contribution table (visible set): value/cost/P-L/weight are current
      // holdings facts (§6.9 holdings math); contributionPct is the asset's
      // share of the NOMINAL filtered series' period change (start→end), so the
      // visible rows' contributionPct sum to the nominal filtered total return.
      const snapshot = await portfolio.getPortfolio(userId, portfolioId);
      const holdingByAsset = new Map(snapshot.holdings.map((h) => [h.asset.id, h]));
      const contributionInputs = visibleEntries.map((e) => {
        const holding = holdingByAsset.get(e.asset.id);
        return {
          assetId: e.asset.id,
          startValue: e.map.get(from) ?? 0,
          endValue: e.map.get(to) ?? 0,
          currentValue: holding?.marketValueEur ?? 0,
        };
      });
      const shares = computeContributions(contributionInputs);
      const contributions: AnalyticsContributionRow[] = visibleEntries.map((e, i) => {
        const holding = holdingByAsset.get(e.asset.id);
        const share = shares[i];
        return {
          asset: e.asset,
          value: holding?.marketValueEur ?? 0,
          cost: holding?.costBasisEur ?? 0,
          pnl: holding?.unrealizedPnlEur ?? 0,
          weight: share?.weight ?? 0,
          contributionPct: share?.contributionPct ?? 0,
        };
      });

      const compare = await resolveCompare(userId, query, from, to, deflator);

      return {
        portfolioId,
        baseCurrency,
        mode: query.mode,
        from,
        to,
        inflation: query.inflation
          ? {
              id: query.inflation,
              pctPerYear: query.inflation === 'flat' ? (query.inflationRate ?? null) : null,
            }
          : null,
        primary,
        compare,
        contributions,
      };
    },
  };
}
