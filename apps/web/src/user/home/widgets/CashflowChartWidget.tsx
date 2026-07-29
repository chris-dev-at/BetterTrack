import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Time } from 'lightweight-charts';

import { useT } from '../../../i18n';
import { EXPENSE_TRENDS_QUERY_KEY, getExpenseTrends } from '../../../lib/expensesApi';
import { MoneyText } from '../../../ui';
import { PriceChart } from '../../../ui/charts';
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
 * **Form.** One month is a bucket, and the question the chart answers is
 * "did I put money away or burn it?" — a polarity question. So it plots the
 * single *net* series (income − spend) in the chart core's `baseline` mode,
 * which colours above/below zero, instead of racing two same-unit series
 * against each other. The two gross figures stay as quiet substats beneath.
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

  return (
    <div>
      <div className="bt-chart">
        <PriceChart
          ariaLabel={t('home.widgets.cashflowChart.ariaLabel')}
          emptyMessage={t('home.widgets.cashflowChart.empty')}
          height={size === 'l' ? 260 : 200}
          loading={trendsQuery.isLoading}
          mode="baseline"
          series={series}
          showRangeToggle={false}
        />
      </div>
      {points.length > 0 ? (
        <p className="bt-meta bt-home-substats">
          <MoneyText amount={income} /> {t('home.widgets.cashflowChart.incomeWord')}
          <span aria-hidden="true"> · </span>
          <MoneyText amount={expense} /> {t('home.widgets.cashflowChart.spentWord')}
        </p>
      ) : null}
    </div>
  );
}
