import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
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
import { Alert, Button, cx } from '../components/ui';

const inputClass = cx(
  'w-full rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100',
  'ring-1 ring-inset ring-neutral-700 placeholder:text-neutral-600',
  'focus:outline-none focus:ring-2 focus:ring-sky-500',
);

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
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">
            {t('expenses.budgets.dialog.category')}
          </span>
          {isEdit ? (
            <span className="rounded-md bg-neutral-900 px-3 py-2 text-sm text-neutral-300">
              {existing?.categoryName}
            </span>
          ) : (
            <select
              className={inputClass}
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
        </label>

        {noOptions ? (
          <p className="text-sm text-neutral-500">{t('expenses.budgets.dialog.noCategories')}</p>
        ) : null}

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">
            {t('expenses.budgets.dialog.amount')}
          </span>
          <input
            className={inputClass}
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            autoFocus
          />
        </label>

        {formError ? <Alert tone="error">{formError}</Alert> : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={mutation.isPending || noOptions}>
            {mutation.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
