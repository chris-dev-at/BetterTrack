import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';

import {
  EXPENSE_DIRECTIONS,
  type ExpenseCategory,
  type ExpenseDirection,
  type ExpenseTransaction,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import {
  EXPENSE_TRANSACTIONS_QUERY_KEY,
  createExpenseTransaction,
  updateExpenseTransaction,
} from '../../lib/expensesApi';
import { Dialog } from '../components/Dialog';
import { Alert, Button, cx } from '../components/ui';

const inputClass = cx(
  'w-full rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100',
  'ring-1 ring-inset ring-neutral-700 placeholder:text-neutral-600',
  'focus:outline-none focus:ring-2 focus:ring-sky-500',
);

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface TransactionDialogProps {
  categories: ExpenseCategory[];
  /** Edit mode — the transaction being edited; omit to create. */
  existing?: ExpenseTransaction | null;
  onClose: () => void;
}

/**
 * Create / edit dialog for one expense transaction (PROJECTPLAN.md §13.5 V5-P9,
 * foundation 1/3). A compact single form: direction (spend/income), amount,
 * date, description and an optional category. Kept minimal per the anti-bloat
 * rule — the same form serves create and edit.
 */
export function TransactionDialog({ categories, existing, onClose }: TransactionDialogProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const isEdit = !!existing;

  const [direction, setDirection] = useState<ExpenseDirection>(existing?.direction ?? 'expense');
  const [amount, setAmount] = useState(existing ? String(existing.amount) : '');
  const [bookedOn, setBookedOn] = useState(existing?.bookedOn ?? todayIso());
  const [description, setDescription] = useState(existing?.description ?? '');
  const [categoryId, setCategoryId] = useState<string>(existing?.categoryId ?? '');
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const numericAmount = Number(amount);
      const category = categoryId === '' ? null : categoryId;
      if (isEdit && existing) {
        return updateExpenseTransaction(existing.id, {
          direction,
          amount: numericAmount,
          bookedOn,
          description: description.trim(),
          categoryId: category,
        });
      }
      return createExpenseTransaction({
        direction,
        amount: numericAmount,
        currency: 'EUR',
        bookedOn,
        description: description.trim(),
        categoryId: category,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: EXPENSE_TRANSACTIONS_QUERY_KEY });
      onClose();
    },
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const numericAmount = Number(amount);
    if (amount.trim() === '' || !Number.isFinite(numericAmount) || numericAmount <= 0) {
      setFormError(t('expenses.transactions.dialog.amountRequired'));
      return;
    }
    if (description.trim() === '') {
      setFormError(t('expenses.transactions.dialog.descriptionRequired'));
      return;
    }
    if (bookedOn.trim() === '') {
      setFormError(t('expenses.transactions.dialog.dateRequired'));
      return;
    }
    mutation.mutate();
  }

  return (
    <Dialog
      title={
        isEdit
          ? t('expenses.transactions.dialog.editTitle')
          : t('expenses.transactions.dialog.newTitle')
      }
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div
          className="flex gap-2"
          role="group"
          aria-label={t('expenses.transactions.dialog.direction')}
        >
          {EXPENSE_DIRECTIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDirection(d)}
              aria-pressed={direction === d}
              className={cx(
                'flex-1 rounded-md px-3 py-2 text-sm font-medium ring-1 ring-inset transition-colors',
                direction === d
                  ? 'bg-neutral-800 text-white ring-neutral-600'
                  : 'text-neutral-400 ring-neutral-700 hover:text-neutral-200',
              )}
            >
              {t(`expenses.direction.${d}`)}
            </button>
          ))}
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">
            {t('expenses.transactions.dialog.amount')}
          </span>
          <input
            className={inputClass}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">
            {t('expenses.transactions.dialog.date')}
          </span>
          <input
            className={inputClass}
            type="date"
            value={bookedOn}
            onChange={(e) => setBookedOn(e.target.value)}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">
            {t('expenses.transactions.dialog.description')}
          </span>
          <input
            className={inputClass}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('expenses.transactions.dialog.descriptionPlaceholder')}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">
            {t('expenses.transactions.dialog.category')}
          </span>
          <select
            className={inputClass}
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">{t('expenses.transactions.uncategorized')}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        {formError ? <Alert tone="error">{formError}</Alert> : null}
        {mutation.isError ? (
          <Alert tone="error">{t('expenses.transactions.dialog.saveError')}</Alert>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
