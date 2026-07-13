import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import type { TaxYearPosition, TaxYearSell, TaxYearSummary } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { EM_DASH, formatDate, formatQuantity } from '../../lib/format';
import { getTaxYearReport, getTaxYearReports, listPortfolios } from '../../lib/portfolioApi';
import { getTaxSettings } from '../../lib/settingsApi';
import { EmptyState, MoneyText, Skeleton } from '../../ui';
import { Alert, cx } from '../components/ui';
import { ACTIVE_PORTFOLIO_PARAM, resolveActivePortfolio } from './PortfolioSwitcher';

const TAX_SETTINGS_KEY = ['settings', 'taxes'] as const;

/** Green for a gain, red for a loss, neutral for exactly zero — the P/L convention. */
function pnlToneClass(value: number): string {
  if (value > 0) return 'text-emerald-400';
  if (value < 0) return 'text-red-400';
  return 'text-neutral-300';
}

/** A signed EUR realized-P/L cell (tone by sign). */
function PnlAmount({ amount }: { amount: number }) {
  return (
    <span className={cx('tabular-nums', pnlToneClass(amount))}>
      <MoneyText amount={amount} currency="EUR" />
    </span>
  );
}

/** One sell inside a year's drill-down (#369 uncovered sells render their real basis). */
function SellRow({ sell }: { sell: TaxYearSell }) {
  return (
    <tr className="border-t border-neutral-800/60 text-xs">
      <td className="px-3 py-2 text-neutral-400">{formatDate(sell.executedAt)}</td>
      <td className="px-3 py-2 text-right tabular-nums text-neutral-300">
        {formatQuantity(sell.quantity)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-neutral-300">
        <MoneyText amount={sell.proceedsEur} currency="EUR" />
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-neutral-300">
        <MoneyText amount={sell.costBasisEur} currency="EUR" />
      </td>
      <td className="px-3 py-2 text-right">
        <PnlAmount amount={sell.realizedPnlEur} />
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-neutral-300">
        {sell.taxAmountEur === null ? (
          <span className="text-neutral-600">{EM_DASH}</span>
        ) : (
          <MoneyText amount={sell.taxAmountEur} currency="EUR" />
        )}
      </td>
    </tr>
  );
}

/** One asset's block inside a year's drill-down. */
function PositionBlock({ position, t }: { position: TaxYearPosition; t: TranslateFn }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-neutral-800 bg-neutral-950/40 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-semibold text-neutral-100">
            {position.asset.symbol}
          </span>
          <span className="truncate text-xs text-neutral-500">{position.asset.name}</span>
        </span>
        <span className="flex items-center gap-4 text-xs">
          <span className="text-neutral-500">
            {t('portfolio.taxReport.realized')} <PnlAmount amount={position.realizedPnlEur} />
          </span>
          <span className="text-neutral-500">
            {t('portfolio.taxReport.tax')}{' '}
            <span className="tabular-nums text-neutral-300">
              <MoneyText amount={position.taxEur} currency="EUR" />
            </span>
          </span>
        </span>
      </div>
      {position.sells.length > 0 ? (
        <table className="w-full">
          <thead>
            <tr className="text-[0.65rem] uppercase tracking-wide text-neutral-600">
              <th scope="col" className="px-3 py-1 text-left font-medium">
                {t('portfolio.taxReport.sell.date')}
              </th>
              <th scope="col" className="px-3 py-1 text-right font-medium">
                {t('portfolio.taxReport.sell.quantity')}
              </th>
              <th scope="col" className="px-3 py-1 text-right font-medium">
                {t('portfolio.taxReport.sell.proceeds')}
              </th>
              <th scope="col" className="px-3 py-1 text-right font-medium">
                {t('portfolio.taxReport.sell.costBasis')}
              </th>
              <th scope="col" className="px-3 py-1 text-right font-medium">
                {t('portfolio.taxReport.sell.realized')}
              </th>
              <th scope="col" className="px-3 py-1 text-right font-medium">
                {t('portfolio.taxReport.sell.tax')}
              </th>
            </tr>
          </thead>
          <tbody>
            {position.sells.map((sell) => (
              <SellRow key={sell.transactionId} sell={sell} />
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

/** Lazy-loaded per-year drill-down — fetched only once its row is expanded. */
function YearDetail({ portfolioId, year }: { portfolioId: string; year: number }) {
  const t = useT();
  const query = useQuery({
    queryKey: ['portfolio', 'taxYear', portfolioId, year],
    queryFn: ({ signal }) => getTaxYearReport(portfolioId, year, signal),
    staleTime: 30_000,
  });

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-2 p-3">
        <Skeleton height="h-10" />
        <Skeleton height="h-10" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="p-3">
        <Alert tone="error">{t('portfolio.taxReport.detailError')}</Alert>
      </div>
    );
  }
  if (query.data.positions.length === 0) {
    return (
      <p className="px-3 py-4 text-sm text-neutral-500">{t('portfolio.taxReport.detailEmpty')}</p>
    );
  }
  return (
    <div className="flex flex-col gap-3 p-3">
      {query.data.positions.map((position) => (
        <PositionBlock key={position.asset.id} position={position} t={t} />
      ))}
    </div>
  );
}

/** One year's summary row with an expand toggle to its drill-down. */
function YearRow({
  portfolioId,
  summary,
  expanded,
  onToggle,
}: {
  portfolioId: string;
  summary: TaxYearSummary;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  return (
    <>
      <tr className="border-b border-neutral-800">
        <td className="px-3 py-3">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={t(
              expanded ? 'portfolio.taxReport.collapseYear' : 'portfolio.taxReport.expandYear',
              { year: summary.year },
            )}
            className="flex items-center gap-2 font-medium text-neutral-100 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            <span aria-hidden="true" className="text-neutral-500">
              {expanded ? '▾' : '▸'}
            </span>
            {summary.year}
          </button>
        </td>
        <td className="px-3 py-3 text-right">
          <PnlAmount amount={summary.realizedPnlEur} />
        </td>
        <td className="px-3 py-3 text-right tabular-nums text-neutral-300">
          <MoneyText amount={summary.dividendsGrossEur} currency="EUR" />
        </td>
        <td className="px-3 py-3 text-right tabular-nums text-neutral-300">
          <MoneyText amount={summary.taxWithheldEur} currency="EUR" />
        </td>
        <td className="px-3 py-3 text-right tabular-nums text-emerald-400">
          {summary.taxRefundedEur > 0 ? (
            <MoneyText amount={summary.taxRefundedEur} currency="EUR" />
          ) : (
            <span className="text-neutral-600">{EM_DASH}</span>
          )}
        </td>
        <td className="px-3 py-3 text-right font-semibold tabular-nums text-neutral-100">
          <MoneyText amount={summary.taxNetEur} currency="EUR" />
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b border-neutral-800 bg-neutral-950/40">
          <td colSpan={6} className="p-0">
            <YearDetail portfolioId={portfolioId} year={summary.year} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * Portfolio → Tax report (PROJECTPLAN.md §13.3 V3-P4). Per Europe/Vienna calendar
 * year (newest first): realized P/L, gross dividends, tax withheld, the same-year
 * loss-offset **refund** line, and the **net** tax the year holds — each year
 * expandable to a per-asset drill-down whose sells show their real basis (an
 * uncovered sell, #369, never fabricates gain on the portion you didn't hold).
 *
 * Portfolio-scoped: reads the active portfolio from the `?portfolio=` param like
 * the rest of the section. Only meaningful with a tax mode active — with `none`
 * it points the user to Settings → Taxes instead of querying the report.
 */
export function TaxReportPage() {
  const t = useT();
  const [searchParams] = useSearchParams();
  const [expandedYear, setExpandedYear] = useState<number | null>(null);

  const settingsQuery = useQuery({
    queryKey: TAX_SETTINGS_KEY,
    queryFn: ({ signal }) => getTaxSettings(signal),
    staleTime: 30_000,
  });
  const portfoliosQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => listPortfolios(signal),
    staleTime: 60_000,
  });

  const portfolios = portfoliosQuery.data?.portfolios ?? [];
  const param = searchParams.get(ACTIVE_PORTFOLIO_PARAM);
  const active = resolveActivePortfolio(portfolios, param);
  const mode = settingsQuery.data?.mode ?? 'none';
  const taxActive = mode !== 'none';

  const reportQuery = useQuery({
    queryKey: ['portfolio', 'taxYears', active?.id],
    queryFn: ({ signal }) => getTaxYearReports(active!.id, signal),
    enabled: Boolean(active) && taxActive,
    staleTime: 30_000,
  });

  const header = (
    <div className="flex flex-col gap-1">
      <h1 className="text-lg font-semibold text-neutral-100">{t('portfolio.taxReport.title')}</h1>
      <p className="text-sm text-neutral-500">{t('portfolio.taxReport.subtitle')}</p>
    </div>
  );

  // Gate on the tax mode first: the report is only meaningful with one active.
  if (settingsQuery.isPending || portfoliosQuery.isPending) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <Skeleton height="h-24" />
      </div>
    );
  }

  if (!taxActive) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <EmptyState
          icon="🧾"
          title={t('portfolio.taxReport.disabled.title')}
          description={t('portfolio.taxReport.disabled.description')}
        />
        <Link
          to="/settings/taxes"
          className="w-fit text-sm font-medium text-sky-400 hover:text-sky-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          {t('portfolio.taxReport.disabled.link')}
        </Link>
      </div>
    );
  }

  const years = reportQuery.data?.years ?? [];

  return (
    <div className="flex flex-col gap-4">
      {header}

      {reportQuery.isPending ? (
        <Skeleton height="h-24" />
      ) : reportQuery.isError ? (
        <EmptyState
          title={t('portfolio.taxReport.loadError.title')}
          description={t('settings.retryHint')}
        />
      ) : years.length === 0 ? (
        <EmptyState
          icon="🧾"
          title={t('portfolio.taxReport.empty.title')}
          description={t('portfolio.taxReport.empty.description')}
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-neutral-800 bg-neutral-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-800 text-xs uppercase tracking-wide text-neutral-500">
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  {t('portfolio.taxReport.column.year')}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t('portfolio.taxReport.column.realized')}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t('portfolio.taxReport.column.dividends')}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t('portfolio.taxReport.column.withheld')}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t('portfolio.taxReport.column.refund')}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t('portfolio.taxReport.column.net')}
                </th>
              </tr>
            </thead>
            <tbody>
              {years.map((summary) => (
                <YearRow
                  key={summary.year}
                  portfolioId={active!.id}
                  summary={summary}
                  expanded={expandedYear === summary.year}
                  onToggle={() =>
                    setExpandedYear((cur) => (cur === summary.year ? null : summary.year))
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
