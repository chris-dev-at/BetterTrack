import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { EXPENSE_DIRECTIONS, type ExpenseCategory } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import {
  EXPENSE_CATEGORIES_QUERY_KEY,
  deleteExpenseCategory,
  listExpenseCategories,
} from '../../lib/expensesApi';
import { Skeleton } from '../../ui';
import { Alert, Button } from '../components/ui';

import { CategoryDialog } from './CategoryDialog';

/**
 * Expense category manager (PROJECTPLAN.md §13.5 V5-P9, foundation 1/3). The
 * seeded starter set is created on first load; add / edit / delete categories,
 * grouped by direction (spend / income). Deleting a category leaves its
 * transactions uncategorized (server SET-NULLs the reference). Compact per the
 * anti-bloat rule.
 */
export function CategoriesPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ExpenseCategory | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: EXPENSE_CATEGORIES_QUERY_KEY,
    queryFn: ({ signal }) => listExpenseCategories(signal),
    staleTime: 30_000,
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteExpenseCategory(id),
    onSuccess: () => {
      setConfirmDeleteId(null);
      void queryClient.invalidateQueries({ queryKey: EXPENSE_CATEGORIES_QUERY_KEY });
    },
  });

  const categories = query.data?.categories ?? [];

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-neutral-500">{t('expenses.categories.subtitle')}</p>
        <Button onClick={() => setCreating(true)}>{t('expenses.categories.new')}</Button>
      </div>

      {query.isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton height="h-12" />
          <Skeleton height="h-12" />
        </div>
      ) : query.isError ? (
        <Alert tone="error">{t('expenses.categories.loadError')}</Alert>
      ) : (
        EXPENSE_DIRECTIONS.map((direction) => {
          const group = categories.filter((c) => c.direction === direction);
          if (group.length === 0) return null;
          return (
            <div key={direction} className="flex flex-col gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                {t(`expenses.direction.${direction}Plural`)}
              </h2>
              <ul className="flex flex-col divide-y divide-neutral-800 rounded-lg border border-neutral-800">
                {group.map((category) => (
                  <li key={category.id} className="flex items-center gap-3 px-4 py-2.5">
                    <span
                      className="h-3 w-3 shrink-0 rounded-full"
                      style={{ backgroundColor: category.color }}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">
                      {category.name}
                    </span>
                    {confirmDeleteId === category.id ? (
                      <span className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => remove.mutate(category.id)}
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
                          onClick={() => setEditing(category)}
                          className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
                        >
                          {t('common.edit')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(category.id)}
                          className="rounded px-2 py-1 text-xs text-neutral-500 hover:text-red-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                        >
                          {t('common.delete')}
                        </button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })
      )}

      {remove.isError ? <Alert tone="error">{t('expenses.categories.deleteError')}</Alert> : null}

      {creating ? <CategoryDialog onClose={() => setCreating(false)} /> : null}
      {editing ? <CategoryDialog existing={editing} onClose={() => setEditing(null)} /> : null}
    </section>
  );
}
