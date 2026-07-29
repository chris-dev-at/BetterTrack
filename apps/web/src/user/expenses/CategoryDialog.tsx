import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';

import {
  EXPENSE_DIRECTIONS,
  type ExpenseCategory,
  type ExpenseDirection,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import {
  EXPENSE_CATEGORIES_QUERY_KEY,
  createExpenseCategory,
  updateExpenseCategory,
} from '../../lib/expensesApi';
import { Dialog } from '../components/Dialog';
import { Alert } from '../components/ui';
import { Button, Field, Seg } from '../../ui/origin';

const DEFAULT_COLOR = '#64748b';

export interface CategoryDialogProps {
  /** Edit mode — the category being edited; omit to create. */
  existing?: ExpenseCategory | null;
  onClose: () => void;
}

/**
 * Create / edit dialog for one expense category (PROJECTPLAN.md §13.5 V5-P9,
 * foundation 1/3): a name, a direction (spend/income) and a colour tint. The
 * server rejects a duplicate name with a 409 the form surfaces inline.
 */
export function CategoryDialog({ existing, onClose }: CategoryDialogProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const isEdit = !!existing;
  const nameFieldId = useId();
  const colorFieldId = useId();

  const [name, setName] = useState(existing?.name ?? '');
  const [direction, setDirection] = useState<ExpenseDirection>(existing?.direction ?? 'expense');
  const [color, setColor] = useState(existing?.color ?? DEFAULT_COLOR);
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      if (isEdit && existing) {
        return updateExpenseCategory(existing.id, { name: name.trim(), direction, color });
      }
      return createExpenseCategory({ name: name.trim(), direction, color });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: EXPENSE_CATEGORIES_QUERY_KEY });
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'EXPENSE_CATEGORY_NAME_TAKEN') {
        setFormError(t('expenses.categories.dialog.nameTaken'));
      } else {
        setFormError(t('expenses.categories.dialog.saveError'));
      }
    },
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (name.trim() === '') {
      setFormError(t('expenses.categories.dialog.nameRequired'));
      return;
    }
    mutation.mutate();
  }

  return (
    <Dialog
      title={
        isEdit
          ? t('expenses.categories.dialog.editTitle')
          : t('expenses.categories.dialog.newTitle')
      }
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field label={t('expenses.categories.dialog.name')} htmlFor={nameFieldId}>
          <input
            id={nameFieldId}
            className="bt-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('expenses.categories.dialog.namePlaceholder')}
            autoFocus
          />
        </Field>

        <Seg
          ariaLabel={t('expenses.categories.dialog.direction')}
          value={direction}
          onChange={setDirection}
          options={EXPENSE_DIRECTIONS.map((d) => ({
            value: d,
            label: t(`expenses.direction.${d}`),
          }))}
        />

        <div className="flex items-center justify-between gap-3">
          <label
            htmlFor={colorFieldId}
            style={{ color: 'var(--bt-text-soft)', fontSize: 12, fontWeight: 570 }}
          >
            {t('expenses.categories.dialog.color')}
          </label>
          <input
            id={colorFieldId}
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            aria-label={t('expenses.categories.dialog.color')}
            className="h-9 w-14 cursor-pointer rounded bg-transparent"
          />
        </div>

        {formError ? <Alert tone="error">{formError}</Alert> : null}

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
