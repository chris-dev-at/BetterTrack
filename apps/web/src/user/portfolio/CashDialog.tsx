import { useEffect, useId, useMemo, useState } from 'react';

import type { CashMovementKind, CashPreviewResponse, CashSource } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { useDebounce } from '../hooks/useDebounce';
import { useMutationFeedback } from '../hooks/useMutationFeedback';
import { Dialog } from '../components/Dialog';
import { Alert, Button, cx } from '../components/ui';
import { MoneyText } from '../../ui';
import { pickDefaultSourceId, sortSourcesMainFirst } from './cashSourceUtils';
import { usePortfolioStore } from './PortfolioStoreProvider';

/**
 * The three hand-entered cash actions this dialog can record. `fee` (V5, §16
 * 2026-07-30) is a standing custody / account / platform fee: mechanically an
 * outflow like a withdrawal, but a cost of HOLDING, so it drags the performance
 * curve instead of being divided back out of it.
 */
type CashDialogKind = 'deposit' | 'withdrawal' | 'fee';

export interface CashDialogProps {
  portfolioId: string;
  /** Which action the dialog opens on; the user can still switch it (§14). */
  initialKind: CashDialogKind;
  onClose: () => void;
  /** Called after a successful deposit/withdraw/fee so the page can refetch. */
  onSubmitted: () => void;
  /**
   * The portfolio's active cash sources (V3-P3). When more than one exists a
   * source picker appears; with only Main it stays out of the way and the flow
   * defaults to Main (the sticky per-portfolio default). Omitted → no picker,
   * the server defaults every flow to Main.
   */
  sources?: CashSource[];
  /** Preselect a source (e.g. a per-source "Deposit" on the sources page). */
  initialSourceId?: string;
  /** Today as ISO `YYYY-MM-DD`, injectable for deterministic tests. */
  today?: string;
}

function isoToday(today?: string): string {
  if (today) return today;
  return new Date().toISOString().slice(0, 10);
}

/**
 * Deposit / withdraw / fee dialog for the portfolio cash balance ("Bargeld",
 * §14, #220). Cash is EUR-only, so the entered amount is the `amountEur` the
 * preview and the write endpoints both speak — no currency conversion needed.
 * The live "available → after" preview blocks any outflow that would overdraw
 * before it is ever submitted; the server's `INSUFFICIENT_CASH` error is still
 * surfaced verbatim if a race lets one through.
 */
export function CashDialog({
  portfolioId,
  initialKind,
  onClose,
  onSubmitted,
  sources,
  initialSourceId,
  today,
}: CashDialogProps) {
  const t = useT();
  const store = usePortfolioStore();
  const feedback = useMutationFeedback();
  const headingId = useId();
  const [kind, setKind] = useState<CashDialogKind>(initialKind);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(isoToday(today));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // The picker only earns its place once a second source exists (V3-P3); with
  // just Main it stays hidden and every flow defaults to Main server-side.
  const pickable = useMemo(
    () => sortSourcesMainFirst((sources ?? []).filter((s) => !s.archivedAt)),
    [sources],
  );
  const showPicker = pickable.length > 1;
  const [sourceId, setSourceId] = useState<string | null>(() =>
    pickDefaultSourceId(sources ?? [], initialSourceId),
  );
  // Preview and writes are scoped to the chosen source; only send it when a
  // real source was resolved (otherwise the server picks Main).
  const scopedSourceId = sourceId ?? undefined;

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
    store
      .previewCash(
        portfolioId,
        { kind: previewKind, amountEur: debouncedAmount, sourceId: scopedSourceId },
        controller.signal,
      )
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
  }, [portfolioId, kind, debouncedAmount, scopedSourceId, store]);

  // Every outflow is gated, not just a withdrawal: a fee that would overdraw the
  // source is rejected by the same server-side solvency replay.
  const blockedByPreview = kind !== 'deposit' && preview !== null && !preview.sufficient;

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
        sourceId: scopedSourceId,
        // Cash movements use 12:00 UTC, after same-day midnight trades.
        executedAt: `${date}T12:00:00.000Z`,
        note: note.trim() === '' ? null : note.trim(),
      };
      // Through the store seam (PD8): a paranoid account's cash lives in the
      // vault, so ALL three kinds — the fee included — must route through it.
      if (kind === 'deposit') await store.depositCash(portfolioId, body);
      else if (kind === 'fee') await store.chargeCashFee(portfolioId, body);
      else await store.withdrawCash(portfolioId, body);
      feedback.success(
        t(
          kind === 'deposit'
            ? 'mutationFeedback.cash.depositSaved'
            : kind === 'fee'
              ? 'mutationFeedback.cash.feeSaved'
              : 'mutationFeedback.cash.withdrawalSaved',
        ),
      );
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
    <Dialog
      title={t('portfolio.cash.title')}
      onClose={onClose}
      phoneSheet
      widthClassName="max-w-md"
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4" aria-labelledby={headingId}>
        <span id={headingId} className="sr-only">
          {t('portfolio.cash.title')}
        </span>

        <div className="bt-seg" role="group" aria-label={t('portfolio.cash.kindGroupAriaLabel')}>
          <button
            type="button"
            onClick={() => setKind('deposit')}
            aria-pressed={kind === 'deposit'}
            className={cx('flex-1', kind === 'deposit' && 'is-active')}
          >
            {t('portfolio.cash.depositTab')}
          </button>
          <button
            type="button"
            onClick={() => setKind('withdrawal')}
            aria-pressed={kind === 'withdrawal'}
            className={cx('flex-1', kind === 'withdrawal' && 'is-active')}
          >
            {t('portfolio.cash.withdrawTab')}
          </button>
          <button
            type="button"
            onClick={() => setKind('fee')}
            aria-pressed={kind === 'fee'}
            className={cx('flex-1', kind === 'fee' && 'is-active')}
          >
            {t('portfolio.cash.feeTab')}
          </button>
        </div>

        {kind === 'fee' ? <p className="text-xs bt-muted">{t('portfolio.cash.feeHint')}</p> : null}

        {showPicker ? (
          <div className="bt-field">
            <label>{t('portfolio.cash.sourceLabel')}</label>
            <select
              value={sourceId ?? ''}
              onChange={(e) => setSourceId(e.target.value)}
              aria-label={t('portfolio.cash.sourceLabel')}
              className="bt-select"
            >
              {pickable.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="bt-field">
          <label>{t('portfolio.cash.amountLabel')}</label>
          <input
            type="number"
            inputMode="decimal"
            step="any"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label={t('portfolio.cash.amountAriaLabel')}
            className="bt-input"
          />
        </div>

        {amountValid ? (
          <p
            className="text-xs bt-muted"
            role="status"
            aria-label={t('portfolio.cash.previewAriaLabel')}
          >
            {previewLoading || !preview ? (
              t('portfolio.cash.calculating')
            ) : (
              <>
                {t('portfolio.cash.available')}{' '}
                <MoneyText amount={preview.availableEur} currency="EUR" /> &rarr;{' '}
                <span className={blockedByPreview ? 'bt-neg' : 'bt-soft'}>
                  <MoneyText amount={preview.afterEur} currency="EUR" />
                </span>
                {blockedByPreview ? (
                  <span className="ml-1 bt-neg">
                    ({t('portfolio.cash.short')}{' '}
                    <MoneyText amount={preview.shortfallEur} currency="EUR" />)
                  </span>
                ) : null}
              </>
            )}
          </p>
        ) : null}

        <div className="bt-field">
          <label>{t('portfolio.cash.dateLabel')}</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            aria-label={t('portfolio.cash.dateLabel')}
            className="bt-input"
          />
        </div>

        <div className="bt-field">
          <label>{t('portfolio.cash.noteLabel')}</label>
          <input
            type="text"
            value={note}
            maxLength={1000}
            onChange={(e) => setNote(e.target.value)}
            aria-label={t('portfolio.cash.noteAriaLabel')}
            className="bt-input"
          />
        </div>

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
                : kind === 'fee'
                  ? t('portfolio.cash.feeSubmit')
                  : t('portfolio.cash.withdrawSubmit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
