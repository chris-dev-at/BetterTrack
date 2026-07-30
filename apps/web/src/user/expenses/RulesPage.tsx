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
import { Alert } from '../components/ui';
import { Badge, Button } from '../../ui/origin';

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
  const isLoading = rulesQuery.isPending || categoriesQuery.isPending;
  const hasLoadError = rulesQuery.isError || categoriesQuery.isError;

  function retryPrerequisites() {
    if (rulesQuery.isError) void rulesQuery.refetch();
    if (categoriesQuery.isError) void categoriesQuery.refetch();
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="bt-meta">{t('expenses.rules.subtitle')}</p>
        <Button
          onClick={() => setCreating(true)}
          disabled={categories.length === 0}
          variant="primary"
        >
          {t('expenses.rules.new')}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton height="h-12" />
          <Skeleton height="h-12" />
        </div>
      ) : hasLoadError ? (
        <div className="flex flex-col gap-3">
          <Alert tone="error">{t('expenses.rules.loadError')}</Alert>
          <div>
            <Button
              onClick={retryPrerequisites}
              disabled={rulesQuery.isFetching || categoriesQuery.isFetching}
            >
              {t('common.retry')}
            </Button>
          </div>
        </div>
      ) : rules.length === 0 ? (
        <EmptyState
          title={t('expenses.rules.emptyTitle')}
          description={t('expenses.rules.emptyDescription')}
        />
      ) : (
        <ul className="bt-band flex flex-col" style={{ borderBlock: '1px solid var(--bt-border)' }}>
          {rules.map((rule) => {
            const category = categoryById.get(rule.categoryId);
            return (
              <li key={rule.id} className="bt-band__row flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="bt-row-title truncate">
                    <span className="bt-muted">
                      {t(`expenses.rules.matchType.${rule.matchType}`)}
                    </span>{' '}
                    <span>“{rule.pattern}”</span>
                    {!rule.enabled ? (
                      <Badge className="ml-2">{t('expenses.rules.disabled')}</Badge>
                    ) : null}
                  </p>
                  <p className="bt-row-sub flex items-center gap-1.5">
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
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => remove.mutate(rule.id)}
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
                    <Button variant="quiet" size="sm" onClick={() => setEditing(rule)}>
                      {t('common.edit')}
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => setConfirmDeleteId(rule.id)}>
                      {t('common.delete')}
                    </Button>
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
