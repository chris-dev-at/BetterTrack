import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Time } from 'lightweight-charts';

import type { ExpenseTrendPoint } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { EXPENSE_TRENDS_QUERY_KEY, getExpenseTrends } from '../../../lib/expensesApi';
import { formatMoney } from '../../../lib/format';
import { MoneyText } from '../../../ui';
import { PriceChart } from '../../../ui/charts';
import { NEGATIVE, POSITIVE } from '../../../ui/charts/palette';
import { Empty } from '../../../ui/origin';
import { widgetVariant } from '../config';
import type { WidgetProps } from './types';

/**
 * Cash flow over time, from the Cash flow area's existing trend endpoint
 * (`GET /expenses/trends?months=`, the same `['expenses','trends', months]`
 * cache entry its dashboard uses).
 *
 * **Scope note.** That area is user-level: the expense ledger carries no
 * portfolio dimension, so there is no per-portfolio cash-flow series to chart
 * and this widget deliberately offers no scope picker rather than showing a
 * control that would silently do nothing.
 *
 * **Two forms, two questions.**
 *
 *  - `net` (default) — "did I put money away or burn it?", a polarity question.
 *    One series (income − spend) in the chart core's `baseline` mode, which
 *    colours above/below zero. The gross figures stay as quiet substats beneath.
 *  - `columns` — "what came in and what went out each month?", which the net view
 *    deliberately hides: a flat net month can be €200 in/€200 out or €9k in/€9k
 *    out. Income and spend become two bars per month.
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

export function CashflowChartWidget({ settings, size }: WidgetProps) {
  const t = useT();
  const months = monthsFor(settings.range);

  const trendsQuery = useQuery({
    queryKey: [...EXPENSE_TRENDS_QUERY_KEY, months],
    queryFn: ({ signal }) => getExpenseTrends(months, signal),
    staleTime: 30_000,
  });

  const points = useMemo(() => trendsQuery.data?.points ?? [], [trendsQuery.data]);

  // `month` is a `YYYY-MM` bucket key; the chart axis wants a day.
  const series = useMemo(
    () =>
      points.map((point) => ({
        time: `${point.month}-01` as Time,
        value: point.income - point.expense,
      })),
    [points],
  );

  const income = points.reduce((total, point) => total + point.income, 0);
  const expense = points.reduce((total, point) => total + point.expense, 0);
  const height = size === 'l' ? 260 : 200;
  const columns = widgetVariant('cashflow-chart', settings) === 'columns';

  return (
    <div>
      {columns ? (
        <InOutColumns
          empty={t('home.widgets.cashflowChart.empty')}
          height={height}
          loading={trendsQuery.isLoading}
          points={points}
        />
      ) : (
        <div className="bt-chart">
          <PriceChart
            ariaLabel={t('home.widgets.cashflowChart.ariaLabel')}
            emptyMessage={t('home.widgets.cashflowChart.empty')}
            height={height}
            loading={trendsQuery.isLoading}
            mode="baseline"
            series={series}
            showRangeToggle={false}
            valueCurrency="EUR"
          />
        </div>
      )}
      {points.length > 0 ? (
        <p className="bt-meta bt-home-substats">
          <MoneyText amount={income} /> {t('home.widgets.cashflowChart.incomeWord')}
          <span aria-hidden="true"> · </span>
          <MoneyText amount={expense} /> {t('home.widgets.cashflowChart.spentWord')}
          <span aria-hidden="true"> · </span>
          <MoneyText amount={income - expense} signed /> {t('home.widgets.cashflowChart.netWord')}
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
 * Income and spend as two bars per month, on one shared EUR scale.
 *
 * Both bars rise from a common baseline because both are magnitudes; the *pair*
 * carries the comparison and the substats carry the net. Income keeps the positive
 * ink and spend the negative one — here that is not decoration but the actual
 * semantics of the two series, which is the one case the palette reserves them for.
 */
function InOutColumns({
  points,
  height,
  loading,
  empty,
}: {
  points: readonly ExpenseTrendPoint[];
  height: number;
  loading: boolean;
  empty: string;
}) {
  const t = useT();
  if (loading) return <div className="bt-home-cols" style={{ height }} />;
  if (points.length === 0) return <Empty title={empty} />;

  const peak = Math.max(...points.flatMap((point) => [point.income, point.expense]), 0);
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
                  height: peak > 0 ? `${Math.max(1, (point.income / peak) * plotH)}px` : '1px',
                }}
                title={`${monthLabel(point.month)} · ${formatMoney(point.income)}`}
              />
              <span
                style={{
                  background: NEGATIVE,
                  height: peak > 0 ? `${Math.max(1, (point.expense / peak) * plotH)}px` : '1px',
                }}
                title={`${monthLabel(point.month)} · ${formatMoney(point.expense)}`}
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
