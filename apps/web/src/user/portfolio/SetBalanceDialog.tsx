import { useState } from 'react';

import type { CashSource } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { formatMoney } from '../../lib/format';
import { setCashBalance } from '../../lib/portfolioApi';
import { MoneyText } from '../../ui';
import { Dialog } from '../components/Dialog';
import { Alert, Button } from '../components/ui';

/** Cents-quantized delta between a target and the current balance (matches the server). */
function deltaEur(target: number, current: number): number {
  return Math.round((target - current) * 100) / 100;
}

export interface SetBalanceDialogProps {
  portfolioId: string;
  /** The source whose balance is being reconciled. */
  source: CashSource;
  onClose: () => void;
  onSubmitted: () => void;
}

/**
 * "Set balance to X" (V3-P3, §16 2026-07-07): the user types what the bank says
 * and the app shows the signed adjustment it will record — a normal deposit when
 * the target is above the current balance, a withdrawal when below — before
 * confirming. No head-math, audit trail intact. A no-op (target === current)
 * records nothing.
 */
export function SetBalanceDialog({
  portfolioId,
  source,
  onClose,
  onSubmitted,
}: SetBalanceDialogProps) {
  const t = useT();
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const parsed = Number(target);
  const targetValid = target.trim() !== '' && Number.isFinite(parsed) && parsed >= 0;
  const delta = targetValid ? deltaEur(parsed, source.balanceEur) : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!targetValid) {
      setError(t('portfolio.cashSources.setBalance.amountRequired'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await setCashBalance(portfolioId, source.id, {
        balanceEur: parsed,
        note: note.trim() === '' ? null : note.trim(),
      });
      onSubmitted();
      onClose();
    } catch {
      setError(t('portfolio.cashSources.setBalance.saveError'));
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      title={t('portfolio.cashSources.setBalance.title')}
      description={source.name}
      onClose={onClose}
      widthClassName="max-w-md"
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <p className="text-sm bt-muted">
          {t('portfolio.cashSources.setBalance.currentLabel')}:{' '}
          <span className="font-medium bt-soft">
            <MoneyText amount={source.balanceEur} currency="EUR" />
          </span>
        </p>

        <div className="bt-field">
          <label>{t('portfolio.cashSources.setBalance.targetLabel')}</label>
          <input
            type="number"
            inputMode="decimal"
            step="any"
            min="0"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            aria-label={t('portfolio.cashSources.setBalance.targetAriaLabel')}
            className="bt-input"
          />
        </div>

        {delta !== null ? (
          <p className="text-xs bt-muted" role="status">
            {delta === 0
              ? t('portfolio.cashSources.setBalance.noChange')
              : delta > 0
                ? t('portfolio.cashSources.setBalance.recordsDeposit', {
                    amount: formatMoney(delta, 'EUR'),
                  })
                : t('portfolio.cashSources.setBalance.recordsWithdrawal', {
                    amount: formatMoney(Math.abs(delta), 'EUR'),
                  })}
          </p>
        ) : null}

        <div className="bt-field">
          <label>{t('portfolio.cashSources.setBalance.noteLabel')}</label>
          <input
            type="text"
            value={note}
            maxLength={1000}
            onChange={(e) => setNote(e.target.value)}
            aria-label={t('portfolio.cashSources.setBalance.noteLabel')}
            className="bt-input"
          />
        </div>

        {error ? <Alert tone="error">{error}</Alert> : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? t('common.saving') : t('portfolio.cashSources.setBalance.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
