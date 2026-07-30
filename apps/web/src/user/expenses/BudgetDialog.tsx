import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import type { ExpenseBudgetProgress, ExpenseCategory } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import {
  EXPENSE_BUDGETS_QUERY_KEY,
  createExpenseBudget,
  updateExpenseBudget,
} from '../../lib/expensesApi';
import { Dialog } from '../components/Dialog';
import { Alert } from '../components/ui';
import { Button, Field } from '../../ui/origin';

export interface BudgetDialogProps {
  /** Edit mode — the budget being edited (amount only; category is fixed). */
  existing?: ExpenseBudgetProgress | null;
  /** Expense categories, for the create picker. */
  categories: ExpenseCategory[];
  /** Categories that already have a budget — excluded from the create picker. */
  budgetedCategoryIds: ReadonlySet<string>;
  onClose: () => void;
}

/**
 * Create / edit dialog for one per-category monthly budget (PROJECTPLAN.md §13.5
 * V5-P9, issue 3/3). Create picks an as-yet-unbudgeted EXPENSE category + a
 * monthly target; edit retargets the amount (the category is fixed — move =
 * delete + create). One budget per category; a duplicate is a 409 surfaced inline.
 */
export function BudgetDialog({
  existing,
  categories,
  budgetedCategoryIds,
  onClose,
}: BudgetDialogProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const isEdit = !!existing;
  const categoryFieldId = useId();
  const amountFieldId = useId();

  // Only expense categories without an existing budget can receive one.
  const options = useMemo(
    () => categories.filter((c) => c.direction === 'expense' && !budgetedCategoryIds.has(c.id)),
    [categories, budgetedCategoryIds],
  );

  const [categoryId, setCategoryId] = useState(existing?.categoryId ?? options[0]?.id ?? '');
  const [amount, setAmount] = useState(existing ? String(existing.amount) : '');
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const value = Number(amount);
      if (isEdit && existing) return updateExpenseBudget(existing.id, { amount: value });
      // Single-currency area (no FX) — the budget takes the ledger's EUR default.
      return createExpenseBudget({ categoryId, amount: value, currency: 'EUR' });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: EXPENSE_BUDGETS_QUERY_KEY });
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'EXPENSE_BUDGET_CATEGORY_TAKEN') {
        setFormError(t('expenses.budgets.dialog.categoryTaken'));
      } else {
        setFormError(t('expenses.budgets.dialog.saveError'));
      }
    },
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!isEdit && categoryId === '') {
      setFormError(t('expenses.budgets.dialog.categoryRequired'));
      return;
    }
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setFormError(t('expenses.budgets.dialog.amountRequired'));
      return;
    }
    mutation.mutate();
  }

  const noOptions = !isEdit && options.length === 0;

  return (
    <Dialog
      title={
        isEdit ? t('expenses.budgets.dialog.editTitle') : t('expenses.budgets.dialog.newTitle')
      }
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field label={t('expenses.budgets.dialog.category')} htmlFor={categoryFieldId}>
          {isEdit ? (
            <span
              id={categoryFieldId}
              className="bt-input"
              style={{ display: 'flex', alignItems: 'center', color: 'var(--bt-text-soft)' }}
            >
              {existing?.categoryName}
            </span>
          ) : (
            <select
              id={categoryFieldId}
              className="bt-select"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              disabled={noOptions}
            >
              {options.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </Field>

        {noOptions ? <p className="bt-meta">{t('expenses.budgets.dialog.noCategories')}</p> : null}

        <Field label={t('expenses.budgets.dialog.amount')} htmlFor={amountFieldId}>
          <input
            id={amountFieldId}
            className="bt-input"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            autoFocus
          />
        </Field>

        {formError ? <Alert tone="error">{formError}</Alert> : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="quiet" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={mutation.isPending || noOptions}>
            {mutation.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
