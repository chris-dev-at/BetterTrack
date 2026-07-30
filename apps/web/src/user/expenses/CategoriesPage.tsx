import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { EXPENSE_DIRECTIONS, type ExpenseCategory } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import {
  EXPENSE_CATEGORIES_QUERY_KEY,
  deleteExpenseCategory,
  listExpenseCategories,
} from '../../lib/expensesApi';
import { EmptyState, Skeleton } from '../../ui';
import { Alert } from '../components/ui';
import { Button } from '../../ui/origin';

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

  function retryCategories() {
    void query.refetch();
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="bt-meta">{t('expenses.categories.subtitle')}</p>
        <Button onClick={() => setCreating(true)} variant="primary">
          {t('expenses.categories.new')}
        </Button>
      </div>

      {query.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton height="h-12" />
          <Skeleton height="h-12" />
        </div>
      ) : query.isError ? (
        <div className="flex flex-wrap items-center gap-3">
          <Alert tone="error">{t('expenses.categories.loadError')}</Alert>
          <Button onClick={retryCategories} disabled={query.isFetching}>
            {t('common.retry')}
          </Button>
        </div>
      ) : categories.length === 0 ? (
        <EmptyState
          title={t('expenses.categories.emptyTitle')}
          description={t('expenses.categories.emptyDescription')}
          compact
          cta={
            <Button onClick={() => setCreating(true)}>{t('expenses.categories.emptyCta')}</Button>
          }
        />
      ) : (
        EXPENSE_DIRECTIONS.map((direction) => {
          const group = categories.filter((c) => c.direction === direction);
          if (group.length === 0) return null;
          return (
            <div key={direction} className="flex flex-col gap-2">
              <h2 className="bt-label">{t(`expenses.direction.${direction}Plural`)}</h2>
              <ul
                className="bt-band flex flex-col"
                style={{ borderBlock: '1px solid var(--bt-border)' }}
              >
                {group.map((category) => (
                  <li key={category.id} className="bt-band__row flex items-center gap-3">
                    <span
                      className="h-3 w-3 shrink-0 rounded-full"
                      style={{ backgroundColor: category.color }}
                      aria-hidden="true"
                    />
                    <span className="bt-row-title min-w-0 flex-1 truncate">{category.name}</span>
                    {confirmDeleteId === category.id ? (
                      <span className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => remove.mutate(category.id)}
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
                        <Button variant="quiet" size="sm" onClick={() => setEditing(category)}>
                          {t('common.edit')}
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => setConfirmDeleteId(category.id)}
                        >
                          {t('common.delete')}
                        </Button>
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
