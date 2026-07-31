import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import type { CashBudgetProgress, CashTag } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { ApiError } from '../../../lib/apiClient';
import { cashBudgetsQueryKey, createCashBudget, updateCashBudget } from '../../../lib/cashApi';
import { Dialog } from '../../components/Dialog';
import { Alert } from '../../components/ui';
import { Button, Field, Seg } from '../../../ui/origin';

const RECURRING = 'recurring';
const THIS_MONTH = 'thisMonth';
type PeriodMode = typeof RECURRING | typeof THIS_MONTH;

export interface CashBudgetDialogProps {
  portfolioId: string;
  /** The month currently viewed — the target period of a "this month only" budget. */
  month: string;
  /** Edit mode — the budget being edited (amount only; tag/period are fixed at creation). */
  existing?: CashBudgetProgress | null;
  /** Every tag, for the create picker. */
  tags: readonly CashTag[];
  /** Every budget already resolved for `month` — excludes taken (tag, period) pairs. */
  budgets: readonly CashBudgetProgress[];
  onClose: () => void;
}

/**
 * Create / edit dialog for one per-tag budget (V5 cash fusion, `POST`/`PATCH
 * /cash/budgets`). Create picks a tag not yet budgeted for the chosen period
 * plus a target; edit retargets the amount only — tag, portfolio and period
 * are fixed at creation (move = delete + create), mirroring the old
 * per-category budget dialog. One budget per (portfolio, tag, period); a
 * duplicate is a 409 surfaced inline.
 */
export function CashBudgetDialog({
  portfolioId,
  month,
  existing,
  tags,
  budgets,
  onClose,
}: CashBudgetDialogProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const isEdit = !!existing;
  const tagFieldId = useId();
  const amountFieldId = useId();

  const [periodMode, setPeriodMode] = useState<PeriodMode>(RECURRING);

  // A (tag, period) pair already has a budget when a row resolved for `month`
  // says so: `recurring: true` ⇒ that tag's RECURRING target already exists;
  // `recurring: false` ⇒ a THIS-MONTH override for `month` already exists.
  // Both can be true for the same tag at once (a recurring target plus a
  // one-off override for this month), so the exclusion depends on which
  // period mode is selected, not just "is this tag budgeted at all".
  const recurringTaken = useMemo(
    () => new Set(budgets.filter((b) => b.recurring).map((b) => b.tagId)),
    [budgets],
  );
  const thisMonthTaken = useMemo(
    () => new Set(budgets.filter((b) => !b.recurring).map((b) => b.tagId)),
    [budgets],
  );
  const taken = periodMode === RECURRING ? recurringTaken : thisMonthTaken;
  const options = useMemo(() => tags.filter((tag) => !taken.has(tag.id)), [tags, taken]);

  const [tagId, setTagId] = useState(existing?.tagId ?? options[0]?.id ?? '');
  const [amount, setAmount] = useState(existing ? String(existing.amount) : '');
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const value = Number(amount);
      if (isEdit && existing) return updateCashBudget(existing.id, { amount: value });
      // Single-currency ledger (no FX) — the budget takes the EUR default
      // explicitly; the request type requires it even though the server
      // would default it too (packages/contracts/src/cash.ts).
      return createCashBudget({
        portfolioId,
        tagId,
        period: periodMode === THIS_MONTH ? month : null,
        amount: value,
        currency: 'EUR',
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: cashBudgetsQueryKey(portfolioId) });
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'CASH_BUDGET_EXISTS') {
        setFormError(t('cashflow.budgets.dialog.alreadyBudgeted'));
      } else {
        setFormError(t('cashflow.budgets.dialog.saveError'));
      }
    },
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!isEdit && tagId === '') {
      setFormError(t('cashflow.budgets.dialog.tagRequired'));
      return;
    }
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setFormError(t('cashflow.budgets.dialog.amountRequired'));
      return;
    }
    mutation.mutate();
  }

  const noOptions = !isEdit && options.length === 0;

  return (
    <Dialog
      onClose={onClose}
      title={
        isEdit ? t('cashflow.budgets.dialog.editTitle') : t('cashflow.budgets.dialog.newTitle')
      }
    >
      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        <Field htmlFor={tagFieldId} label={t('cashflow.budgets.dialog.tag')}>
          {isEdit ? (
            <span
              className="bt-input"
              id={tagFieldId}
              style={{ alignItems: 'center', color: 'var(--bt-text-soft)', display: 'flex' }}
            >
              {existing?.tagName}
            </span>
          ) : (
            <select
              className="bt-select"
              disabled={noOptions}
              id={tagFieldId}
              onChange={(e) => setTagId(e.target.value)}
              value={tagId}
            >
              {options.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </select>
          )}
        </Field>

        {!isEdit ? (
          <Seg
            ariaLabel={t('cashflow.budgets.dialog.period')}
            onChange={setPeriodMode}
            options={[
              { value: RECURRING, label: t('cashflow.budgets.dialog.periodRecurring') },
              { value: THIS_MONTH, label: t('cashflow.budgets.dialog.periodThisMonth') },
            ]}
            value={periodMode}
          />
        ) : (
          <p className="bt-meta">
            {existing?.recurring
              ? t('cashflow.budgets.recurring')
              : t('cashflow.budgets.thisMonthOnly', { month: existing?.period ?? month })}
          </p>
        )}

        {noOptions ? <p className="bt-meta">{t('cashflow.budgets.dialog.noTags')}</p> : null}

        <Field htmlFor={amountFieldId} label={t('cashflow.budgets.dialog.amount')}>
          <input
            autoFocus
            className="bt-input"
            id={amountFieldId}
            inputMode="decimal"
            min="0"
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            step="0.01"
            type="number"
            value={amount}
          />
        </Field>

        {formError ? <Alert tone="error">{formError}</Alert> : null}

        <div className="flex justify-end gap-2">
          <Button onClick={onClose} type="button" variant="quiet">
            {t('common.cancel')}
          </Button>
          <Button disabled={mutation.isPending || noOptions} type="submit" variant="primary">
            {mutation.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
