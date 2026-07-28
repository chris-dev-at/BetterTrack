import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import type { ExpenseCategory, ExpenseTransaction } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { cx } from '../../lib/cx';
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
import { Alert } from '../components/ui';
import { Button } from '../../ui/origin';

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
  const categoriesReady = categoriesQuery.isSuccess;
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

  function retryTransactions() {
    void transactionsQuery.refetch();
  }

  function retryCategories() {
    void categoriesQuery.refetch();
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="bt-meta">{t('expenses.transactions.subtitle')}</p>
        <Button onClick={() => setCreating(true)} disabled={!categoriesReady} variant="primary">
          {t('expenses.transactions.new')}
        </Button>
      </div>

      {transactionsQuery.isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton height="h-14" />
          <Skeleton height="h-14" />
          <Skeleton height="h-14" />
        </div>
      ) : transactionsQuery.isError ? (
        <div className="flex flex-wrap items-center gap-3">
          <Alert tone="error">{t('expenses.transactions.loadError')}</Alert>
          <Button onClick={retryTransactions}>{t('common.retry')}</Button>
        </div>
      ) : transactions.length === 0 ? (
        <EmptyState
          icon="🧾"
          title={t('expenses.transactions.emptyTitle')}
          description={t('expenses.transactions.emptyDescription')}
          cta={
            <Button variant="quiet" onClick={() => setCreating(true)} disabled={!categoriesReady}>
              {t('expenses.transactions.emptyCta')}
            </Button>
          }
        />
      ) : (
        <ul className="bt-band flex flex-col" style={{ borderBlock: '1px solid var(--bt-border)' }}>
          {transactions.map((tx) => {
            const category = tx.categoryId ? categoryById.get(tx.categoryId) : undefined;
            const isIncome = tx.direction === 'income';
            return (
              <li key={tx.id} className="bt-band__row flex flex-wrap items-center gap-3">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: category?.color ?? '#3f3f46' }}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <p className="bt-row-title truncate">{tx.description}</p>
                  <p className="bt-row-sub">
                    {formatDate(tx.bookedOn)} · {t(`expenses.direction.${tx.direction}`)}
                  </p>
                </div>
                <span className={cx('shrink-0 bt-num font-semibold', isIncome && 'bt-pos')}>
                  {isIncome ? '+' : '−'}
                  {formatMoney(tx.amount, tx.currency)}
                </span>
                <label className="sr-only" htmlFor={`recat-${tx.id}`}>
                  {t('expenses.transactions.recategorize')}
                </label>
                <select
                  id={`recat-${tx.id}`}
                  value={categoriesReady ? (tx.categoryId ?? '') : ''}
                  disabled={!categoriesReady || recategorize.isPending}
                  onChange={(e) =>
                    recategorize.mutate({
                      id: tx.id,
                      categoryId: e.target.value === '' ? null : e.target.value,
                    })
                  }
                  className="bt-select shrink-0"
                  style={{ minHeight: 28, padding: '2px 26px 2px 8px', width: 'auto', fontSize: 12 }}
                >
                  {categoriesReady ? (
                    <>
                      <option value="">{t('expenses.transactions.uncategorized')}</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </>
                  ) : (
                    <option value="">
                      {categoriesQuery.isError
                        ? t('expenses.transactions.categoryLoadError')
                        : t('common.loading')}
                    </option>
                  )}
                </select>
                {confirmDeleteId === tx.id ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => remove.mutate(tx.id)}
                      disabled={remove.isPending}
                    >
                      {t('common.confirm')}
                    </Button>
                    <Button variant="quiet" size="sm" onClick={() => setConfirmDeleteId(null)}>
                      {t('common.cancel')}
                    </Button>
                  </span>
                ) : (
                  <span className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="quiet"
                      size="sm"
                      onClick={() => setEditing(tx)}
                      disabled={!categoriesReady}
                    >
                      {t('common.edit')}
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => setConfirmDeleteId(tx.id)}>
                      {t('common.delete')}
                    </Button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {transactionsQuery.isSuccess && categoriesQuery.isError ? (
        <div className="flex flex-wrap items-center gap-3">
          <Alert tone="error">{t('expenses.transactions.categoryLoadError')}</Alert>
          <Button onClick={retryCategories}>{t('common.retry')}</Button>
        </div>
      ) : null}

      {recategorize.isError ? (
        <Alert tone="error">{t('expenses.transactions.recategorizeError')}</Alert>
      ) : null}
      {remove.isError ? <Alert tone="error">{t('expenses.transactions.deleteError')}</Alert> : null}

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
