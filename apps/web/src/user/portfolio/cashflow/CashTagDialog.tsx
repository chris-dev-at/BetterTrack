import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';

import type { CashTag } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { ApiError } from '../../../lib/apiClient';
import { CASH_TAGS_QUERY_KEY, createCashTag, updateCashTag } from '../../../lib/cashApi';
import { Dialog } from '../../components/Dialog';
import { Alert } from '../../components/ui';
import { Button, Field } from '../../../ui/origin';

const DEFAULT_COLOR = '#64748b';

export interface CashTagDialogProps {
  /** Edit mode — the tag being edited (system tags rename/re-tint here too). */
  existing?: CashTag | null;
  onClose: () => void;
}

/**
 * Create / edit dialog for one flat cash tag (V5 cash fusion, `POST`/`PATCH
 * /cash/tags`): a name and a colour tint. A system tag may be renamed and
 * re-tinted through this same form — `system` / `systemKey` are server-owned
 * and never editable here — but delete is a list-row affordance this dialog
 * never offers, full stop. Names are unique per owner case-insensitively; a
 * clash is a 409 surfaced inline.
 */
export function CashTagDialog({ existing, onClose }: CashTagDialogProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const isEdit = !!existing;
  const nameFieldId = useId();
  const colorFieldId = useId();

  const [name, setName] = useState(existing?.name ?? '');
  const [color, setColor] = useState(existing?.color ?? DEFAULT_COLOR);
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      if (isEdit && existing) return updateCashTag(existing.id, { name: name.trim(), color });
      return createCashTag({ name: name.trim(), color });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CASH_TAGS_QUERY_KEY });
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'CASH_TAG_NAME_TAKEN') {
        setFormError(t('cashflow.tags.dialog.nameTaken'));
      } else {
        setFormError(t('cashflow.tags.dialog.saveError'));
      }
    },
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (name.trim() === '') {
      setFormError(t('cashflow.tags.dialog.nameRequired'));
      return;
    }
    mutation.mutate();
  }

  return (
    <Dialog
      onClose={onClose}
      title={isEdit ? t('cashflow.tags.dialog.editTitle') : t('cashflow.tags.dialog.newTitle')}
    >
      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        <Field htmlFor={nameFieldId} label={t('cashflow.tags.dialog.name')}>
          <input
            autoFocus
            className="bt-input"
            id={nameFieldId}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('cashflow.tags.dialog.namePlaceholder')}
            value={name}
          />
        </Field>

        <div className="flex items-center justify-between gap-3">
          <label
            htmlFor={colorFieldId}
            style={{ color: 'var(--bt-text-soft)', fontSize: 12, fontWeight: 570 }}
          >
            {t('cashflow.tags.dialog.color')}
          </label>
          <input
            aria-label={t('cashflow.tags.dialog.color')}
            className="h-9 w-14 cursor-pointer rounded bg-transparent"
            id={colorFieldId}
            onChange={(e) => setColor(e.target.value)}
            type="color"
            value={color}
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
