import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import type { ExpenseCategory, ExpenseTransaction } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { formatDate, formatMoney } from '../../lib/format';
import {
  EXPENSE_CATEGORIES_QUERY_KEY,
  EXPENSE_TRANSACTIONS_QUERY_KEY,
  deleteExpenseTransaction,
  listExpenseCategories,
  listExpenseTransactions,
  recategorizeExpenseTransaction,
} from '../../lib/expensesApi';
import { EmptyState, Skeleton } from '../../ui';
import { Alert, Button, cx } from '../components/ui';

import { TransactionDialog } from './TransactionDialog';

/**
 * Expense transaction list (PROJECTPLAN.md §13.5 V5-P9, foundation 1/3). Add /
 * edit / delete a spend or income row, and recategorize any row inline via its
 * per-row category select — the dedicated recategorize path. Compact per the
 * anti-bloat rule.
 */
export function TransactionsPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ExpenseTransaction | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const categoriesQuery = useQuery({
    queryKey: EXPENSE_CATEGORIES_QUERY_KEY,
    queryFn: ({ signal }) => listExpenseCategories(signal),
    staleTime: 30_000,
  });
  const transactionsQuery = useQuery({
    queryKey: EXPENSE_TRANSACTIONS_QUERY_KEY,
    queryFn: ({ signal }) => listExpenseTransactions(undefined, signal),
    staleTime: 30_000,
  });

  const categories = useMemo(() => categoriesQuery.data?.categories ?? [], [categoriesQuery.data]);
  const categoryById = useMemo(() => {
    const map = new Map<string, ExpenseCategory>();
    for (const c of categories) map.set(c.id, c);
    return map;
  }, [categories]);

  const recategorize = useMutation({
    mutationFn: ({ id, categoryId }: { id: string; categoryId: string | null }) =>
      recategorizeExpenseTransaction(id, categoryId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: EXPENSE_TRANSACTIONS_QUERY_KEY }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteExpenseTransaction(id),
    onSuccess: () => {
      setConfirmDeleteId(null);
      void queryClient.invalidateQueries({ queryKey: EXPENSE_TRANSACTIONS_QUERY_KEY });
    },
  });

  const transactions = transactionsQuery.data?.transactions ?? [];

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-neutral-500">{t('expenses.transactions.subtitle')}</p>
        <Button onClick={() => setCreating(true)}>{t('expenses.transactions.new')}</Button>
      </div>

      {transactionsQuery.isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton height="h-14" />
          <Skeleton height="h-14" />
          <Skeleton height="h-14" />
        </div>
      ) : transactionsQuery.isError ? (
        <Alert tone="error">{t('expenses.transactions.loadError')}</Alert>
      ) : transactions.length === 0 ? (
        <EmptyState
          icon="🧾"
          title={t('expenses.transactions.emptyTitle')}
          description={t('expenses.transactions.emptyDescription')}
          cta={
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded text-sm text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              {t('expenses.transactions.emptyCta')}
            </button>
          }
        />
      ) : (
        <ul className="flex flex-col divide-y divide-neutral-800 rounded-lg border border-neutral-800">
          {transactions.map((tx) => {
            const category = tx.categoryId ? categoryById.get(tx.categoryId) : undefined;
            const isIncome = tx.direction === 'income';
            return (
              <li key={tx.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: category?.color ?? '#3f3f46' }}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-neutral-200">{tx.description}</p>
                  <p className="text-xs text-neutral-500">{formatDate(tx.bookedOn)}</p>
                </div>
                <span
                  className={cx(
                    'shrink-0 text-sm font-semibold tabular-nums',
                    isIncome ? 'text-emerald-400' : 'text-neutral-200',
                  )}
                >
                  {isIncome ? '+' : '−'}
                  {formatMoney(tx.amount, tx.currency)}
                </span>
                <label className="sr-only" htmlFor={`recat-${tx.id}`}>
                  {t('expenses.transactions.recategorize')}
                </label>
                <select
                  id={`recat-${tx.id}`}
                  value={tx.categoryId ?? ''}
                  disabled={recategorize.isPending}
                  onChange={(e) =>
                    recategorize.mutate({
                      id: tx.id,
                      categoryId: e.target.value === '' ? null : e.target.value,
                    })
                  }
                  className="shrink-0 rounded-md bg-neutral-950 px-2 py-1 text-xs text-neutral-200 ring-1 ring-inset ring-neutral-700 focus:outline-none focus:ring-2 focus:ring-sky-500"
                >
                  <option value="">{t('expenses.transactions.uncategorized')}</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {confirmDeleteId === tx.id ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => remove.mutate(tx.id)}
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
                  </span>
                ) : (
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setEditing(tx)}
                      className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
                    >
                      {t('common.edit')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(tx.id)}
                      className="rounded px-2 py-1 text-xs text-neutral-500 hover:text-red-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                    >
                      {t('common.delete')}
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {creating ? (
        <TransactionDialog categories={categories} onClose={() => setCreating(false)} />
      ) : null}
      {editing ? (
        <TransactionDialog
          categories={categories}
          existing={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  );
}
