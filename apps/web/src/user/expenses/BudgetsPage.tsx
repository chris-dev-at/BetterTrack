import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import type { ExpenseBudgetProgress } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { formatMoney } from '../../lib/format';
import {
  EXPENSE_BUDGETS_QUERY_KEY,
  EXPENSE_CATEGORIES_QUERY_KEY,
  deleteExpenseBudget,
  listExpenseBudgets,
  listExpenseCategories,
} from '../../lib/expensesApi';
import { EmptyState, Skeleton } from '../../ui';
import { Alert, Button, cx } from '../components/ui';

import { BudgetDialog } from './BudgetDialog';

/**
 * Per-category monthly budgets (PROJECTPLAN.md §13.5 V5-P9, issue 3/3): one
 * compact block listing each budget's spend-to-date against its target for the
 * current month, with a matrix-routed alert firing once a target is blown (the
 * alert wiring is server-side). Create / edit / delete stay in one place per the
 * anti-bloat rule.
 */

/** Progress-bar tint: over budget → red, close → amber, else green. */
function barTone(budget: ExpenseBudgetProgress): string {
  if (budget.exceeded) return 'bg-red-500';
  if (budget.amount > 0 && budget.spent / budget.amount >= 0.8) return 'bg-amber-500';
  return 'bg-emerald-500';
}

export function BudgetsPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ExpenseBudgetProgress | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const budgetsQuery = useQuery({
    queryKey: EXPENSE_BUDGETS_QUERY_KEY,
    queryFn: ({ signal }) => listExpenseBudgets(undefined, signal),
    staleTime: 30_000,
  });
  const categoriesQuery = useQuery({
    queryKey: EXPENSE_CATEGORIES_QUERY_KEY,
    queryFn: ({ signal }) => listExpenseCategories(signal),
    staleTime: 30_000,
  });

  const budgets = budgetsQuery.data?.budgets ?? [];
  const categories = categoriesQuery.data?.categories ?? [];
  const budgetedCategoryIds = useMemo(() => new Set(budgets.map((b) => b.categoryId)), [budgets]);

  const remove = useMutation({
    mutationFn: (id: string) => deleteExpenseBudget(id),
    onSuccess: () => {
      setConfirmDeleteId(null);
      void queryClient.invalidateQueries({ queryKey: EXPENSE_BUDGETS_QUERY_KEY });
    },
  });

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-neutral-500">{t('expenses.budgets.subtitle')}</p>
        <Button onClick={() => setCreating(true)}>{t('expenses.budgets.new')}</Button>
      </div>

      {budgetsQuery.isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton height="h-16" />
          <Skeleton height="h-16" />
        </div>
      ) : budgetsQuery.isError ? (
        <Alert tone="error">{t('expenses.budgets.loadError')}</Alert>
      ) : budgets.length === 0 ? (
        <EmptyState
          icon="🎯"
          title={t('expenses.budgets.emptyTitle')}
          description={t('expenses.budgets.emptyDescription')}
          cta={
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded text-sm text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              {t('expenses.budgets.emptyCta')}
            </button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {budgets.map((b) => {
            const pct = b.amount > 0 ? Math.min(100, (b.spent / b.amount) * 100) : 0;
            return (
              <li key={b.id} className="rounded-lg border border-neutral-800 p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: b.categoryColor }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-200">
                    {b.categoryName}
                  </span>
                  {b.exceeded ? (
                    <span className="shrink-0 rounded-full bg-red-950/60 px-2 py-0.5 text-xs font-medium text-red-400">
                      {t('expenses.budgets.exceeded')}
                    </span>
                  ) : null}
                  <span className="shrink-0 text-sm tabular-nums text-neutral-300">
                    {formatMoney(b.spent, b.currency)} / {formatMoney(b.amount, b.currency)}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setEditing(b)}
                      className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
                    >
                      {t('common.edit')}
                    </button>
                    {confirmDeleteId === b.id ? (
                      <>
                        <button
                          type="button"
                          onClick={() => remove.mutate(b.id)}
                          disabled={remove.isPending}
                          className="rounded px-2 py-1 text-xs font-medium text-red-400 hover:bg-red-950/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                        >
                          {t('common.confirm')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
                        >
                          {t('common.cancel')}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(b.id)}
                        className="rounded px-2 py-1 text-xs text-neutral-500 hover:text-red-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                      >
                        {t('common.delete')}
                      </button>
                    )}
                  </span>
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <div
                    className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-800"
                    role="progressbar"
                    aria-valuenow={Math.round(pct)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={b.categoryName}
                  >
                    <div
                      className={cx('h-full rounded-full', barTone(b))}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span
                    className={cx(
                      'shrink-0 text-xs tabular-nums',
                      b.remaining < 0 ? 'text-red-400' : 'text-neutral-500',
                    )}
                  >
                    {b.remaining < 0
                      ? t('expenses.budgets.over', {
                          amount: formatMoney(Math.abs(b.remaining), b.currency),
                        })
                      : t('expenses.budgets.left', {
                          amount: formatMoney(b.remaining, b.currency),
                        })}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {creating ? (
        <BudgetDialog
          categories={categories}
          budgetedCategoryIds={budgetedCategoryIds}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {editing ? (
        <BudgetDialog
          existing={editing}
          categories={categories}
          budgetedCategoryIds={budgetedCategoryIds}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  );
}
