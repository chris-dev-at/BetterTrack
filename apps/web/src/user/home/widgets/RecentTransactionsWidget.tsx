import { useId } from 'react';
import { Link } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';

import type { Transaction } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { formatDate, formatMoney } from '../../../lib/format';
import { listTransactions } from '../../../lib/portfolioApi';
import { Badge, Empty, Field, Select, SkeletonBlock } from '../../../ui/origin';
import { COUNT_LIMITS } from '../config';
import type { WidgetProps, WidgetSettingsExtraProps } from './types';

/**
 * The latest trades, newest first — across every portfolio or just the scoped
 * one.
 *
 * **Query-key deviation, deliberate.** The portfolio page owns its eight-row
 * recent ledger under `['portfolio', id, 'transactions', 'recent']` and uses
 * separate per-asset keys for expanded holdings. This widget still needs a
 * distinct entry per requested length, so it uses
 * `['portfolio', id, 'transactions', 'recent', N]`. The page's broad
 * `invalidateQueries({ queryKey: ['portfolio'] })` after a mutation still covers
 * it, so an added or deleted trade refreshes this widget too.
 */

/** Row counts the picker offers. A stored count outside this set is still honored. */
const COUNT_OPTIONS: readonly number[] = [5, 10, 15];

/** Rows when the instance has never been configured — a glance, not a ledger. */
const DEFAULT_COUNT = 5;

/** Portfolios fanned out at most, mirroring the other multi-portfolio widgets. */
const MAX_PORTFOLIOS = 12;

/**
 * The stored count, or the default. The parser has already rejected anything
 * outside {@link COUNT_LIMITS}, so no clamping is needed here — a value that got
 * this far is one a build deliberately wrote.
 */
function asCount(value: number | undefined): number {
  return value ?? DEFAULT_COUNT;
}

export function RecentTransactionsWidget({
  settings,
  scopedPortfolios,
  scopedPortfolio,
  portfoliosLoading,
  size,
}: WidgetProps) {
  const t = useT();
  const count = asCount(settings.count);
  const sourced = scopedPortfolios.slice(0, MAX_PORTFOLIOS);

  // Each portfolio is asked for `count` rows; the newest `count` of the merged
  // set is necessarily a subset of those, so no portfolio can be under-sampled.
  const merged = useQueries({
    queries: sourced.map((portfolio) => ({
      queryKey: ['portfolio', portfolio.id, 'transactions', 'recent', count],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        listTransactions(portfolio.id, { limit: count }, signal),
      staleTime: 60_000,
    })),
    combine: (results) => ({
      rows: results
        .flatMap((result, index) =>
          (result.data?.items ?? []).map((transaction) => ({
            transaction,
            portfolioName: sourced[index]?.name ?? '',
          })),
        )
        .sort((a, b) => b.transaction.executedAt.localeCompare(a.transaction.executedAt))
        .slice(0, count),
      loading: results.some((result) => result.isLoading),
    }),
  });

  if (portfoliosLoading || merged.loading)
    return <SkeletonBlock height={size === 's' ? 96 : 140} />;
  if (merged.rows.length === 0) return <Empty title={t('home.widgets.recentTransactions.empty')} />;

  // The portfolio only earns a mention when the widget spans several of them —
  // when it is scoped, the frame's badge already names it.
  const showPortfolio = scopedPortfolio === null && sourced.length > 1;

  return (
    <ul className="bt-band">
      {merged.rows.map(({ transaction, portfolioName }) => (
        <TransactionRow
          key={transaction.id}
          portfolioName={showPortfolio ? portfolioName : null}
          transaction={transaction}
        />
      ))}
    </ul>
  );
}

function TransactionRow({
  transaction,
  portfolioName,
}: {
  transaction: Transaction;
  portfolioName: string | null;
}) {
  const t = useT();
  const buy = transaction.side === 'buy';
  /**
   * The trade's gross consideration, signed by direction: money out on a buy, in
   * on a sell. Fees are deliberately excluded — this is quantity × unit price,
   * the same two figures the portfolio ledger prints side by side, so the number
   * here always reconciles with the row there. A fee-inclusive net would need the
   * settlement rules and is the ledger's job, not a glance widget's.
   */
  const gross = transaction.quantity * transaction.price * (buy ? -1 : 1);

  return (
    <li className="bt-home-row bt-home-row--split">
      <span className="bt-home-row__main">
        <Link className="bt-row-title bt-home-txn__link" to={`/assets/${transaction.assetId}`}>
          {transaction.asset.symbol}
        </Link>
        <span className="bt-row-sub bt-home-row__sub">
          {[formatDate(transaction.executedAt), portfolioName]
            .filter((part) => part !== null && part !== '')
            .join(' · ')}
        </span>
      </span>
      <span className="bt-home-txn__figures">
        <Badge tone={buy ? 'pos' : 'gold'}>
          {buy ? t('portfolio.overview.side.buy') : t('portfolio.overview.side.sell')}
        </Badge>
        {/*
          Neutral ink on purpose. The sign here is *direction* (bought vs. sold),
          not polarity — a purchase is not a loss — so it must not borrow the
          pos/neg palette the day-change and P/L figures own.
        */}
        <span className="bt-num bt-home-txn__amount">
          {formatMoney(gross, transaction.asset.currency)}
        </span>
      </span>
    </li>
  );
}

/** Row-count picker. Any count a build stored is offered alongside the standard set. */
export function RecentTransactionsSettings({
  settings,
  onSettingsChange,
}: WidgetSettingsExtraProps) {
  const t = useT();
  const fieldId = useId();
  const count = asCount(settings.count);
  const options = COUNT_OPTIONS.includes(count)
    ? COUNT_OPTIONS
    : [...COUNT_OPTIONS, count].sort((a, b) => a - b);

  return (
    <Field htmlFor={fieldId} label={t('home.widgets.recentTransactions.countLabel')}>
      <Select
        id={fieldId}
        onChange={(event) => {
          const next = Number.parseInt(event.target.value, 10);
          if (Number.isInteger(next) && next >= COUNT_LIMITS.min && next <= COUNT_LIMITS.max) {
            onSettingsChange({ count: next });
          }
        }}
        value={String(count)}
      >
        {options.map((option) => (
          <option key={option} value={String(option)}>
            {t('home.widgets.recentTransactions.countOption', { count: option })}
          </option>
        ))}
      </Select>
    </Field>
  );
}
