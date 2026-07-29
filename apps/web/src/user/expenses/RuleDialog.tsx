import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';

import {
  EXPENSE_RULE_MATCH_TYPES,
  type ExpenseCategory,
  type ExpenseRule,
  type ExpenseRuleMatchType,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import {
  EXPENSE_RULES_QUERY_KEY,
  createExpenseRule,
  updateExpenseRule,
} from '../../lib/expensesApi';
import { Dialog } from '../components/Dialog';
import { Alert } from '../components/ui';
import { Button, Field, Switch } from '../../ui/origin';

export interface RuleDialogProps {
  /** Edit mode — the rule being edited; omit to create. */
  existing?: ExpenseRule | null;
  categories: readonly ExpenseCategory[];
  onClose: () => void;
}

/**
 * Create / edit dialog for one auto-categorization rule (PROJECTPLAN.md §13.5
 * V5-P9, issue 2/3): a match type + pattern tested against a transaction's
 * description, filing matches under a category. Lower priority runs first; the
 * first match wins. Case-insensitive; a `regex` is a full regular expression.
 */
export function RuleDialog({ existing, categories, onClose }: RuleDialogProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const isEdit = !!existing;
  const categoryFieldId = useId();
  const matchTypeFieldId = useId();
  const patternFieldId = useId();
  const priorityFieldId = useId();

  const [categoryId, setCategoryId] = useState(existing?.categoryId ?? categories[0]?.id ?? '');
  const [matchType, setMatchType] = useState<ExpenseRuleMatchType>(
    existing?.matchType ?? 'contains',
  );
  const [pattern, setPattern] = useState(existing?.pattern ?? '');
  const [priority, setPriority] = useState(String(existing?.priority ?? 0));
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const body = {
        categoryId,
        matchType,
        pattern: pattern.trim(),
        priority: Number.parseInt(priority, 10) || 0,
        enabled,
      };
      if (isEdit && existing) return updateExpenseRule(existing.id, body);
      return createExpenseRule(body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: EXPENSE_RULES_QUERY_KEY });
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'EXPENSE_RULE_REGEX_UNSUPPORTED') {
        setFormError(t('expenses.rules.dialog.regexUnsupported'));
        return;
      }
      setFormError(err instanceof ApiError ? err.message : t('expenses.rules.dialog.saveError'));
    },
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (categoryId === '') {
      setFormError(t('expenses.rules.dialog.categoryRequired'));
      return;
    }
    if (pattern.trim() === '') {
      setFormError(t('expenses.rules.dialog.patternRequired'));
      return;
    }
    mutation.mutate();
  }

  return (
    <Dialog
      title={isEdit ? t('expenses.rules.dialog.editTitle') : t('expenses.rules.dialog.newTitle')}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field label={t('expenses.rules.dialog.category')} htmlFor={categoryFieldId}>
          <select
            id={categoryFieldId}
            className="bt-select"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t('expenses.rules.dialog.matchType')} htmlFor={matchTypeFieldId}>
          <select
            id={matchTypeFieldId}
            className="bt-select"
            value={matchType}
            onChange={(e) => setMatchType(e.target.value as ExpenseRuleMatchType)}
          >
            {EXPENSE_RULE_MATCH_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`expenses.rules.matchType.${type}`)}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t('expenses.rules.dialog.pattern')} htmlFor={patternFieldId}>
          <input
            id={patternFieldId}
            className="bt-input"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder={t('expenses.rules.dialog.patternPlaceholder')}
            autoFocus
          />
        </Field>

        <div className="flex items-center justify-between gap-3">
          <label
            htmlFor={priorityFieldId}
            style={{ color: 'var(--bt-text-soft)', fontSize: 12, fontWeight: 570 }}
          >
            {t('expenses.rules.dialog.priority')}
          </label>
          <input
            id={priorityFieldId}
            type="number"
            min={0}
            className="bt-input"
            style={{ width: 96 }}
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            aria-label={t('expenses.rules.dialog.priority')}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <span style={{ color: 'var(--bt-text-soft)', fontSize: 12, fontWeight: 570 }}>
            {t('expenses.rules.dialog.enabled')}
          </span>
          <Switch
            aria-label={t('expenses.rules.dialog.enabled')}
            checked={enabled}
            onChange={setEnabled}
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
