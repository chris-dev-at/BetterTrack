import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { CashBudgetProgress } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { cx } from '../../../lib/cx';
import { formatMoney } from '../../../lib/format';
import {
  CASH_TAGS_QUERY_KEY,
  cashBudgetsQueryKey,
  deleteCashBudget,
  listCashBudgets,
  listCashTags,
} from '../../../lib/cashApi';
import { Alert } from '../../components/ui';
import { AsyncReadState } from '../../components/AsyncReadState';
import { EmptyState, Skeleton } from '../../../ui';
import { Badge, Button, PageHead } from '../../../ui/origin';
import { CashBudgetDialog } from './CashBudgetDialog';
import { DisabledActionHint } from './DisabledActionHint';
import { TagChip } from './TagChip';
import { useActivePortfolio } from './useActivePortfolio';

/** The current calendar month `YYYY-MM` (UTC — matches the server's period). */
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Progress-bar fill: analytical blue on track, negative red once exceeded. */
function barTone(budget: CashBudgetProgress): string {
  return budget.exceeded ? 'var(--bt-neg)' : 'var(--bt-blue)';
}

/**
 * Per-tag budgets for one portfolio (V5 cash fusion, `GET`/`POST`/`PATCH`/
 * `DELETE /cash/budgets`). `period: null` (recurring) targets are
 * re-evaluated every month; `'YYYY-MM'` targets apply to that month only —
 * both surface distinctly on each row rather than collapsing to one shape.
 */
export function CashBudgetsPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const { portfoliosQuery, portfolioId } = useActivePortfolio();
  const [month, setMonth] = useState(currentMonth());
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CashBudgetProgress | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const budgetsQuery = useQuery({
    queryKey: portfolioId
      ? cashBudgetsQueryKey(portfolioId, month)
      : ['cash', 'budgets', null, month],
    queryFn: ({ signal }) => listCashBudgets(portfolioId!, month, signal),
    enabled: portfolioId !== null,
    staleTime: 30_000,
  });
  const tagsQuery = useQuery({
    queryKey: CASH_TAGS_QUERY_KEY,
    queryFn: ({ signal }) => listCashTags(signal),
    staleTime: 30_000,
  });

  const budgets = budgetsQuery.data?.budgets ?? [];
  const tags = tagsQuery.data?.tags ?? [];

  const remove = useMutation({
    mutationFn: (id: string) => deleteCashBudget(id),
    onSuccess: () => {
      setConfirmDeleteId(null);
      if (portfolioId)
        void queryClient.invalidateQueries({ queryKey: cashBudgetsQueryKey(portfolioId) });
    },
  });

  if (portfoliosQuery.isLoading || (portfolioId !== null && budgetsQuery.isLoading)) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton height="h-8" width="w-48" />
        <Skeleton height="h-16" />
        <Skeleton height="h-16" />
      </div>
    );
  }

  if (
    portfoliosQuery.isError ||
    portfolioId === null ||
    budgetsQuery.isError ||
    !budgetsQuery.data
  ) {
    return <Alert tone="error">{t('cashflow.budgets.loadError')}</Alert>;
  }

  // A tag can have both a recurring and a one-month target. Keep creation
  // available until every tag has filled both slots; the dialog enforces the
  // selected slot again and the server remains the final duplicate guard.
  const recurringBudgetedTagIds = new Set(
    budgets.filter((budget) => budget.recurring).map((budget) => budget.tagId),
  );
  const monthBudgetedTagIds = new Set(
    budgets.filter((budget) => !budget.recurring).map((budget) => budget.tagId),
  );
  const tagsKnown = tagsQuery.data !== undefined;
  const hasAvailableBudgetSlot = tags.some(
    (tag) => !recurringBudgetedTagIds.has(tag.id) || !monthBudgetedTagIds.has(tag.id),
  );
  const createDisabled = !tagsKnown || !hasAvailableBudgetSlot;
  const showCreateHint = tagsKnown && !hasAvailableBudgetSlot;
  const createHint =
    tags.length === 0
      ? t('cashflow.movements.tagDialog.noTags')
      : t('cashflow.budgets.dialog.noTags');

  return (
    <div className="bt-money-surface flex flex-col gap-6">
      <PageHead
        actions={
          <>
            <label className="bt-meta flex items-center gap-2">
              <span>{t('cashflow.budgets.month')}</span>
              <input
                aria-label={t('cashflow.budgets.month')}
                className="bt-input"
                onChange={(e) => setMonth(e.target.value || currentMonth())}
                style={{ minHeight: 28, padding: '2px 8px', width: 'auto', fontSize: 12 }}
                type="month"
                value={month}
              />
            </label>
            <DisabledActionHint disabled={showCreateHint} hint={createHint}>
              <Button disabled={createDisabled} onClick={() => setCreating(true)} variant="primary">
                {t('cashflow.budgets.new')}
              </Button>
            </DisabledActionHint>
          </>
        }
        title={t('cashflow.tabs.budgets')}
      />

      <AsyncReadState
        loading={tagsQuery.isLoading}
        error={tagsQuery.error}
        errorLabel={t('cashflow.budgets.loadError')}
        onRetry={() => void tagsQuery.refetch()}
      />

      {budgets.length === 0 ? (
        <EmptyState
          cta={
            <DisabledActionHint disabled={showCreateHint} hint={createHint}>
              <Button disabled={createDisabled} onClick={() => setCreating(true)} variant="quiet">
                {t('cashflow.budgets.emptyCta')}
              </Button>
            </DisabledActionHint>
          }
          description={t('cashflow.budgets.emptyDescription')}
          icon="🎯"
          title={t('cashflow.budgets.emptyTitle')}
        />
      ) : (
        <ul className="bt-band flex flex-col" style={{ borderBlock: '1px solid var(--bt-border)' }}>
          {budgets.map((b) => {
            const pct = b.amount > 0 ? Math.min(100, (b.spent / b.amount) * 100) : 0;
            return (
              <li className="bt-band__row" key={b.id}>
                <div className="flex flex-wrap items-center gap-3">
                  <TagChip color={b.tagColor} name={b.tagName} />
                  {b.exceeded ? <Badge tone="neg">{t('cashflow.budgets.exceeded')}</Badge> : null}
                  <span className="bt-meta">
                    {b.recurring
                      ? t('cashflow.budgets.recurring')
                      : t('cashflow.budgets.thisMonthOnly', { month: b.period })}
                  </span>
                  <span className="shrink-0 bt-num bt-soft ml-auto">
                    {formatMoney(b.spent, b.currency)} / {formatMoney(b.amount, b.currency)}
                  </span>
                  <span className="bt-row-actions flex shrink-0 items-center gap-1">
                    <Button onClick={() => setEditing(b)} size="sm" variant="quiet">
                      {t('common.edit')}
                    </Button>
                    {confirmDeleteId === b.id ? (
                      <>
                        <Button
                          disabled={remove.isPending}
                          onClick={() => remove.mutate(b.id)}
                          size="sm"
                          variant="danger"
                        >
                          {t('common.confirm')}
                        </Button>
                        <Button onClick={() => setConfirmDeleteId(null)} size="sm" variant="quiet">
                          {t('common.cancel')}
                        </Button>
                      </>
                    ) : (
                      <Button onClick={() => setConfirmDeleteId(b.id)} size="sm" variant="danger">
                        {t('common.delete')}
                      </Button>
                    )}
                  </span>
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <div
                    aria-label={b.tagName}
                    aria-valuemax={100}
                    aria-valuemin={0}
                    aria-valuenow={Math.round(pct)}
                    className="h-2 flex-1 overflow-hidden rounded-full"
                    role="progressbar"
                    style={{ background: 'var(--bt-surface-strong)' }}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{ background: barTone(b), width: `${pct}%` }}
                    />
                  </div>
                  <span
                    className={cx('shrink-0 bt-num', b.remaining < 0 ? 'bt-neg' : 'bt-muted')}
                    style={{ fontSize: 12 }}
                  >
                    {b.remaining < 0
                      ? t('cashflow.budgets.over', {
                          amount: formatMoney(Math.abs(b.remaining), b.currency),
                        })
                      : t('cashflow.budgets.left', {
                          amount: formatMoney(b.remaining, b.currency),
                        })}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {remove.isError ? <Alert tone="error">{t('cashflow.budgets.deleteError')}</Alert> : null}

      {creating ? (
        <CashBudgetDialog
          budgets={budgets}
          month={month}
          onClose={() => setCreating(false)}
          portfolioId={portfolioId}
          tags={tags}
        />
      ) : null}
      {editing ? (
        <CashBudgetDialog
          budgets={budgets}
          existing={editing}
          month={month}
          onClose={() => setEditing(null)}
          portfolioId={portfolioId}
          tags={tags}
        />
      ) : null}
    </div>
  );
}
