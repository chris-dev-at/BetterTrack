import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Time } from 'lightweight-charts';

import type { PortfolioHistoryRange } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { getPortfolioHistory } from '../../../lib/portfolioApi';
import { PriceChart } from '../../../ui/charts';
import type { PriceRange } from '../../../ui/charts';
import { Empty } from '../../../ui/origin';
import type { WidgetProps } from './types';

/**
 * Portfolio value over time, using the same `PriceChart` and the same
 * `['portfolio', id, 'history', range]` cache entry as the portfolio overview —
 * so placing this widget for a portfolio the user also visits costs no extra
 * request.
 *
 * History is a per-portfolio endpoint, so this widget is single-scope by design
 * (its picker offers no "all portfolios" option): summing curves whose
 * portfolios start on different dates would draw a step that never happened.
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

/** The chart's `PriceRange` tokens use 'Max'; the contract uses 'MAX'. */
function toHistoryRange(range: PriceRange): PortfolioHistoryRange {
  return range === 'Max' ? 'MAX' : (range as PortfolioHistoryRange);
}

function asRange(value: string | undefined): PriceRange {
  return PERFORMANCE_RANGES.includes(value as PriceRange) ? (value as PriceRange) : '1M';
}

export function PerformanceChartWidget({
  settings,
  onSettingsChange,
  scopedPortfolio,
  portfoliosLoading,
  size,
}: WidgetProps) {
  const t = useT();
  const range = asRange(settings.range);
  const portfolioId = scopedPortfolio?.id ?? null;

  const historyQuery = useQuery({
    queryKey: ['portfolio', portfolioId, 'history', toHistoryRange(range)],
    queryFn: ({ signal }) =>
      getPortfolioHistory(portfolioId!, toHistoryRange(range), false, signal),
    enabled: portfolioId !== null,
    // §6.9 caches the series for an hour server-side; mirror it client-side.
    staleTime: 3_600_000,
  });

  // #556: 1D/1W points carry an intraday `time` — key on the exact instant so
  // the dense curve plots, versus the business-day string the daily ranges use.
  const series = useMemo(
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

  if (!portfoliosLoading && portfolioId === null) {
    return <Empty title={t('home.widgets.performanceChart.empty')} />;
  }

  return (
    <div className="bt-chart">
      <PriceChart
        ariaLabel={t('home.widgets.performanceChart.ariaLabel', {
          name: scopedPortfolio?.name ?? '',
        })}
        height={size === 'l' ? 300 : 220}
        loading={portfoliosLoading || historyQuery.isLoading || historyQuery.isFetching}
        mode="area"
        onRangeChange={(next) => onSettingsChange({ range: next })}
        range={range}
        ranges={PERFORMANCE_RANGES}
        series={series}
      />
    </div>
  );
}
