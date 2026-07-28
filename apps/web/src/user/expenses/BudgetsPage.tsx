import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import type { ExpenseBudgetProgress } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { cx } from '../../lib/cx';
import { formatMoney } from '../../lib/format';
import {
  EXPENSE_BUDGETS_QUERY_KEY,
  EXPENSE_CATEGORIES_QUERY_KEY,
  deleteExpenseBudget,
  listExpenseBudgets,
  listExpenseCategories,
} from '../../lib/expensesApi';
import { EmptyState, Skeleton } from '../../ui';
import { Alert } from '../components/ui';
import { Badge, Button } from '../../ui/origin';

import { BudgetDialog } from './BudgetDialog';

/**
 * Per-category monthly budgets (PROJECTPLAN.md §13.5 V5-P9, issue 3/3): one
 * compact block listing each budget's spend-to-date against its target for the
 * current month, with a matrix-routed alert firing once a target is blown (the
 * alert wiring is server-side). Create / edit / delete stay in one place per the
 * anti-bloat rule.
 */

/** Progress-bar fill (Origin): analytical blue on track, negative red once exceeded. */
function barTone(budget: ExpenseBudgetProgress): string {
  return budget.exceeded ? 'var(--bt-neg)' : 'var(--bt-blue)';
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
  const prerequisitesPending = budgetsQuery.isPending || categoriesQuery.isPending;
  const prerequisitesFailed = budgetsQuery.isError || categoriesQuery.isError;
  const hasUsableCategories = categories.some((category) => category.direction === 'expense');
  const hasUnbudgetedExpenseCategory = categories.some(
    (category) => category.direction === 'expense' && !budgetedCategoryIds.has(category.id),
  );
  const canCreateBudget =
    !prerequisitesPending && !prerequisitesFailed && hasUnbudgetedExpenseCategory;
  const canEditBudget = !prerequisitesPending && !prerequisitesFailed && hasUsableCategories;

  const remove = useMutation({
    mutationFn: (id: string) => deleteExpenseBudget(id),
    onSuccess: () => {
      setConfirmDeleteId(null);
      void queryClient.invalidateQueries({ queryKey: EXPENSE_BUDGETS_QUERY_KEY });
    },
  });

  function retryPrerequisites() {
    void budgetsQuery.refetch();
    void categoriesQuery.refetch();
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="bt-meta">{t('expenses.budgets.subtitle')}</p>
        <Button onClick={() => setCreating(true)} disabled={!canCreateBudget} variant="primary">
          {t('expenses.budgets.new')}
        </Button>
      </div>

      {prerequisitesPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton height="h-16" />
          <Skeleton height="h-16" />
        </div>
      ) : prerequisitesFailed ? (
        <div className="flex flex-wrap items-center gap-3">
          <Alert tone="error">{t('expenses.budgets.loadError')}</Alert>
          <Button onClick={retryPrerequisites}>{t('common.retry')}</Button>
        </div>
      ) : budgets.length === 0 ? (
        <EmptyState
          icon="🎯"
          title={t('expenses.budgets.emptyTitle')}
          description={t('expenses.budgets.emptyDescription')}
          cta={
            <Button variant="quiet" onClick={() => setCreating(true)} disabled={!canCreateBudget}>
              {t('expenses.budgets.emptyCta')}
            </Button>
          }
        />
      ) : (
        <ul className="bt-band flex flex-col" style={{ borderBlock: '1px solid var(--bt-border)' }}>
          {budgets.map((b) => {
            const pct = b.amount > 0 ? Math.min(100, (b.spent / b.amount) * 100) : 0;
            return (
              <li key={b.id} className="bt-band__row">
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: b.categoryColor }}
                    aria-hidden="true"
                  />
                  <span className="bt-row-title min-w-0 flex-1 truncate">{b.categoryName}</span>
                  {b.exceeded ? <Badge tone="neg">{t('expenses.budgets.exceeded')}</Badge> : null}
                  <span className="shrink-0 bt-num bt-soft">
                    {formatMoney(b.spent, b.currency)} / {formatMoney(b.amount, b.currency)}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="quiet"
                      size="sm"
                      onClick={() => setEditing(b)}
                      disabled={!canEditBudget}
                    >
                      {t('common.edit')}
                    </Button>
                    {confirmDeleteId === b.id ? (
                      <>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => remove.mutate(b.id)}
                          disabled={remove.isPending}
                        >
                          {t('common.confirm')}
                        </Button>
                        <Button variant="quiet" size="sm" onClick={() => setConfirmDeleteId(null)}>
                          {t('common.cancel')}
                        </Button>
                      </>
                    ) : (
                      <Button variant="danger" size="sm" onClick={() => setConfirmDeleteId(b.id)}>
                        {t('common.delete')}
                      </Button>
                    )}
                  </span>
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <div
                    className="h-2 flex-1 overflow-hidden rounded-full"
                    style={{ background: 'var(--bt-surface-strong)' }}
                    role="progressbar"
                    aria-valuenow={Math.round(pct)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={b.categoryName}
                  >
                    <div className="h-full rounded-full" style={{ width: `${pct}%`, background: barTone(b) }} />
                  </div>
                  <span
                    className={cx('shrink-0 bt-num', b.remaining < 0 ? 'bt-neg' : 'bt-muted')}
                    style={{ fontSize: 12 }}
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

      {remove.isError ? <Alert tone="error">{t('expenses.budgets.deleteError')}</Alert> : null}

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
