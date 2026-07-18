import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import type { TaxYearDeSummary, TaxYearPosition, TaxYearSummary } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { EM_DASH, formatDate, formatMoney, formatQuantity } from '../../lib/format';
import { getTaxYearReport, listPortfolios } from '../../lib/portfolioApi';
import { ACTIVE_PORTFOLIO_PARAM } from './PortfolioSwitcher';

/**
 * Print-optimized, chrome-free rendering of ONE portfolio+year tax report
 * (V5-P4b, #583) — the browser's print-to-PDF target. It sits OUTSIDE the app
 * layout (no nav/subnav), renders as a plain light document, and shows exactly
 * the numbers the on-screen {@link TaxReportPage} does (same `getTaxYearReport`
 * source), so a printed PDF and the screen never disagree. A `@media print`
 * block hides the toolbar and keeps each position block from splitting across
 * a page. Loads with the browser print dialog already open.
 */

const PRINT_STYLE = `
@media print {
  .tax-print-toolbar { display: none !important; }
  .tax-print-block { break-inside: avoid; }
  @page { margin: 16mm; }
}
`;

/** A signed EUR figure — kept plain (light document), not color-coded. */
function eur(amount: number): string {
  return formatMoney(amount, 'EUR');
}

/** The summary table — the six on-screen year columns. */
function SummaryTable({ summary, t }: { summary: TaxYearSummary; t: TranslateFn }) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-neutral-400 text-left text-xs uppercase tracking-wide text-neutral-600">
          <th className="py-1 pr-3 font-medium">{t('portfolio.taxReport.column.year')}</th>
          <th className="py-1 pr-3 text-right font-medium">
            {t('portfolio.taxReport.column.realized')}
          </th>
          <th className="py-1 pr-3 text-right font-medium">
            {t('portfolio.taxReport.column.dividends')}
          </th>
          <th className="py-1 pr-3 text-right font-medium">
            {t('portfolio.taxReport.column.withheld')}
          </th>
          <th className="py-1 pr-3 text-right font-medium">
            {t('portfolio.taxReport.column.refund')}
          </th>
          <th className="py-1 text-right font-medium">{t('portfolio.taxReport.column.net')}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td className="py-1 pr-3 font-medium">{summary.year}</td>
          <td className="py-1 pr-3 text-right tabular-nums">{eur(summary.realizedPnlEur)}</td>
          <td className="py-1 pr-3 text-right tabular-nums">{eur(summary.dividendsGrossEur)}</td>
          <td className="py-1 pr-3 text-right tabular-nums">{eur(summary.taxWithheldEur)}</td>
          <td className="py-1 pr-3 text-right tabular-nums">
            {summary.taxRefundedEur > 0 ? eur(summary.taxRefundedEur) : EM_DASH}
          </td>
          <td className="py-1 text-right font-semibold tabular-nums">{eur(summary.taxNetEur)}</td>
        </tr>
      </tbody>
    </table>
  );
}

/** The German year-end block — allowance + both loss pots + KapESt/Soli. */
function DeBlock({ de, t }: { de: TaxYearDeSummary; t: TranslateFn }) {
  const pot = (inEur: number, outEur: number) => `${eur(inEur)} → ${eur(outEur)}`;
  const rows: [string, string][] = [
    [t('portfolio.taxReport.de.allowanceUsed'), eur(de.allowanceUsedEur)],
    [t('portfolio.taxReport.de.allowanceRemaining'), eur(de.allowanceRemainingEur)],
    [t('portfolio.taxReport.de.aktienPot'), pot(de.aktienPotInEur, de.aktienPotOutEur)],
    [t('portfolio.taxReport.de.sonstigePot'), pot(de.sonstigePotInEur, de.sonstigePotOutEur)],
    [t('portfolio.taxReport.de.kapest'), eur(de.kapestEur)],
    [t('portfolio.taxReport.de.soli'), eur(de.soliEur)],
  ];
  return (
    <div className="tax-print-block flex flex-col gap-2 rounded-md border border-neutral-300 p-3">
      <h2 className="text-sm font-semibold">{t('portfolio.taxReport.de.title')}</h2>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-col">
            <dt className="uppercase tracking-wide text-neutral-500">{label}</dt>
            <dd className="tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** One asset's block: its totals plus its sells and dividends drill-down. */
function PositionBlock({ position, t }: { position: TaxYearPosition; t: TranslateFn }) {
  return (
    <div className="tax-print-block flex flex-col gap-2 rounded-md border border-neutral-300 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-semibold">{position.asset.symbol}</span>
          <span className="text-xs text-neutral-500">{position.asset.name}</span>
        </span>
        <span className="flex items-center gap-4 text-xs text-neutral-600">
          <span>
            {t('portfolio.taxReport.realized')}{' '}
            <span className="tabular-nums">{eur(position.realizedPnlEur)}</span>
          </span>
          <span>
            {t('portfolio.taxReport.column.dividends')}{' '}
            <span className="tabular-nums">{eur(position.dividendsGrossEur)}</span>
          </span>
          <span>
            {t('portfolio.taxReport.tax')}{' '}
            <span className="tabular-nums">{eur(position.taxEur)}</span>
          </span>
        </span>
      </div>

      {position.sells.length > 0 ? (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-neutral-300 text-left uppercase tracking-wide text-neutral-500">
              <th className="py-1 pr-3 font-medium">{t('portfolio.taxReport.sell.date')}</th>
              <th className="py-1 pr-3 text-right font-medium">
                {t('portfolio.taxReport.sell.quantity')}
              </th>
              <th className="py-1 pr-3 text-right font-medium">
                {t('portfolio.taxReport.sell.proceeds')}
              </th>
              <th className="py-1 pr-3 text-right font-medium">
                {t('portfolio.taxReport.sell.costBasis')}
              </th>
              <th className="py-1 pr-3 text-right font-medium">
                {t('portfolio.taxReport.sell.realized')}
              </th>
              <th className="py-1 text-right font-medium">{t('portfolio.taxReport.sell.tax')}</th>
            </tr>
          </thead>
          <tbody>
            {position.sells.map((sell) => (
              <tr key={sell.transactionId} className="border-b border-neutral-200">
                <td className="py-1 pr-3">{formatDate(sell.executedAt)}</td>
                <td className="py-1 pr-3 text-right tabular-nums">
                  {formatQuantity(sell.quantity)}
                </td>
                <td className="py-1 pr-3 text-right tabular-nums">{eur(sell.proceedsEur)}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{eur(sell.costBasisEur)}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{eur(sell.realizedPnlEur)}</td>
                <td className="py-1 text-right tabular-nums">
                  {sell.taxAmountEur === null ? EM_DASH : eur(sell.taxAmountEur)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {position.dividends.length > 0 ? (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-neutral-300 text-left uppercase tracking-wide text-neutral-500">
              <th className="py-1 pr-3 font-medium">{t('portfolio.taxReport.sell.date')}</th>
              <th className="py-1 pr-3 text-right font-medium">
                {t('portfolio.taxReport.dividend.gross')}
              </th>
              <th className="py-1 text-right font-medium">
                {t('portfolio.taxReport.dividend.tax')}
              </th>
            </tr>
          </thead>
          <tbody>
            {position.dividends.map((dividend) => (
              <tr key={dividend.dividendId} className="border-b border-neutral-200">
                <td className="py-1 pr-3">{formatDate(dividend.executedAt)}</td>
                <td className="py-1 pr-3 text-right tabular-nums">
                  {eur(dividend.grossAmountEur)}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {dividend.taxAmountEur === null ? EM_DASH : eur(dividend.taxAmountEur)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

export function TaxReportPrintPage() {
  const t = useT();
  const [searchParams] = useSearchParams();
  const portfolioId = searchParams.get(ACTIVE_PORTFOLIO_PARAM);
  const yearParam = searchParams.get('year');
  const year = yearParam !== null && /^\d+$/.test(yearParam) ? Number(yearParam) : null;
  const paramsValid = Boolean(portfolioId) && year !== null;

  const portfoliosQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => listPortfolios(signal),
    staleTime: 60_000,
  });
  const reportQuery = useQuery({
    queryKey: ['portfolio', 'taxYear', portfolioId, year],
    queryFn: ({ signal }) => getTaxYearReport(portfolioId!, year!, signal),
    enabled: paramsValid,
    staleTime: 30_000,
  });

  // Open the print dialog once the numbers are on the page — the whole point of
  // this route. Guarded so a headless/jsdom environment (tests) never throws.
  const ready = reportQuery.isSuccess;
  useEffect(() => {
    if (!ready) return;
    try {
      window.print();
    } catch {
      // No print surface (e.g. jsdom) — the manual button below still works.
    }
  }, [ready]);

  const portfolioName = portfoliosQuery.data?.portfolios.find((p) => p.id === portfolioId)?.name;

  const toolbar = (
    <div className="tax-print-toolbar mb-6 flex items-center justify-between gap-3">
      <Link
        to={`/portfolio/tax?${ACTIVE_PORTFOLIO_PARAM}=${portfolioId ?? ''}`}
        className="text-sm text-sky-700 underline"
      >
        {t('portfolio.taxReport.print.back')}
      </Link>
      <button
        type="button"
        onClick={() => {
          try {
            window.print();
          } catch {
            /* no-op without a print surface */
          }
        }}
        className="rounded-md border border-neutral-400 px-3 py-1.5 text-sm font-medium hover:bg-neutral-100"
      >
        {t('portfolio.taxReport.print.print')}
      </button>
    </div>
  );

  return (
    <div className="min-h-screen bg-white p-8 text-neutral-900">
      <style>{PRINT_STYLE}</style>
      {toolbar}

      <header className="mb-6 flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{t('portfolio.taxReport.title')}</h1>
        <p className="text-sm text-neutral-600">
          {[portfolioName, year].filter((v) => v !== null && v !== undefined).join(' · ')}
        </p>
      </header>

      {!paramsValid ? (
        <p className="text-sm text-neutral-600">{t('portfolio.taxReport.print.missingParams')}</p>
      ) : reportQuery.isPending ? (
        <p className="text-sm text-neutral-600">{EM_DASH}</p>
      ) : reportQuery.isError ? (
        <p className="text-sm text-red-700">{t('portfolio.taxReport.print.loadError')}</p>
      ) : (
        <div className="flex flex-col gap-4">
          <SummaryTable summary={reportQuery.data.summary} t={t} />
          {reportQuery.data.summary.de ? <DeBlock de={reportQuery.data.summary.de} t={t} /> : null}
          {reportQuery.data.positions.length === 0 ? (
            <p className="text-sm text-neutral-600">{t('portfolio.taxReport.detailEmpty')}</p>
          ) : (
            reportQuery.data.positions.map((position) => (
              <PositionBlock key={position.asset.id} position={position} t={t} />
            ))
          )}
        </div>
      )}
    </div>
  );
}
