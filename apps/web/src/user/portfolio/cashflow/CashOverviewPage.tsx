import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { useI18n, useT } from '../../../i18n';
import {
  cashSummaryQueryKey,
  cashTrendsQueryKey,
  getCashSummary,
  getCashTrends,
} from '../../../lib/cashApi';
import { formatMoney } from '../../../lib/format';
import { Alert } from '../../components/ui';
import { EmptyState, Skeleton } from '../../../ui';
import { Button, PageHead, Stat, StatStrip } from '../../../ui/origin';
import { TagChip } from './TagChip';
import { useActivePortfolio } from './useActivePortfolio';

const TREND_MONTHS = 6;

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
 * Cash flow overview (V5 cash fusion, `GET /cash/summary` + `GET
 * /cash/trends`): one portfolio's month at a glance — in/out/net, spend by
 * tag, and a trailing-months trend. Currency-naive (the ledger is EUR-only) —
 * amounts render in EUR, same convention `MoneyText`'s default carries.
 */
export function CashOverviewPage() {
  const t = useT();
  const { locale } = useI18n();
  const { portfoliosQuery, portfolioId } = useActivePortfolio();
  const [month, setMonth] = useState(currentMonth());

  const summaryQuery = useQuery({
    queryKey: portfolioId ? cashSummaryQueryKey(portfolioId, month) : ['cash', 'summary', null],
    queryFn: ({ signal }) => getCashSummary(portfolioId!, month, signal),
    enabled: portfolioId !== null,
    staleTime: 30_000,
  });
  const trendsQuery = useQuery({
    queryKey: portfolioId
      ? cashTrendsQueryKey(portfolioId, TREND_MONTHS)
      : ['cash', 'trends', null, TREND_MONTHS],
    queryFn: ({ signal }) => getCashTrends(portfolioId!, TREND_MONTHS, signal),
    enabled: portfolioId !== null,
    staleTime: 30_000,
  });

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
  const trendMax = Math.max(1, ...trendPoints.flatMap((p) => [p.inflow, p.outflow]));
  const trendEmpty = trendPoints.every((p) => p.inflow === 0 && p.outflow === 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHead
        actions={
          <label className="bt-meta flex items-center gap-2">
            <span>{t('cashflow.overview.month')}</span>
            <input
              aria-label={t('cashflow.overview.month')}
              className="bt-input"
              onChange={(e) => setMonth(e.target.value || currentMonth())}
              style={{ minHeight: 28, padding: '2px 8px', width: 'auto', fontSize: 12 }}
              type="month"
              value={month}
            />
          </label>
        }
        sub={t('cashflow.overview.subtitle')}
        title={t('cashflow.aria')}
      />

      <StatStrip>
        <Stat
          label={t('cashflow.overview.inflow')}
          value={<span className="bt-pos">{formatMoney(summary.totalInflow)}</span>}
        />
        <Stat label={t('cashflow.overview.outflow')} value={formatMoney(summary.totalOutflow)} />
        <Stat
          label={t('cashflow.overview.net')}
          value={
            <span className={summary.net < 0 ? 'bt-neg' : undefined}>
              {formatMoney(summary.net)}
            </span>
          }
        />
      </StatStrip>

      <div>
        <h2 className="bt-h2" style={{ marginBottom: 8 }}>
          {t('cashflow.overview.byTag')}
        </h2>
        {summary.tags.length === 0 ? (
          <p className="bt-meta">{t('cashflow.overview.noActivity')}</p>
        ) : (
          <>
            <ul
              className="bt-band flex flex-col"
              style={{ borderBlock: '1px solid var(--bt-border)' }}
            >
              {summary.tags.map((tag) => (
                <li
                  key={tag.tagId ?? 'untagged'}
                  className="bt-band__row flex flex-wrap items-center gap-3"
                >
                  <div className="min-w-0 flex-1">
                    {tag.tagId === null || tag.name === null || tag.color === null ? (
                      <span className="bt-muted">{t('cashflow.untagged')}</span>
                    ) : (
                      <TagChip color={tag.color} name={tag.name} />
                    )}
                  </div>
                  <span className="shrink-0 bt-num">{formatMoney(tag.outflow)}</span>
                  <span className="shrink-0 bt-num bt-muted" style={{ fontSize: 12 }}>
                    {formatMoney(tag.inflow)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="bt-meta" style={{ marginTop: 8 }}>
              {t('cashflow.overview.notSumNote')}
            </p>
          </>
        )}
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
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
        ) : trendsQuery.isError ? (
          <div className="flex flex-col gap-3">
            <Alert tone="error">{t('cashflow.overview.loadError')}</Alert>
            <div>
              <Button onClick={() => void trendsQuery.refetch()}>{t('common.retry')}</Button>
            </div>
          </div>
        ) : trendEmpty ? (
          <EmptyState
            description={t('cashflow.overview.emptyDescription')}
            icon="📊"
            title={t('cashflow.overview.emptyTitle')}
          />
        ) : (
          <ul aria-label={t('cashflow.overview.trend')} className="flex h-36 items-end gap-2">
            {trendPoints.map((p) => {
              const monthLabel = shortMonthLabel(p.month, locale);
              const outflowLabel = `${monthLabel} · ${t('cashflow.overview.outflow')}: ${formatMoney(p.outflow)}`;
              const inflowLabel = `${monthLabel} · ${t('cashflow.overview.inflow')}: ${formatMoney(p.inflow)}`;

              return (
                <li key={p.month} className="flex flex-1 flex-col items-center gap-1">
                  <div className="flex w-full flex-1 items-end justify-center gap-1">
                    <span
                      aria-label={outflowLabel}
                      className="w-2.5 rounded-t"
                      role="img"
                      style={{
                        height: `${(p.outflow / trendMax) * 100}%`,
                        background: 'var(--bt-neg)',
                      }}
                      title={outflowLabel}
                    />
                    <span
                      aria-label={inflowLabel}
                      className="w-2.5 rounded-t"
                      role="img"
                      style={{
                        height: `${(p.inflow / trendMax) * 100}%`,
                        background: 'var(--bt-pos)',
                      }}
                      title={inflowLabel}
                    />
                  </div>
                  <span className="bt-meta" style={{ fontSize: 10 }}>
                    {monthLabel}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
