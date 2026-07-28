import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
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
import { Alert } from '../components/ui';
import { Button, Field, Seg } from '../../ui/origin';

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
  const amountFieldId = useId();
  const dateFieldId = useId();
  const descriptionFieldId = useId();
  const categoryFieldId = useId();

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
        <Seg
          ariaLabel={t('expenses.transactions.dialog.direction')}
          value={direction}
          onChange={setDirection}
          options={EXPENSE_DIRECTIONS.map((d) => ({
            value: d,
            label: t(`expenses.direction.${d}`),
          }))}
        />

        <Field label={t('expenses.transactions.dialog.amount')} htmlFor={amountFieldId}>
          <input
            id={amountFieldId}
            className="bt-input"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
        </Field>

        <Field label={t('expenses.transactions.dialog.date')} htmlFor={dateFieldId}>
          <input
            id={dateFieldId}
            className="bt-input"
            type="date"
            value={bookedOn}
            onChange={(e) => setBookedOn(e.target.value)}
          />
        </Field>

        <Field label={t('expenses.transactions.dialog.description')} htmlFor={descriptionFieldId}>
          <input
            id={descriptionFieldId}
            className="bt-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('expenses.transactions.dialog.descriptionPlaceholder')}
          />
        </Field>

        <Field label={t('expenses.transactions.dialog.category')} htmlFor={categoryFieldId}>
          <select
            id={categoryFieldId}
            className="bt-select"
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
        </Field>

        {formError ? <Alert tone="error">{formError}</Alert> : null}
        {mutation.isError ? (
          <Alert tone="error">{t('expenses.transactions.dialog.saveError')}</Alert>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="quiet" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={mutation.isPending}>
            {mutation.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
