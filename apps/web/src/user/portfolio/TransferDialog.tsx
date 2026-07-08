import { useState } from 'react';

import type { CashSource } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { transferCash } from '../../lib/portfolioApi';
import { Dialog } from '../components/Dialog';
import { Alert, Button, cx } from '../components/ui';
import { activeSources } from './cashSourceUtils';

const inputClass = cx(
  'w-full rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100',
  'ring-1 ring-inset ring-neutral-700 placeholder:text-neutral-600',
  'focus:outline-none focus:ring-2 focus:ring-sky-500',
);

export interface TransferDialogProps {
  portfolioId: string;
  /** Every cash source (archived filtered here); a transfer needs two active. */
  sources: CashSource[];
  onClose: () => void;
  onSubmitted: () => void;
}

/**
 * Transfer money between two of the portfolio's active cash sources (V3-P3): an
 * atomic paired movement (a `transfer_out` leg + a `transfer_in` leg sharing one
 * transferId), never a TWR external flow. The dialog defaults `From` to the
 * first source and `To` to the next, guards same-source client-side, and surfaces
 * the server's solvency rejection verbatim if the from-source lacks the cash.
 */
export function TransferDialog({
  portfolioId,
  sources,
  onClose,
  onSubmitted,
}: TransferDialogProps) {
  const t = useT();
  const active = activeSources(sources);
  const [fromSourceId, setFromSourceId] = useState(active[0]?.id ?? '');
  const [toSourceId, setToSourceId] = useState(active[1]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (active.length < 2) {
    return (
      <Dialog
        title={t('portfolio.cashSources.transfer.title')}
        onClose={onClose}
        widthClassName="max-w-md"
      >
        <p className="text-sm text-neutral-400">
          {t('portfolio.cashSources.transfer.needTwoSources')}
        </p>
        <div className="mt-4 flex justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </Dialog>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (fromSourceId === toSourceId) {
      setError(t('portfolio.cashSources.transfer.sameSourceError'));
      return;
    }
    const parsed = Number(amount);
    if (amount.trim() === '' || !Number.isFinite(parsed) || parsed <= 0) {
      setError(t('portfolio.cashSources.transfer.amountRequired'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await transferCash(portfolioId, {
        fromSourceId,
        toSourceId,
        amountEur: parsed,
        note: note.trim() === '' ? null : note.trim(),
      });
      onSubmitted();
      onClose();
    } catch (err) {
      // The server's solvency + same-source rejections carry user-facing copy.
      setError(
        err instanceof ApiError && err.status === 400
          ? err.message
          : t('portfolio.cashSources.transfer.saveError'),
      );
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      title={t('portfolio.cashSources.transfer.title')}
      onClose={onClose}
      widthClassName="max-w-md"
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-neutral-300">
              {t('portfolio.cashSources.transfer.fromLabel')}
            </span>
            <select
              value={fromSourceId}
              onChange={(e) => setFromSourceId(e.target.value)}
              aria-label={t('portfolio.cashSources.transfer.fromLabel')}
              className={inputClass}
            >
              {active.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-neutral-300">
              {t('portfolio.cashSources.transfer.toLabel')}
            </span>
            <select
              value={toSourceId}
              onChange={(e) => setToSourceId(e.target.value)}
              aria-label={t('portfolio.cashSources.transfer.toLabel')}
              className={inputClass}
            >
              {active.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">
            {t('portfolio.cashSources.transfer.amountLabel')}
          </span>
          <input
            type="number"
            inputMode="decimal"
            step="any"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label={t('portfolio.cashSources.transfer.amountLabel')}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">
            {t('portfolio.cashSources.transfer.noteLabel')}
          </span>
          <input
            type="text"
            value={note}
            maxLength={1000}
            onChange={(e) => setNote(e.target.value)}
            aria-label={t('portfolio.cashSources.transfer.noteLabel')}
            className={inputClass}
          />
        </label>

        {error ? <Alert tone="error">{error}</Alert> : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? t('common.saving') : t('portfolio.cashSources.transfer.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
