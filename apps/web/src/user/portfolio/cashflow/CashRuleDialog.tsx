import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';

import {
  CASH_RULE_MATCH_TYPES,
  type CashRule,
  type CashRuleMatchType,
  type CashTag,
} from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { ApiError } from '../../../lib/apiClient';
import { CASH_RULES_QUERY_KEY, createCashRule, updateCashRule } from '../../../lib/cashApi';
import { Dialog } from '../../components/Dialog';
import { Alert } from '../../components/ui';
import { Button, Field, Switch } from '../../../ui/origin';
import { TagChip } from './TagChip';

export interface CashRuleDialogProps {
  /** Edit mode — the rule being edited; omit to create. */
  existing?: CashRule | null;
  tags: readonly CashTag[];
  onClose: () => void;
}

/**
 * Create / edit dialog for one auto-tagging rule (V5 cash fusion, `POST`/
 * `PATCH /cash/rules`): a match type + pattern tested against a movement's
 * note, applying ALL of its tags at once on a match. Tags are toggled the
 * same chip-click way `CashMovementTagsDialog` assigns them, so the same
 * visual vocabulary means "pick tags" everywhere in this area. Lower
 * priority runs first; the first matching rule wins and stops (stated once,
 * on the list page — not repeated here).
 */
export function CashRuleDialog({ existing, tags, onClose }: CashRuleDialogProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const isEdit = !!existing;
  const matchTypeFieldId = useId();
  const patternFieldId = useId();
  const priorityFieldId = useId();

  const [matchType, setMatchType] = useState<CashRuleMatchType>(existing?.matchType ?? 'contains');
  const [pattern, setPattern] = useState(existing?.pattern ?? '');
  const [priority, setPriority] = useState(String(existing?.priority ?? 0));
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [tagIds, setTagIds] = useState<Set<string>>(new Set(existing?.tagIds ?? []));
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const body = {
        tagIds: [...tagIds],
        matchType,
        pattern: pattern.trim(),
        priority: Number.parseInt(priority, 10) || 0,
        enabled,
      };
      if (isEdit && existing) return updateCashRule(existing.id, body);
      return createCashRule(body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CASH_RULES_QUERY_KEY });
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'CASH_RULE_REGEX_UNSUPPORTED') {
        setFormError(t('cashflow.rules.dialog.regexUnsupported'));
        return;
      }
      setFormError(err instanceof ApiError ? err.message : t('cashflow.rules.dialog.saveError'));
    },
  });

  function toggleTag(tagId: string) {
    setTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (pattern.trim() === '') {
      setFormError(t('cashflow.rules.dialog.patternRequired'));
      return;
    }
    if (tagIds.size === 0) {
      setFormError(t('cashflow.rules.dialog.tagsRequired'));
      return;
    }
    mutation.mutate();
  }

  return (
    <Dialog
      onClose={onClose}
      phoneSheet
      title={isEdit ? t('cashflow.rules.dialog.editTitle') : t('cashflow.rules.dialog.newTitle')}
    >
      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        <Field htmlFor={matchTypeFieldId} label={t('cashflow.rules.dialog.matchType')}>
          <select
            className="bt-select"
            id={matchTypeFieldId}
            onChange={(e) => setMatchType(e.target.value as CashRuleMatchType)}
            value={matchType}
          >
            {CASH_RULE_MATCH_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`cashflow.matchType.${type}`)}
              </option>
            ))}
          </select>
        </Field>

        <Field htmlFor={patternFieldId} label={t('cashflow.rules.dialog.pattern')}>
          <input
            autoFocus
            className="bt-input"
            id={patternFieldId}
            onChange={(e) => setPattern(e.target.value)}
            placeholder={t('cashflow.rules.dialog.patternPlaceholder')}
            value={pattern}
          />
        </Field>

        <Field label={t('cashflow.rules.dialog.tags')}>
          {tags.length === 0 ? (
            <p className="bt-meta">{t('cashflow.rules.dialog.noTags')}</p>
          ) : (
            <div
              aria-label={t('cashflow.rules.dialog.tags')}
              className="flex flex-wrap gap-2"
              role="group"
            >
              {tags.map((tag) => {
                const active = tagIds.has(tag.id);
                return (
                  <button
                    aria-pressed={active}
                    className="bt-tag-toggle"
                    key={tag.id}
                    onClick={() => toggleTag(tag.id)}
                    type="button"
                  >
                    <TagChip color={tag.color} name={tag.name} />
                  </button>
                );
              })}
            </div>
          )}
        </Field>

        <div className="flex items-center justify-between gap-3">
          <label
            htmlFor={priorityFieldId}
            style={{ color: 'var(--bt-text-soft)', fontSize: 12, fontWeight: 570 }}
          >
            {t('cashflow.rules.dialog.priority')}
          </label>
          <input
            aria-label={t('cashflow.rules.dialog.priority')}
            className="bt-input"
            id={priorityFieldId}
            min={0}
            onChange={(e) => setPriority(e.target.value)}
            style={{ width: 96 }}
            type="number"
            value={priority}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <span style={{ color: 'var(--bt-text-soft)', fontSize: 12, fontWeight: 570 }}>
            {t('cashflow.rules.dialog.enabled')}
          </span>
          <Switch
            aria-label={t('cashflow.rules.dialog.enabled')}
            checked={enabled}
            onChange={setEnabled}
          />
        </div>

        {formError ? <Alert tone="error">{formError}</Alert> : null}

        <div className="flex justify-end gap-2">
          <Button onClick={onClose} type="button" variant="quiet">
            {t('common.cancel')}
          </Button>
          <Button disabled={mutation.isPending} type="submit" variant="primary">
            {mutation.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
