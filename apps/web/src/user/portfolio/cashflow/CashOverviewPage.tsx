import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import type { CashMovement } from '@bettertrack/contracts';

import { useI18n, useT } from '../../../i18n';
import {
  cashSummaryQueryKey,
  cashTrendsQueryKey,
  getCashSummary,
  getCashTrends,
} from '../../../lib/cashApi';
import { getCashMovements, listCashSources } from '../../../lib/portfolioApi';
import { EM_DASH, formatDate, formatMoney } from '../../../lib/format';
import { Alert } from '../../components/ui';
import { AsyncReadState } from '../../components/AsyncReadState';
import { EmptyState, MoneyText, Skeleton } from '../../../ui';
import { Icon, PageHead } from '../../../ui/origin';
import { AllocationDonut } from '../../../ui/charts';
import { CashflowChart } from './CashflowChart';
import { MonthPicker } from './MonthPicker';
import { RecordCashButton } from './RecordCashButton';
import { RecordCashDialog } from './RecordCashDialog';
import { usePreservedSearch } from '../../components/LocalNav';
import { ACTIVE_PORTFOLIO_PARAM } from '../PortfolioSwitcher';
import { activeSources, sortSourcesMainFirst } from '../cashSourceUtils';
import { TagChip } from './TagChip';
import { useActivePortfolio } from './useActivePortfolio';

const TREND_MONTHS = 6;
/** Enough recent rows to recognise the last few days without becoming the ledger. */
const RECENT_LIMIT = 5;

/** The current calendar month `YYYY-MM` (UTC — matches the server's period). */
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** A short localized month label for a `YYYY-MM` key (e.g. "Jul"). */
function shortMonthLabel(month: string, locale: string): string {
  const parts = month.split('-');
  const year = Number(parts[0]);
  const monthIndex = Number(parts[1]) - 1;
  return new Date(Date.UTC(year, monthIndex, 1)).toLocaleDateString(locale, {
    month: 'short',
    timeZone: 'UTC',
  });
}

/**
 * CASH OVERVIEW — "how much do I have, and where did it go?" (rebuilt on the
 * owner's call, 2026-07-31).
 *
 * It used to open on three equal stat boxes for the month. That answered a
 * question nobody asks first: before "what did I spend in July" comes "how much
 * have I got". So the page now opens on the BALANCE — one number, the size of a
 * headline, with the accounts that make it up directly underneath. The month's
 * in/out/net sits below that as context, not as the headline.
 *
 * The by-tag block is bars rather than a list of numbers, because the question
 * it answers is comparative ("what is eating my money") and a bar answers that
 * without arithmetic. The bars are scaled to the LARGEST tag, not to the month's
 * total, so the shape stays readable when one category dominates — and because
 * tag totals deliberately overlap (a movement with two tags counts in both),
 * scaling to the total would draw a chart whose parts do not sum to it.
 *
 * Accounts are managed on their own page, reached from the balance strip: it is
 * setup, done once, and it was a whole tab competing with the three questions
 * this area exists to answer.
 */
export function CashOverviewPage() {
  const t = useT();
  const { locale } = useI18n();
  const { portfoliosQuery, portfolioId } = useActivePortfolio();
  const [month, setMonth] = useState(currentMonth());
  // A per-card quick action: which account, and which direction.
  const [quick, setQuick] = useState<null | { sourceId: string; direction: 'in' | 'out' }>(null);
  const search = usePreservedSearch([ACTIVE_PORTFOLIO_PARAM]);

  const to = (pathname: string) => (search ? { pathname, search } : pathname);

  const summaryQuery = useQuery({
    queryKey: portfolioId ? cashSummaryQueryKey(portfolioId, month) : ['cash', 'summary', null],
    queryFn: ({ signal }) => getCashSummary(portfolioId!, month, signal),
    enabled: portfolioId !== null,
    staleTime: 30_000,
    // Changing month must not blank the page. Without this the whole section
    // fell back to a skeleton on every arrow press — taking the month picker
    // with it, so the control vanished from under the pointer that used it.
    placeholderData: keepPreviousData,
  });
  const trendsQuery = useQuery({
    queryKey: portfolioId
      ? cashTrendsQueryKey(portfolioId, TREND_MONTHS)
      : ['cash', 'trends', null, TREND_MONTHS],
    queryFn: ({ signal }) => getCashTrends(portfolioId!, TREND_MONTHS, signal),
    enabled: portfolioId !== null,
    staleTime: 30_000,
  });
  const sourcesQuery = useQuery({
    queryKey: ['portfolio', portfolioId, 'cash-sources', false],
    queryFn: ({ signal }) => listCashSources(portfolioId!, false, signal),
    enabled: portfolioId !== null,
    staleTime: 30_000,
  });
  const movementsQuery = useQuery({
    queryKey: ['portfolio', portfolioId, 'cash'],
    queryFn: ({ signal }) => getCashMovements(portfolioId!, signal),
    enabled: portfolioId !== null,
    staleTime: 30_000,
  });

  // `isLoading` is first-load-only by design (it is `isPending && isFetching`),
  // and with `keepPreviousData` a month change never returns to pending — so
  // this gate now fires exactly once, on arrival.
  if (portfoliosQuery.isLoading || (portfolioId !== null && summaryQuery.isLoading)) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton height="h-8" width="w-48" />
        <Skeleton height="h-24" />
        <Skeleton height="h-40" />
      </div>
    );
  }

  if (
    portfoliosQuery.isError ||
    portfolioId === null ||
    summaryQuery.isError ||
    !summaryQuery.data
  ) {
    return <Alert tone="error">{t('cashflow.overview.loadError')}</Alert>;
  }

  const summary = summaryQuery.data;
  const trendPoints = trendsQuery.data?.points ?? [];
  const trendEmpty = trendPoints.every((p) => p.inflow === 0 && p.outflow === 0);

  const sources = sortSourcesMainFirst(activeSources(sourcesQuery.data?.sources ?? []));
  const totalCash = sources.reduce((sum, source) => sum + source.balanceEur, 0);

  const recent: CashMovement[] = [...(movementsQuery.data?.movements ?? [])]
    .sort((a, b) => new Date(b.executedAt).getTime() - new Date(a.executedAt).getTime())
    .slice(0, RECENT_LIMIT);

  // Scaled to the largest tag — see the note at the top of the file on why NOT
  // to the month's total.
  const tagMax = Math.max(1, ...summary.tags.map((tag) => tag.outflow));

  return (
    <div className="bt-money-surface flex flex-col gap-8">
      <PageHead
        actions={
          <>
            <MonthPicker onChange={setMonth} value={month} />
            <RecordCashButton portfolioId={portfolioId} />
            {/* Managing accounts is setup, so it is an icon beside the actions
                rather than a worded button competing with them. */}
            <Link
              aria-label={t('cashflow.overview.manageAccounts')}
              className="bt-iconbtn"
              title={t('cashflow.overview.manageAccounts')}
              to={to('/portfolio/cash/accounts')}
            >
              <Icon name="sliders" />
            </Link>
          </>
        }
        title={t('cashflow.aria')}
      />

      {quick ? (
        <RecordCashDialog
          direction={quick.direction}
          onClose={() => setQuick(null)}
          portfolioId={portfolioId}
          sourceId={quick.sourceId}
        />
      ) : null}

      {/* ── The balance, and what it is made of ── */}
      <section aria-label={t('cashflow.overview.total')} className="flex flex-col gap-4">
        <AsyncReadState
          loading={sourcesQuery.isLoading}
          error={sourcesQuery.error}
          errorLabel={t('cashflow.overview.loadError')}
          onRetry={() => void sourcesQuery.refetch()}
        />

        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
          <div>
            {sourcesQuery.data ? (
              <>
                <p className="bt-label">{t('cashflow.overview.total')}</p>
                <p className="bt-hero-value" style={{ marginTop: 4 }}>
                  <MoneyText amount={totalCash} currency="EUR" />
                </p>
              </>
            ) : null}
            <p className="bt-meta" style={{ marginTop: sourcesQuery.data ? 5 : 0 }}>
              {t('cashflow.overview.thisMonthChange', {
                amount: formatMoney(summary.net),
              })}
            </p>
          </div>
        </div>

        {/* Only claim "no accounts" once the read actually answered — a failed
            or pending sources read must not read as an empty cash book. Cached
            data still renders beside a refetch error. */}
        {sourcesQuery.data ? (
          sources.length === 0 ? (
            <p className="bt-meta">{t('cashflow.overview.noAccounts')}</p>
          ) : (
            <ul
              aria-label={t('cashflow.overview.accountsHeading')}
              className="bt-acctgrid"
              role="list"
            >
              {sources.map((source) => (
                <li className="bt-acctcard" key={source.id}>
                  <span className="bt-acctcard__name" title={source.name}>
                    {source.name}
                  </span>
                  <span className="bt-acctcard__value bt-num">
                    <MoneyText amount={source.balanceEur} currency="EUR" />
                  </span>
                  {/* The footer IS the card's bottom edge — no inset, no rounding
                      of its own, so the two halves meet the card's own corners. */}
                  <span className="bt-acctcard__actions">
                    <button
                      aria-label={t('cashflow.overview.quickDeposit', { source: source.name })}
                      className="bt-acctcard__action bt-acctcard__action--in"
                      onClick={() => setQuick({ sourceId: source.id, direction: 'in' })}
                      title={t('cashflow.overview.quickDeposit', { source: source.name })}
                      type="button"
                    >
                      <Icon name="plus" />
                    </button>
                    <button
                      aria-label={t('cashflow.overview.quickWithdraw', { source: source.name })}
                      className="bt-acctcard__action bt-acctcard__action--out"
                      onClick={() => setQuick({ sourceId: source.id, direction: 'out' })}
                      title={t('cashflow.overview.quickWithdraw', { source: source.name })}
                      type="button"
                    >
                      <Icon name="minus" />
                    </button>
                  </span>
                </li>
              ))}
              {/* The list's own way into managing them — the header icon is for
                  people who already know it is there. */}
              <li className="bt-acctcard bt-acctcard--manage">
                <Link className="bt-acctcard__manage" to={to('/portfolio/cash/accounts')}>
                  <Icon name="sliders" />
                  {t('cashflow.overview.manageAccounts')}
                </Link>
              </li>
            </ul>
          )
        ) : null}
      </section>

      {/* ── The month ── */}
      <section aria-label={t('cashflow.overview.byTag')} className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <h2 className="bt-h2">{t('cashflow.overview.byTag')}</h2>
          <span className="bt-meta">
            {t('cashflow.overview.inflow')}{' '}
            <span className="bt-num bt-pos">{formatMoney(summary.totalInflow)}</span>
            {' · '}
            {t('cashflow.overview.outflow')}{' '}
            <span className="bt-num">{formatMoney(summary.totalOutflow)}</span>
          </span>
        </div>

        {summary.tags.length === 0 ? (
          <p className="bt-meta">{t('cashflow.overview.noActivity')}</p>
        ) : (
          <>
            <div className="bt-bytag">
              {/* Share of the month's outflow — the same numbers the bars rank,
                  answering "what proportion" instead of "how much". */}
              <div className="bt-bytag__chart">
                <AllocationDonut
                  data={summary.tags
                    .filter((tag) => tag.outflow > 0)
                    .map((tag) => ({
                      label: tag.name ?? t('cashflow.untagged'),
                      value: tag.outflow,
                      color: tag.color ?? 'var(--bt-text-soft)',
                    }))}
                  size={170}
                  title={t('cashflow.overview.byTag')}
                />
              </div>
              <div className="bt-bytag__bars">
                <ul aria-label={t('cashflow.overview.byTagList')} className="flex flex-col gap-2.5">
                  {summary.tags.map((tag) => (
                    <li className="flex items-center gap-3" key={tag.tagId ?? 'untagged'}>
                      <span className="w-40 shrink-0 truncate">
                        {tag.tagId === null || tag.name === null || tag.color === null ? (
                          <span className="bt-muted">{t('cashflow.untagged')}</span>
                        ) : (
                          <TagChip color={tag.color} name={tag.name} />
                        )}
                      </span>
                      <span
                        aria-hidden="true"
                        className="h-2 flex-1 overflow-hidden rounded-full"
                        style={{ background: 'var(--bt-surface-strong)' }}
                      >
                        <span
                          className="block h-full rounded-full"
                          style={{
                            background: tag.color ?? 'var(--bt-text-soft)',
                            width: `${(tag.outflow / tagMax) * 100}%`,
                          }}
                        />
                      </span>
                      <span className="w-24 shrink-0 text-right bt-num">
                        {formatMoney(tag.outflow)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <p className="bt-meta">{t('cashflow.overview.notSumNote')}</p>
          </>
        )}
      </section>

      {/* ── Trend ── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="bt-h2">{t('cashflow.overview.trend')}</h2>
          <div className="bt-meta flex items-center gap-3">
            <span className="flex items-center gap-1">
              <span aria-hidden="true" className="bt-dot bt-dot--neg" />
              {t('cashflow.overview.outflow')}
            </span>
            <span className="flex items-center gap-1">
              <span aria-hidden="true" className="bt-dot bt-dot--pos" />
              {t('cashflow.overview.inflow')}
            </span>
          </div>
        </div>
        {trendsQuery.isLoading ? (
          <Skeleton height="h-32" />
        ) : (
          <>
            <AsyncReadState
              loading={false}
              error={trendsQuery.error}
              errorLabel={t('cashflow.overview.loadError')}
              onRetry={() => void trendsQuery.refetch()}
            />
            {trendsQuery.data ? (
              trendEmpty ? (
                <EmptyState
                  description={t('cashflow.overview.emptyDescription')}
                  icon="📊"
                  title={t('cashflow.overview.emptyTitle')}
                />
              ) : (
                <CashflowChart
                  monthLabel={(month) => shortMonthLabel(month, locale)}
                  points={trendPoints}
                />
              )
            ) : null}
          </>
        )}
      </section>
      {/* ── Recent movements: enough to recognise, not the ledger ── */}
      <section aria-label={t('cashflow.overview.recentHeading')} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="bt-h2">{t('cashflow.overview.recentHeading')}</h2>
          <Link className="bt-link" to={to('/portfolio/cash/movements')}>
            {t('cashflow.overview.allMovements')} →
          </Link>
        </div>
        <AsyncReadState
          loading={movementsQuery.isLoading}
          error={movementsQuery.error}
          errorLabel={t('cashflow.overview.loadError')}
          onRetry={() => void movementsQuery.refetch()}
        />
        {movementsQuery.data ? (
          recent.length === 0 ? (
            <p className="bt-meta">{t('cashflow.movements.emptyDescription')}</p>
          ) : (
            <ul
              className="bt-band flex flex-col"
              style={{ borderBlock: '1px solid var(--bt-border)' }}
            >
              {recent.map((movement) => (
                <li className="bt-band__row flex flex-wrap items-center gap-3" key={movement.id}>
                  <span className="bt-muted shrink-0 whitespace-nowrap" style={{ fontSize: 12 }}>
                    {formatDate(movement.executedAt)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{movement.note ?? EM_DASH}</span>
                  <span className="shrink-0 bt-num">
                    <MoneyText amount={movement.amountEur} currency="EUR" signed />
                  </span>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>
    </div>
  );
}
