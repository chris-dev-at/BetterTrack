import { useState } from 'react';

import { CASH_SOURCE_TYPES, type CashSource, type CashSourceType } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { createCashSource, updateCashSource } from '../../lib/portfolioApi';
import { Dialog } from '../components/Dialog';
import { Alert, Button, cx } from '../components/ui';

const inputClass = cx(
  'w-full rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100',
  'ring-1 ring-inset ring-neutral-700 placeholder:text-neutral-600',
  'focus:outline-none focus:ring-2 focus:ring-sky-500',
);

export interface CashSourceDialogProps {
  portfolioId: string;
  /** Edit mode: the source being renamed / relabelled. Omit to create. */
  source?: CashSource;
  onClose: () => void;
  /** Called after a successful create / update so the page can refetch. */
  onSaved: () => void;
}

/**
 * Create or rename/relabel a cash source (V3-P3, §13.3). Main is auto-provisioned
 * server-side, so this only ever mints named siblings ("Bank account X") and
 * edits their name/type — the same form for both, driven by whether a `source`
 * prop is given.
 */
export function CashSourceDialog({ portfolioId, source, onClose, onSaved }: CashSourceDialogProps) {
  const t = useT();
  const isEdit = !!source;
  const [name, setName] = useState(source?.name ?? '');
  const [type, setType] = useState<CashSourceType>(source?.type ?? 'bank');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '') {
      setError(t('portfolio.cashSources.dialog.nameRequired'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (isEdit) {
        await updateCashSource(portfolioId, source.id, { name: trimmed, type });
      } else {
        await createCashSource(portfolioId, { name: trimmed, type });
      }
      onSaved();
      onClose();
    } catch {
      setError(t('portfolio.cashSources.dialog.saveError'));
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      title={
        isEdit
          ? t('portfolio.cashSources.dialog.renameTitle')
          : t('portfolio.cashSources.dialog.createTitle')
      }
      onClose={onClose}
      widthClassName="max-w-md"
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">
            {t('portfolio.cashSources.dialog.nameLabel')}
          </span>
          <input
            type="text"
            value={name}
            maxLength={120}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            aria-label={t('portfolio.cashSources.dialog.nameLabel')}
            placeholder={t('portfolio.cashSources.dialog.namePlaceholder')}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">
            {t('portfolio.cashSources.dialog.typeLabel')}
          </span>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as CashSourceType)}
            aria-label={t('portfolio.cashSources.dialog.typeLabel')}
            className={inputClass}
          >
            {CASH_SOURCE_TYPES.map((option) => (
              <option key={option} value={option}>
                {t(`portfolio.cashSources.type.${option}`)}
              </option>
            ))}
          </select>
        </label>

        {error ? <Alert tone="error">{error}</Alert> : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting
              ? t('common.saving')
              : isEdit
                ? t('portfolio.cashSources.dialog.saveSubmit')
                : t('portfolio.cashSources.dialog.createSubmit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
