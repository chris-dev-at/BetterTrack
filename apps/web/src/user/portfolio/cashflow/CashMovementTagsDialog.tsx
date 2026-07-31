import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';

import type { CashTag } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { setCashMovementTags } from '../../../lib/cashApi';
import { Dialog } from '../../components/Dialog';
import { Alert } from '../../components/ui';
import { Button } from '../../../ui/origin';
import { TagChip } from './TagChip';

export interface CashMovementTagsDialogProps {
  movementId: string;
  /** Every tag the caller can assign — system tags included. */
  tags: readonly CashTag[];
  /** This movement's current tag set. */
  selectedTagIds: readonly string[];
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Whole-set tag editor for one cash movement (V5 cash fusion, `PUT
 * /cash/movements/:movementId/tags`). Every available tag renders as a
 * toggle — click to add/remove — rather than a checkbox list, so the same
 * `TagChip` the ledger row shows previews exactly what gets attached. The
 * PUT always sends the complete set: an empty selection clears every tag.
 */
export function CashMovementTagsDialog({
  movementId,
  tags,
  selectedTagIds,
  onClose,
  onSaved,
}: CashMovementTagsDialogProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set(selectedTagIds));
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => setCashMovementTags(movementId, [...selected]),
    onSuccess: () => {
      // Tag changes can shift every downstream number (summary/trends/budget
      // spend), so invalidate the whole cash-flow prefix, not just the ledger.
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
      onSaved();
      onClose();
    },
    onError: () => setError(t('cashflow.movements.tagDialog.saveError')),
  });

  function toggle(tagId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    mutation.mutate();
  }

  return (
    <Dialog onClose={onClose} title={t('cashflow.movements.tagDialog.title')}>
      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        {tags.length === 0 ? (
          <p className="bt-meta">{t('cashflow.movements.tagDialog.noTags')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => {
              const active = selected.has(tag.id);
              return (
                <button
                  aria-pressed={active}
                  className="bt-tag-toggle"
                  key={tag.id}
                  onClick={() => toggle(tag.id)}
                  type="button"
                >
                  <TagChip color={tag.color} name={tag.name} />
                </button>
              );
            })}
          </div>
        )}

        {error ? <Alert tone="error">{error}</Alert> : null}

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
