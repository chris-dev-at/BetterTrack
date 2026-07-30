import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { Time } from 'lightweight-charts';

import type { PortfolioHistoryRange } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { getPortfolioHistory } from '../../../lib/portfolioApi';
import { PriceChart } from '../../../ui/charts';
import type { PriceRange } from '../../../ui/charts';
import { Empty } from '../../../ui/origin';
import { widgetVariant } from '../config';
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
 *
 * ## The `return` variant
 *
 * The same window, read as the **time-weighted return** on net worth instead of
 * the euro value: the endpoint's `performance[]`, plotted through the very same
 * baseline/percent mode the portfolio Overview's "Performance %" toggle uses, so
 * the widget and the page cannot disagree about either the number or its format.
 * It is not re-derived here — deposits and withdrawals are the only external
 * flows and the server already chain-links them out.
 *
 * That series is **per portfolio**, so the variant is single-portfolio only.
 * Percentages are not additive, and an honest combined return would need the
 * summed external flows, which `/history` does not return. Rather than hide the
 * variant when the scope is wider — which would make the picker flicker while
 * the portfolio list loads — the widget *degrades* to the value curve and says
 * so in a quiet line. The user never sees a percentage that silently means
 * something other than what the picker claims.
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

  // The return form needs exactly one portfolio (see the module docblock). Any
  // wider scope — "all", a multi-portfolio set, or a scope whose only target is
  // archived and so resolved back to all — draws the combined VALUE curve.
  const wantsReturn = widgetVariant('performance-chart', settings) === 'return';
  const showingReturn = wantsReturn && !combining;
  // Explain the degrade, but never mid-load: until the portfolio list arrives
  // nothing has resolved yet, and a note shown then would flash on every mount.
  const explainDegrade = wantsReturn && combining && !portfoliosLoading;

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
  // `performance[]` is aligned 1:1 with `points[]` and keyed the same way, so
  // both forms share one mapping — exactly as the portfolio overview does.
  const single = useMemo(() => {
    const at = (point: { date: string; time?: string }): Time =>
      point.time !== undefined
        ? (Math.floor(Date.parse(point.time) / 1000) as Time)
        : (point.date as Time);
    return showingReturn
      ? (historyQuery.data?.performance ?? []).map((point) => ({
          time: at(point),
          value: point.pct,
        }))
      : (historyQuery.data?.points ?? []).map((point) => ({
          time: at(point),
          value: point.valueEur,
        }));
  }, [historyQuery.data, showingReturn]);

  // Nothing to draw: no portfolio resolved at all, or none left to combine.
  if (!portfoliosLoading && (combining ? charted.length === 0 : portfolioId === null)) {
    return <Empty title={t('home.widgets.performanceChart.empty')} />;
  }

  const scopeName = combining ? t('home.builder.scopeAll') : (scopedPortfolio?.name ?? '');

  return (
    <div>
      <div className="bt-chart">
        <PriceChart
          ariaLabel={
            showingReturn
              ? t('home.widgets.performanceChart.ariaLabelReturn', { name: scopeName })
              : t('home.widgets.performanceChart.ariaLabel', { name: scopeName })
          }
          height={size === 'l' ? 300 : 220}
          loading={
            portfoliosLoading ||
            (combining ? combined.loading : historyQuery.isLoading || historyQuery.isFetching)
          }
          // The portfolio overview's own "Performance %" mode, reused whole: the
          // 0-centred baseline (green above, red below) and the `x.xx %` axis and
          // crosshair come from the chart, not from a second copy here.
          mode={showingReturn ? 'baseline' : 'area'}
          onRangeChange={(next) => onSettingsChange({ range: next })}
          percentValues={showingReturn}
          range={range}
          // The widget's own header owns the left of this row (owner).
          rangeAlign="end"
          ranges={PERFORMANCE_RANGES}
          series={combining ? combined.series : single}
        />
      </div>
      {showingReturn ? (
        <p className="bt-meta bt-home-chartnote">{t('home.widgets.performanceChart.returnHint')}</p>
      ) : null}
      {explainDegrade ? (
        <p className="bt-meta bt-home-chartnote">
          {t('home.widgets.performanceChart.returnNeedsOne')}
        </p>
      ) : null}
    </div>
  );
}
