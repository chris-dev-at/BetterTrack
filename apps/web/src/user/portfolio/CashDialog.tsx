import { useEffect, useId, useState } from 'react';

import type { CashMovementKind, CashPreviewResponse } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { depositCash, previewCash, withdrawCash } from '../../lib/portfolioApi';
import { useDebounce } from '../hooks/useDebounce';
import { Dialog } from '../components/Dialog';
import { Alert, Button, cx } from '../components/ui';
import { MoneyText } from '../../ui';

export interface CashDialogProps {
  portfolioId: string;
  /** Which action the dialog opens on; the user can still switch it (§14). */
  initialKind: 'deposit' | 'withdrawal';
  onClose: () => void;
  /** Called after a successful deposit/withdraw so the page can refetch. */
  onSubmitted: () => void;
  /** Today as ISO `YYYY-MM-DD`, injectable for deterministic tests. */
  today?: string;
}

const inputClass = cx(
  'w-full rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100',
  'ring-1 ring-inset ring-neutral-700 placeholder:text-neutral-600',
  'focus:outline-none focus:ring-2 focus:ring-sky-500',
);

function isoToday(today?: string): string {
  if (today) return today;
  return new Date().toISOString().slice(0, 10);
}

/**
 * Deposit / withdraw dialog for the portfolio cash balance ("Bargeld", §14,
 * #220). Cash is EUR-only, so the entered amount is the `amountEur` the
 * preview and the write endpoints both speak — no currency conversion needed.
 * The live "available → after" preview blocks a withdrawal that would overdraw
 * before it is ever submitted; the server's `INSUFFICIENT_CASH` error is still
 * surfaced verbatim if a race lets one through.
 */
export function CashDialog({
  portfolioId,
  initialKind,
  onClose,
  onSubmitted,
  today,
}: CashDialogProps) {
  const t = useT();
  const headingId = useId();
  const [kind, setKind] = useState<'deposit' | 'withdrawal'>(initialKind);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(isoToday(today));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const parsedAmount = Number(amount);
  const amountValid = amount.trim() !== '' && Number.isFinite(parsedAmount) && parsedAmount > 0;
  const debouncedAmount = useDebounce(amountValid ? parsedAmount : null, 400);

  const [preview, setPreview] = useState<CashPreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (debouncedAmount == null) {
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    const previewKind: CashMovementKind = kind;
    setPreviewLoading(true);
    previewCash(portfolioId, { kind: previewKind, amountEur: debouncedAmount }, controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) setPreview(res);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPreview(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewLoading(false);
      });
    return () => controller.abort();
  }, [portfolioId, kind, debouncedAmount]);

  const blockedByPreview = kind === 'withdrawal' && preview !== null && !preview.sufficient;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!amountValid) {
      setError(t('portfolio.cash.amountRequired'));
      return;
    }
    if (blockedByPreview) {
      setError(t('portfolio.cash.blockedError'));
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError(t('portfolio.cash.invalidDate'));
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const body = {
        amountEur: parsedAmount,
        executedAt: `${date}T00:00:00.000Z`,
        note: note.trim() === '' ? null : note.trim(),
      };
      if (kind === 'deposit') await depositCash(portfolioId, body);
      else await withdrawCash(portfolioId, body);
      onSubmitted();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INSUFFICIENT_CASH') {
        setError(err.message);
      } else {
        setError(t('portfolio.cash.saveError'));
      }
      setSubmitting(false);
    }
  }

  return (
    <Dialog title={t('portfolio.cash.title')} onClose={onClose} widthClassName="max-w-md">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4" aria-labelledby={headingId}>
        <span id={headingId} className="sr-only">
          {t('portfolio.cash.title')}
        </span>

        <div
          className="flex gap-1 rounded-md bg-neutral-950 p-1 ring-1 ring-inset ring-neutral-700"
          role="group"
          aria-label={t('portfolio.cash.kindGroupAriaLabel')}
        >
          <button
            type="button"
            onClick={() => setKind('deposit')}
            aria-pressed={kind === 'deposit'}
            className={cx(
              'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
              kind === 'deposit'
                ? 'bg-neutral-800 text-neutral-100 ring-1 ring-inset ring-neutral-600'
                : 'text-neutral-400 hover:text-neutral-200',
            )}
          >
            {t('portfolio.cash.depositTab')}
          </button>
          <button
            type="button"
            onClick={() => setKind('withdrawal')}
            aria-pressed={kind === 'withdrawal'}
            className={cx(
              'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
              kind === 'withdrawal'
                ? 'bg-neutral-800 text-neutral-100 ring-1 ring-inset ring-neutral-600'
                : 'text-neutral-400 hover:text-neutral-200',
            )}
          >
            {t('portfolio.cash.withdrawTab')}
          </button>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">
            {t('portfolio.cash.amountLabel')}
          </span>
          <input
            type="number"
            inputMode="decimal"
            step="any"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label={t('portfolio.cash.amountAriaLabel')}
            className={inputClass}
          />
        </label>

        {amountValid ? (
          <p
            className="text-xs text-neutral-400"
            role="status"
            aria-label={t('portfolio.cash.previewAriaLabel')}
          >
            {previewLoading || !preview ? (
              t('portfolio.cash.calculating')
            ) : (
              <>
                {t('portfolio.cash.available')} <MoneyText amount={preview.availableEur} /> &rarr;{' '}
                <span className={blockedByPreview ? 'text-red-400' : 'text-neutral-200'}>
                  <MoneyText amount={preview.afterEur} />
                </span>
                {blockedByPreview ? (
                  <span className="ml-1 text-red-400">
                    ({t('portfolio.cash.short')} <MoneyText amount={preview.shortfallEur} />)
                  </span>
                ) : null}
              </>
            )}
          </p>
        ) : null}

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">
            {t('portfolio.cash.dateLabel')}
          </span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            aria-label={t('portfolio.cash.dateLabel')}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">
            {t('portfolio.cash.noteLabel')}
          </span>
          <input
            type="text"
            value={note}
            maxLength={1000}
            onChange={(e) => setNote(e.target.value)}
            aria-label={t('portfolio.cash.noteAriaLabel')}
            className={inputClass}
          />
        </label>

        {error ? <Alert tone="error">{error}</Alert> : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={submitting || blockedByPreview}>
            {submitting
              ? t('common.saving')
              : kind === 'deposit'
                ? t('portfolio.cash.depositSubmit')
                : t('portfolio.cash.withdrawSubmit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
