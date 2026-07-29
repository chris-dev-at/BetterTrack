import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { Time } from 'lightweight-charts';

import type { PortfolioHistoryRange } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { getPortfolioHistory } from '../../../lib/portfolioApi';
import { PriceChart } from '../../../ui/charts';
import type { PriceRange } from '../../../ui/charts';
import { Empty } from '../../../ui/origin';
import { combineSamples, MAX_HISTORY_PORTFOLIOS, normalizeSamples } from './NetWorthHistoryWidget';
import type { WidgetProps } from './types';

/**
 * Portfolio value over time, using the same `PriceChart` and the same
 * `['portfolio', id, 'history', range]` cache entry as the portfolio overview —
 * so placing this widget for a portfolio the user also visits costs no extra
 * request.
 *
 * Scope accepts "All portfolios" as well as a single one: history is a
 * per-portfolio endpoint, so the combined curve fans the endpoint out and sums
 * the series with each portfolio contributing 0 before its own first datapoint
 * (`combineSamples`) — a portfolio opened last month lifts the total on the day
 * it opened instead of being back-projected across a history it never had.
 */

/** The same window set the portfolio overview offers (§6.9 + §13.4 V4-P0). */
export const PERFORMANCE_RANGES: readonly PriceRange[] = [
  '1D',
  '1W',
  '1M',
  '6M',
  '1Y',
  '5Y',
  'Max',
];

/**
 * The chart's `PriceRange` tokens use 'Max'; the contract uses 'MAX'.
 *
 * Exported because `net-worth-history` fans the same endpoint out per portfolio
 * under the same `['portfolio', id, 'history', range]` keys. Both surfaces must
 * spell the range token identically or the two silently stop sharing cache
 * entries — so they share the mapping rather than each keeping a copy.
 */
export function toHistoryRange(range: PriceRange): PortfolioHistoryRange {
  return range === 'Max' ? 'MAX' : (range as PortfolioHistoryRange);
}

function asRange(value: string | undefined): PriceRange {
  return PERFORMANCE_RANGES.includes(value as PriceRange) ? (value as PriceRange) : '1M';
}

export function PerformanceChartWidget({
  settings,
  onSettingsChange,
  scopedPortfolio,
  scopedPortfolios,
  portfoliosLoading,
  size,
}: WidgetProps) {
  const t = useT();
  const range = asRange(settings.range);
  // "All portfolios" is a real option here (owner). Keyed on the RESOLUTION, not
  // the stored token: an instance saved before this option existed carries no
  // scope, and resolveWidgetScope lands it on every portfolio — the combined
  // case too. A scope naming an archived portfolio degrades the same way.
  const combining = scopedPortfolio === null;
  const portfolioId = scopedPortfolio?.id ?? null;

  const historyQuery = useQuery({
    queryKey: ['portfolio', portfolioId, 'history', toHistoryRange(range)],
    queryFn: ({ signal }) =>
      getPortfolioHistory(portfolioId!, toHistoryRange(range), false, signal),
    enabled: !combining && portfolioId !== null,
    // §6.9 caches the series for an hour server-side; mirror it client-side.
    staleTime: 3_600_000,
  });

  // One query per portfolio when combining, under the very same keys, so the
  // combined curve and any single-portfolio chart share cache entries.
  const charted = combining ? scopedPortfolios.slice(0, MAX_HISTORY_PORTFOLIOS) : [];
  const combined = useQueries({
    queries: charted.map((portfolio) => ({
      queryKey: ['portfolio', portfolio.id, 'history', toHistoryRange(range)],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getPortfolioHistory(portfolio.id, toHistoryRange(range), false, signal),
      staleTime: 3_600_000,
    })),
    combine: (results) => ({
      series: combineSamples(results.map((result) => normalizeSamples(result.data?.points ?? []))),
      loading: results.some((result) => result.isLoading || result.isFetching),
    }),
  });

  // #556: 1D/1W points carry an intraday `time` — key on the exact instant so
  // the dense curve plots, versus the business-day string the daily ranges use.
  const single = useMemo(
    () =>
      (historyQuery.data?.points ?? []).map((point) => ({
        time:
          point.time !== undefined
            ? (Math.floor(Date.parse(point.time) / 1000) as Time)
            : (point.date as Time),
        value: point.valueEur,
      })),
    [historyQuery.data],
  );

  // Nothing to draw: no portfolio resolved at all, or none left to combine.
  if (!portfoliosLoading && (combining ? charted.length === 0 : portfolioId === null)) {
    return <Empty title={t('home.widgets.performanceChart.empty')} />;
  }

  return (
    <div className="bt-chart">
      <PriceChart
        ariaLabel={t('home.widgets.performanceChart.ariaLabel', {
          name: combining ? t('home.builder.scopeAll') : (scopedPortfolio?.name ?? ''),
        })}
        height={size === 'l' ? 300 : 220}
        loading={
          portfoliosLoading ||
          (combining ? combined.loading : historyQuery.isLoading || historyQuery.isFetching)
        }
        mode="area"
        onRangeChange={(next) => onSettingsChange({ range: next })}
        range={range}
        ranges={PERFORMANCE_RANGES}
        series={combining ? combined.series : single}
      />
    </div>
  );
}
