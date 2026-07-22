import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { useT } from '../../i18n';
import { formatMoney } from '../../lib/format';
import {
  EXPENSE_SUMMARY_QUERY_KEY,
  EXPENSE_TRENDS_QUERY_KEY,
  getExpenseSummary,
  getExpenseTrends,
} from '../../lib/expensesApi';
import { EmptyState, Skeleton, StatCard } from '../../ui';
import { AllocationDonut } from '../../ui/charts';
import { Alert, cx } from '../components/ui';

/**
 * Expense dashboard (PROJECTPLAN.md §13.5 V5-P9, issue 3/3): spend by category
 * and income-vs-spend for a chosen month, plus a trailing-months trend. Reuses
 * the shared chart + StatCard conventions (`apps/web/src/ui`); currency-naive by
 * design (the area is single-currency, no FX) — amounts render in EUR. Compact
 * per the anti-bloat rule.
 */

const TREND_MONTHS = 6;
const DISPLAY_CURRENCY = 'EUR';

/** The current calendar month `YYYY-MM` (UTC — matches the server's period). */
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** A short localized month label for a `YYYY-MM` key (e.g. "Jul"). */
function shortMonthLabel(month: string): string {
  const parts = month.split('-');
  const year = Number(parts[0]);
  const monthIndex = Number(parts[1]) - 1;
  return new Date(Date.UTC(year, monthIndex, 1)).toLocaleDateString(undefined, {
    month: 'short',
    timeZone: 'UTC',
  });
}

export function DashboardPage() {
  const t = useT();
  const [month, setMonth] = useState(currentMonth());

  const summaryQuery = useQuery({
    queryKey: [...EXPENSE_SUMMARY_QUERY_KEY, month],
    queryFn: ({ signal }) => getExpenseSummary(month, signal),
    staleTime: 30_000,
  });
  const trendsQuery = useQuery({
    queryKey: [...EXPENSE_TRENDS_QUERY_KEY, TREND_MONTHS],
    queryFn: ({ signal }) => getExpenseTrends(TREND_MONTHS, signal),
    staleTime: 30_000,
  });

  const summary = summaryQuery.data;
  const segments = useMemo(
    () =>
      (summary?.categories ?? [])
        .filter((c) => c.expense > 0)
        .map((c) => ({
          label: c.name ?? t('expenses.dashboard.uncategorized'),
          value: c.expense,
          color: c.color ?? undefined,
        })),
    [summary, t],
  );

  const trendPoints = trendsQuery.data?.points ?? [];
  const trendMax = Math.max(1, ...trendPoints.flatMap((p) => [p.expense, p.income]));
  const trendEmpty = trendPoints.every((p) => p.expense === 0 && p.income === 0);
  const monthEmpty = !!summary && summary.totalExpense === 0 && summary.totalIncome === 0;

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-neutral-500">{t('expenses.dashboard.subtitle')}</p>
        <label className="flex items-center gap-2 text-sm text-neutral-400">
          <span>{t('expenses.dashboard.month')}</span>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value || currentMonth())}
            aria-label={t('expenses.dashboard.month')}
            className="rounded-md bg-neutral-950 px-2 py-1 text-sm text-neutral-100 ring-1 ring-inset ring-neutral-700 focus:outline-none focus:ring-2 focus:ring-sky-500"
          />
        </label>
      </div>

      {summaryQuery.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Skeleton height="h-20" />
          <Skeleton height="h-20" />
          <Skeleton height="h-20" />
        </div>
      ) : summaryQuery.isError ? (
        <Alert tone="error">{t('expenses.dashboard.loadError')}</Alert>
      ) : (
        <>
          {/* Income vs spend headline. */}
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard
              label={t('expenses.dashboard.income')}
              value={
                <span className="text-emerald-400">
                  {formatMoney(summary?.totalIncome ?? 0, DISPLAY_CURRENCY)}
                </span>
              }
            />
            <StatCard
              label={t('expenses.dashboard.spend')}
              value={formatMoney(summary?.totalExpense ?? 0, DISPLAY_CURRENCY)}
            />
            <StatCard
              label={t('expenses.dashboard.net')}
              value={
                <span className={cx((summary?.net ?? 0) < 0 ? 'text-red-400' : 'text-neutral-100')}>
                  {formatMoney(summary?.net ?? 0, DISPLAY_CURRENCY)}
                </span>
              }
            />
          </div>

          {/* Spend by category. */}
          <div className="rounded-lg border border-neutral-800 p-4">
            <h2 className="mb-3 text-sm font-semibold text-neutral-200">
              {t('expenses.dashboard.spendByCategory')}
            </h2>
            {monthEmpty || segments.length === 0 ? (
              <p className="text-sm text-neutral-500">{t('expenses.dashboard.noSpend')}</p>
            ) : (
              <AllocationDonut data={segments} title={t('expenses.dashboard.spendByCategory')} />
            )}
          </div>
        </>
      )}

      {/* Income vs spend trend (independent of the chosen month). */}
      <div className="rounded-lg border border-neutral-800 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-neutral-200">
            {t('expenses.dashboard.trend')}
          </h2>
          <div className="flex items-center gap-3 text-xs text-neutral-400">
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-rose-500/80" aria-hidden="true" />
              {t('expenses.dashboard.spend')}
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-emerald-500/80" aria-hidden="true" />
              {t('expenses.dashboard.income')}
            </span>
          </div>
        </div>
        {trendsQuery.isLoading ? (
          <Skeleton height="h-32" />
        ) : trendsQuery.isError ? (
          <Alert tone="error">{t('expenses.dashboard.loadError')}</Alert>
        ) : trendEmpty ? (
          <EmptyState
            icon="📊"
            title={t('expenses.dashboard.emptyTitle')}
            description={t('expenses.dashboard.emptyDescription')}
          />
        ) : (
          <ul className="flex h-36 items-end gap-2" aria-label={t('expenses.dashboard.trend')}>
            {trendPoints.map((p) => (
              <li key={p.month} className="flex flex-1 flex-col items-center gap-1">
                <div className="flex w-full flex-1 items-end justify-center gap-1">
                  <span
                    className="w-2.5 rounded-t bg-rose-500/80"
                    style={{ height: `${(p.expense / trendMax) * 100}%` }}
                    title={`${shortMonthLabel(p.month)} · ${t('expenses.dashboard.spend')}: ${formatMoney(p.expense, DISPLAY_CURRENCY)}`}
                  />
                  <span
                    className="w-2.5 rounded-t bg-emerald-500/80"
                    style={{ height: `${(p.income / trendMax) * 100}%` }}
                    title={`${shortMonthLabel(p.month)} · ${t('expenses.dashboard.income')}: ${formatMoney(p.income, DISPLAY_CURRENCY)}`}
                  />
                </div>
                <span className="text-[10px] text-neutral-500">{shortMonthLabel(p.month)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
