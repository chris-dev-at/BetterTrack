import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';

import { useT } from '../../../i18n';
import { cx } from '../../../lib/cx';
import { ApiError } from '../../../lib/apiClient';
import { depositCash, listCashSources, withdrawCash } from '../../../lib/portfolioApi';
import { MoneyText } from '../../../ui';
import { Empty, SkeletonBlock } from '../../../ui/origin';
import { activeSources, sortSourcesMainFirst } from '../../portfolio/cashSourceUtils';
import type { WidgetProps } from './types';

/**
 * QUICK CASH — record a deposit, a withdrawal or a fee without leaving Home
 * (owner, 2026-07-31: "there should be a thing to make cash transactions… i
 * dont want to need to open something").
 *
 * So this is a FORM, not a button that opens one. The whole point is the absence
 * of a dialog: type a number, pick a direction, done. Everything the full
 * `CashDialog` offers beyond that — backdating, the live cash-after preview,
 * picking a source when you own several — is deliberately NOT here. Those belong
 * to the considered path on the Cash page; a widget that grew them would be the
 * dialog again, just wedged into a board tile.
 *
 * ONE PORTFOLIO, ONE SOURCE. A cash movement has to land somewhere specific, and
 * a board scoped to "all portfolios" has no answer to *which one* — so the
 * widget asks to be scoped, and posts to that portfolio's FIRST source (Main,
 * per `sortSourcesMainFirst`). Both facts are stated on the widget rather than
 * assumed, because money entered against the wrong account is the one mistake
 * here that is annoying to unpick.
 *
 * The date is today's, by omission: the API defaults it, and a quick-entry
 * affordance that silently backdated would be a trap — solvency is replayed
 * chronologically, so the date is not cosmetic.
 */

type Kind = 'deposit' | 'withdraw';

/**
 * Two directions, in the plain words the Record dialog uses. "Fee" is NOT here:
 * it is a rare, considered choice ("did the portfolio cost me this, or did I
 * spend it?") and the whole point of this tile is the un-considered case. It
 * lives behind "More" in the full dialog, where there is room to explain it.
 */
const KINDS: readonly { value: Kind; labelKey: string }[] = [
  { value: 'withdraw', labelKey: 'cashflow.record.moneyOut' },
  { value: 'deposit', labelKey: 'cashflow.record.moneyIn' },
];

export function QuickCashWidget({ scopedPortfolio, portfoliosLoading }: WidgetProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const amountFieldId = useId();
  const noteFieldId = useId();

  // Money OUT is the default: spending is what people record constantly.
  const [kind, setKind] = useState<Kind>('withdraw');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const portfolioId = scopedPortfolio?.id ?? null;

  const sourcesQuery = useQuery({
    // The page's own key for this list, so the widget shares its cache entry.
    queryKey: ['portfolio', portfolioId, 'cash-sources', false],
    queryFn: ({ signal }) => listCashSources(portfolioId!, false, signal),
    enabled: portfolioId !== null,
    staleTime: 30_000,
  });

  const sources = sortSourcesMainFirst(activeSources(sourcesQuery.data?.sources ?? []));
  const target = sources[0] ?? null;

  const submit = useMutation({
    mutationFn: async () => {
      const body = {
        amountEur: Number(amount),
        sourceId: target!.id,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      };
      if (kind === 'deposit') return depositCash(portfolioId!, body);
      return withdrawCash(portfolioId!, body);
    },
    onSuccess: () => {
      setAmount('');
      setNote('');
      setError(null);
      // The balance, the ledger and every tag-derived total just moved.
      void queryClient.invalidateQueries({ queryKey: ['portfolio'] });
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
    },
    onError: (err) => {
      // The server's own words for the two that matter — an overdraw, and a
      // fee/withdrawal the ledger will not accept. Anything else is generic.
      setError(
        err instanceof ApiError && err.code === 'INSUFFICIENT_CASH'
          ? err.message
          : t('portfolio.cash.saveError'),
      );
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setError(t('portfolio.cash.amountRequired'));
      return;
    }
    submit.mutate();
  }

  if (portfoliosLoading) return <SkeletonBlock height={120} />;

  // Scope is a REQUIREMENT here, not a preference — see the note above.
  if (portfolioId === null) return <Empty title={t('home.widgets.quickCash.needsScope')} />;
  if (sourcesQuery.isLoading) return <SkeletonBlock height={120} />;
  if (target === null) return <Empty title={t('home.widgets.quickCash.noSource')} />;

  return (
    <form className="bt-home-quickcash" onSubmit={handleSubmit}>
      <div aria-label={t('portfolio.cash.kindGroupAriaLabel')} className="bt-seg" role="group">
        {KINDS.map((option) => (
          <button
            aria-pressed={kind === option.value}
            className={cx('flex-1', kind === option.value && 'is-active')}
            key={option.value}
            onClick={() => {
              setKind(option.value);
              setError(null);
            }}
            type="button"
          >
            {t(option.labelKey)}
          </button>
        ))}
      </div>

      <div className="bt-home-quickcash__row">
        <input
          aria-label={t('portfolio.cash.amountAriaLabel')}
          className="bt-input"
          id={amountFieldId}
          inputMode="decimal"
          onChange={(event) => setAmount(event.target.value)}
          placeholder={t('portfolio.cash.amountLabel')}
          value={amount}
        />
        <button className="bt-btn bt-btn--primary" disabled={submit.isPending} type="submit">
          {submit.isPending ? t('common.saving') : t('home.widgets.quickCash.submit')}
        </button>
      </div>

      <input
        aria-label={t('portfolio.cash.noteAriaLabel')}
        className="bt-input"
        id={noteFieldId}
        onChange={(event) => setNote(event.target.value)}
        placeholder={t('home.widgets.quickCash.notePlaceholder')}
        value={note}
      />

      {error ? (
        <p className="bt-neg" role="alert" style={{ fontSize: 12 }}>
          {error}
        </p>
      ) : null}

      {/* Where it lands and what is there now — stated, never assumed. */}
      <p className="bt-meta bt-home-quickcash__target">
        <span>{t('home.widgets.quickCash.into', { source: target.name })}</span>
        <span className="bt-num">
          <MoneyText amount={target.balanceEur} currency="EUR" />
        </span>
      </p>
    </form>
  );
}
