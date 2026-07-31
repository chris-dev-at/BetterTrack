import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { Time } from 'lightweight-charts';

import type { CashTrendPoint } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { cashTrendsQueryKey, getCashTrends } from '../../../lib/cashApi';
import { formatMoney, getMoneyCurrency } from '../../../lib/format';
import { MoneyText } from '../../../ui';
import { PriceChart } from '../../../ui/charts';
import { NEGATIVE, POSITIVE } from '../../../ui/charts/palette';
import { Empty } from '../../../ui/origin';
import { widgetVariant } from '../config';
import { MAX_HISTORY_PORTFOLIOS } from './NetWorthHistoryWidget';
import type { WidgetProps } from './types';

/**
 * Cash flow over time, fanned out over the widget's scoped portfolios and
 * summed month-by-month — the same shape `net-worth-history` uses for a
 * portfolio's VALUE, applied here to a monthly FLOW (V5 cash fusion, `GET
 * /cash/trends?portfolioId=&months=`, `['cash','trends',portfolioId,months]`
 * — cash now has a portfolio dimension, so the ledger's own summed multi-
 * portfolio scope applies here too instead of the widget opting out of one).
 *
 * **Flows, not balances — no forward-fill.** A portfolio's VALUE carries
 * forward between points (no transaction ⇒ still worth what it was worth
 * last); a month's in/out does not — a portfolio with no movement in a given
 * month truly moved €0 that month, not "whatever it moved last time". So the
 * union of every scoped portfolio's months is summed with a missing month
 * contributing exactly 0, never a neighbour's or a carried-forward figure
 * (see `combineCashTrends`, mirrored on the pure-logic side by
 * `net-worth-history`'s `combineSamples`).
 *
 * **Two forms, two questions.**
 *
 *  - `net` (default) — "did I put money away or burn it?", a polarity question.
 *    One series (inflow − outflow) in the chart core's `baseline` mode, which
 *    colours above/below zero. The gross figures stay as quiet substats beneath.
 *  - `columns` — "what came in and what went out each month?", which the net view
 *    deliberately hides: a flat net month can be €200 in/€200 out or €9k in/€9k
 *    out. Inflow and outflow become two bars per month.
 *
 * Grouped bars are legitimate here and *only* here: the two series share one unit
 * (EUR) and one scale, so there is no second axis and no rescaling — the bars are
 * directly comparable by height. They are drawn as plain SVG rects rather than
 * through the charting core, which has no bar mode and would need a second engine
 * instance for a shape this simple.
 */

/** Trailing-month windows the settings popover offers. */
export const CASHFLOW_MONTHS: Record<string, number> = { '3M': 3, '6M': 6, '12M': 12 };

function monthsFor(range: string | undefined): number {
  return (range !== undefined ? CASHFLOW_MONTHS[range] : undefined) ?? 6;
}

/**
 * Sum per-portfolio month points onto the union of their `month` keys. A
 * portfolio missing a month contributes 0 for it — see the module doc for
 * why that is a flow rule, not the balance-series forward-fill rule
 * `net-worth-history`'s `combineSamples` uses.
 */
export function combineCashTrends(sets: readonly CashTrendPoint[][]): CashTrendPoint[] {
  const months = [...new Set(sets.flatMap((set) => set.map((point) => point.month)))].sort();
  return months.map((month) => {
    let inflow = 0;
    let outflow = 0;
    for (const set of sets) {
      const point = set.find((p) => p.month === month);
      if (point) {
        inflow += point.inflow;
        outflow += point.outflow;
      }
    }
    return { month, inflow, outflow };
  });
}

export function CashflowChartWidget({
  settings,
  scopedPortfolios,
  portfoliosLoading,
  size,
}: WidgetProps) {
  const t = useT();
  const months = monthsFor(settings.range);
  const charted = scopedPortfolios.slice(0, MAX_HISTORY_PORTFOLIOS);
  // The visible aggregate totals below use the active base currency. Keep the
  // chart alternative in that same denomination rather than hard-coding EUR.
  const currency = getMoneyCurrency();

  const combined = useQueries({
    queries: charted.map((portfolio) => ({
      queryKey: cashTrendsQueryKey(portfolio.id, months),
      queryFn: ({ signal }: { signal: AbortSignal }) => getCashTrends(portfolio.id, months, signal),
      staleTime: 30_000,
    })),
    combine: (results) => ({
      points: combineCashTrends(results.map((result) => result.data?.points ?? [])),
      loading: results.some((result) => result.isLoading || result.isFetching),
    }),
  });

  const points = combined.points;
  const loading = portfoliosLoading || combined.loading;

  const series = useMemo(
    () =>
      points.map((point) => ({
        time: `${point.month}-01` as Time,
        value: point.inflow - point.outflow,
      })),
    [points],
  );

  const inflow = points.reduce((total, point) => total + point.inflow, 0);
  const outflow = points.reduce((total, point) => total + point.outflow, 0);
  const height = size === 'l' ? 260 : 200;
  const columns = widgetVariant('cashflow-chart', settings) === 'columns';

  if (!portfoliosLoading && charted.length === 0) {
    return <Empty title={t('home.widgets.cashflowChart.empty')} />;
  }

  return (
    <div>
      {columns ? (
        <InOutColumns
          empty={t('home.widgets.cashflowChart.empty')}
          height={height}
          loading={loading}
          points={points}
        />
      ) : (
        <div className="bt-chart">
          <PriceChart
            ariaLabel={t('home.widgets.cashflowChart.ariaLabel')}
            emptyMessage={t('home.widgets.cashflowChart.empty')}
            height={height}
            loading={loading}
            mode="baseline"
            series={series}
            showRangeToggle={false}
            valueCurrency={currency}
          />
        </div>
      )}
      {points.length > 0 ? (
        <p className="bt-meta bt-home-substats">
          <MoneyText amount={inflow} /> {t('home.widgets.cashflowChart.incomeWord')}
          <span aria-hidden="true"> · </span>
          <MoneyText amount={outflow} /> {t('home.widgets.cashflowChart.spentWord')}
          <span aria-hidden="true"> · </span>
          <MoneyText amount={inflow - outflow} signed /> {t('home.widgets.cashflowChart.netWord')}
        </p>
      ) : null}
    </div>
  );
}

/** Bar-pair gap, and the gap between one month's pair and the next. */
const BAR_GAP = 2;
const GROUP_GAP = 10;
/** Room under the plot for the month labels. */
const AXIS_H = 18;

/**
 * Inflow and outflow as two bars per month, on one shared EUR scale.
 *
 * Both bars rise from a common baseline because both are magnitudes; the *pair*
 * carries the comparison and the substats carry the net. Inflow keeps the positive
 * ink and outflow the negative one — here that is not decoration but the actual
 * semantics of the two series, which is the one case the palette reserves them for.
 */
function InOutColumns({
  points,
  height,
  loading,
  empty,
}: {
  points: readonly CashTrendPoint[];
  height: number;
  loading: boolean;
  empty: string;
}) {
  const t = useT();
  if (loading) return <div className="bt-home-cols" style={{ height }} />;
  if (points.length === 0) return <Empty title={empty} />;

  const peak = Math.max(...points.flatMap((point) => [point.inflow, point.outflow]), 0);
  const plotH = height - AXIS_H;

  return (
    <div className="bt-home-cols">
      <div
        aria-label={t('home.widgets.cashflowChart.columnsAriaLabel')}
        className="bt-home-cols__plot"
        role="img"
        style={{ gap: GROUP_GAP, height }}
      >
        {points.map((point) => (
          <div className="bt-home-cols__group" key={point.month} style={{ gap: BAR_GAP }}>
            <div className="bt-home-cols__bars" style={{ gap: BAR_GAP, height: plotH }}>
              {/* A zero-value month still gets a 1px stub, so "nothing came in"
                  reads as a measured zero rather than as missing data. */}
              <span
                style={{
                  background: POSITIVE,
                  height: peak > 0 ? `${Math.max(1, (point.inflow / peak) * plotH)}px` : '1px',
                }}
                title={`${monthLabel(point.month)} · ${formatMoney(point.inflow)}`}
              />
              <span
                style={{
                  background: NEGATIVE,
                  height: peak > 0 ? `${Math.max(1, (point.outflow / peak) * plotH)}px` : '1px',
                }}
                title={`${monthLabel(point.month)} · ${formatMoney(point.outflow)}`}
              />
            </div>
            <span className="bt-meta bt-home-cols__label">{monthLabel(point.month)}</span>
          </div>
        ))}
      </div>
      <p className="bt-meta bt-home-cols__legend">
        <span className="bt-home-cols__key" style={{ background: POSITIVE }} />
        {t('home.widgets.cashflowChart.incomeWord')}
        <span className="bt-home-cols__key" style={{ background: NEGATIVE }} />
        {t('home.widgets.cashflowChart.spentWord')}
      </p>
    </div>
  );
}

/** `YYYY-MM` → the short month the axis shows, in the active locale. */
function monthLabel(month: string): string {
  const parsed = Date.parse(`${month}-01T00:00:00Z`);
  if (!Number.isFinite(parsed)) return month;
  return new Date(parsed).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' });
}
