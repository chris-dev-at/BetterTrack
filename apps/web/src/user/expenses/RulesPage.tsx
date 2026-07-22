import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import type { ExpenseRule } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import {
  EXPENSE_CATEGORIES_QUERY_KEY,
  EXPENSE_RULES_QUERY_KEY,
  deleteExpenseRule,
  listExpenseCategories,
  listExpenseRules,
} from '../../lib/expensesApi';
import { EmptyState, Skeleton } from '../../ui';
import { Alert, Button } from '../components/ui';

import { RuleDialog } from './RuleDialog';

/**
 * Auto-categorization rules manager (PROJECTPLAN.md §13.5 V5-P9, issue 2/3).
 * User-editable rules match a transaction's description and file it under a
 * category — applied on CSV import (and re-runnable). Ordered by priority (first
 * match wins). Compact per the anti-bloat rule.
 */
export function RulesPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ExpenseRule | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const rulesQuery = useQuery({
    queryKey: EXPENSE_RULES_QUERY_KEY,
    queryFn: ({ signal }) => listExpenseRules(signal),
    staleTime: 30_000,
  });
  const categoriesQuery = useQuery({
    queryKey: EXPENSE_CATEGORIES_QUERY_KEY,
    queryFn: ({ signal }) => listExpenseCategories(signal),
    staleTime: 30_000,
  });

  const categories = useMemo(() => categoriesQuery.data?.categories ?? [], [categoriesQuery.data]);
  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  const remove = useMutation({
    mutationFn: (id: string) => deleteExpenseRule(id),
    onSuccess: () => {
      setConfirmDeleteId(null);
      void queryClient.invalidateQueries({ queryKey: EXPENSE_RULES_QUERY_KEY });
    },
  });

  const rules = rulesQuery.data?.rules ?? [];

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-neutral-500">{t('expenses.rules.subtitle')}</p>
        <Button onClick={() => setCreating(true)} disabled={categories.length === 0}>
          {t('expenses.rules.new')}
        </Button>
      </div>

      {rulesQuery.isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton height="h-12" />
          <Skeleton height="h-12" />
        </div>
      ) : rulesQuery.isError ? (
        <Alert tone="error">{t('expenses.rules.loadError')}</Alert>
      ) : rules.length === 0 ? (
        <EmptyState
          title={t('expenses.rules.emptyTitle')}
          description={t('expenses.rules.emptyDescription')}
        />
      ) : (
        <ul className="flex flex-col divide-y divide-neutral-800 rounded-lg border border-neutral-800">
          {rules.map((rule) => {
            const category = categoryById.get(rule.categoryId);
            return (
              <li key={rule.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-neutral-200">
                    <span className="text-neutral-500">
                      {t(`expenses.rules.matchType.${rule.matchType}`)}
                    </span>{' '}
                    <span className="font-medium">“{rule.pattern}”</span>
                    {!rule.enabled ? (
                      <span className="ml-2 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium uppercase text-neutral-400">
                        {t('expenses.rules.disabled')}
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-xs text-neutral-500">
                    <span aria-hidden="true">→</span>
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: category?.color ?? '#64748b' }}
                      aria-hidden="true"
                    />
                    {category?.name ?? t('expenses.rules.unknownCategory')}
                  </p>
                </div>
                {confirmDeleteId === rule.id ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => remove.mutate(rule.id)}
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
                      onClick={() => setEditing(rule)}
                      className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
                    >
                      {t('common.edit')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(rule.id)}
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

      {remove.isError ? <Alert tone="error">{t('expenses.rules.deleteError')}</Alert> : null}

      {creating ? <RuleDialog categories={categories} onClose={() => setCreating(false)} /> : null}
      {editing ? (
        <RuleDialog existing={editing} categories={categories} onClose={() => setEditing(null)} />
      ) : null}
    </section>
  );
}
