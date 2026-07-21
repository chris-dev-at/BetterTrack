import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  PortfolioTaxSettingsResponse,
  TaxYearDeSummary,
  TaxYearPosition,
  TaxYearSell,
  TaxYearSummary,
  UpdateTaxSettingsRequest,
} from '@bettertrack/contracts';

import { useI18n, useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { EM_DASH, formatDate, formatQuantity } from '../../lib/format';
import {
  clearPortfolioTaxOverride,
  getPortfolioTaxSettings,
  getTaxYearReport,
  getTaxYearReports,
  listPortfolios,
  setPortfolioTaxOverride,
  taxYearReportCsvUrl,
} from '../../lib/portfolioApi';
import { EmptyState, MoneyText, Skeleton } from '../../ui';
import { Alert, cx } from '../components/ui';
import { TaxModePicker } from '../settings/taxModePicker';
import { ACTIVE_PORTFOLIO_PARAM, resolveActivePortfolio } from './PortfolioSwitcher';

/** Query key for one portfolio's resolved tax treatment (issue #636). */
const portfolioTaxSettingsKey = (portfolioId: string) =>
  ['portfolio', 'taxSettings', portfolioId] as const;

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

/** One label/value pair inside the compact DE year block. */
function DeStat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[0.65rem] uppercase tracking-wide text-neutral-600">{label}</dt>
      <dd className="tabular-nums text-neutral-300">{children}</dd>
    </div>
  );
}

/**
 * The German year-end block (V5-P4): the Sparer-Pauschbetrag consumed, both
 * loss pots entering → leaving the year, and the KapESt/Soli split — one
 * compact grid, shown only on years that actually carry DE-taxed rows
 * (anti-bloat: absent everywhere else).
 */
function DeYearBlock({ de, t }: { de: TaxYearDeSummary; t: TranslateFn }) {
  const pot = (inEur: number, outEur: number) => (
    <>
      <MoneyText amount={inEur} currency="EUR" />
      <span aria-hidden="true" className="text-neutral-600">
        {' → '}
      </span>
      <MoneyText amount={outEur} currency="EUR" />
    </>
  );
  return (
    <div className="flex flex-col gap-2 rounded-md border border-neutral-800 bg-neutral-950/40 p-3">
      <span className="text-xs font-semibold text-neutral-100">
        {t('portfolio.taxReport.de.title')}
      </span>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
        <DeStat label={t('portfolio.taxReport.de.allowanceUsed')}>
          <MoneyText amount={de.allowanceUsedEur} currency="EUR" />
        </DeStat>
        <DeStat label={t('portfolio.taxReport.de.allowanceRemaining')}>
          <MoneyText amount={de.allowanceRemainingEur} currency="EUR" />
        </DeStat>
        <DeStat label={t('portfolio.taxReport.de.aktienPot')}>
          {pot(de.aktienPotInEur, de.aktienPotOutEur)}
        </DeStat>
        <DeStat label={t('portfolio.taxReport.de.sonstigePot')}>
          {pot(de.sonstigePotInEur, de.sonstigePotOutEur)}
        </DeStat>
        <DeStat label={t('portfolio.taxReport.de.kapest')}>
          <MoneyText amount={de.kapestEur} currency="EUR" />
        </DeStat>
        <DeStat label={t('portfolio.taxReport.de.soli')}>
          <MoneyText amount={de.soliEur} currency="EUR" />
        </DeStat>
      </dl>
    </div>
  );
}

/**
 * Compact per-year export actions (V5-P4b, #583): a "CSV" download (the server
 * serializes the same report data, header language following the active locale)
 * and a "Print / PDF" link to the chrome-free print view. Both are scoped to
 * this portfolio+year — anti-bloat: shown only inside an expanded year.
 */
function YearActions({ portfolioId, year }: { portfolioId: string; year: number }) {
  const t = useT();
  const { locale } = useI18n();
  const csvLocale = locale === 'de' ? 'de' : 'en';
  const printHref = `/portfolio/tax/print?${ACTIVE_PORTFOLIO_PARAM}=${encodeURIComponent(
    portfolioId,
  )}&year=${year}`;
  return (
    <div className="flex items-center justify-end gap-3 text-xs">
      <a
        href={taxYearReportCsvUrl(portfolioId, year, csvLocale)}
        download
        className="font-medium text-sky-400 hover:text-sky-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        {t('portfolio.taxReport.export.csv')}
      </a>
      <Link
        to={printHref}
        target="_blank"
        rel="noopener"
        className="font-medium text-sky-400 hover:text-sky-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        {t('portfolio.taxReport.export.print')}
      </Link>
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
      <div className="flex flex-col gap-2 p-3">
        <YearActions portfolioId={portfolioId} year={year} />
        <p className="py-2 text-sm text-neutral-500">{t('portfolio.taxReport.detailEmpty')}</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 p-3">
      <YearActions portfolioId={portfolioId} year={year} />
      {query.data.summary.de ? <DeYearBlock de={query.data.summary.de} t={t} /> : null}
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
 * Per-portfolio tax-treatment control (issue #636): resolves and edits ONE
 * portfolio's tax mode/country through the scoping cascade
 * (`effective = override ?? user default ?? system('none')`). Shows whether the
 * portfolio is inheriting the user's new-portfolio default or has its own
 * override, lets the user pick an override, and — when overridden — reset back
 * to the default. Always rendered while a portfolio is active so the user can
 * turn tax on for THIS portfolio even when the default is `none`.
 */
function PortfolioTaxTreatment({
  portfolioId,
  portfolioName,
}: {
  portfolioId: string;
  portfolioName: string;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [error, setError] = useState(false);

  const query = useQuery({
    queryKey: portfolioTaxSettingsKey(portfolioId),
    queryFn: ({ signal }) => getPortfolioTaxSettings(portfolioId, signal),
    staleTime: 30_000,
  });

  const applyResult = (res: PortfolioTaxSettingsResponse) => {
    queryClient.setQueryData(portfolioTaxSettingsKey(portfolioId), res);
    // The effective mode gates the report + drives freezing of new rows.
    void queryClient.invalidateQueries({ queryKey: ['portfolio', 'taxYears', portfolioId] });
    setError(false);
  };
  const overrideMutation = useMutation({
    mutationFn: (body: UpdateTaxSettingsRequest) => setPortfolioTaxOverride(portfolioId, body),
    onSuccess: applyResult,
    onError: () => setError(true),
  });
  const resetMutation = useMutation({
    mutationFn: () => clearPortfolioTaxOverride(portfolioId),
    onSuccess: applyResult,
    onError: () => setError(true),
  });
  const busy = overrideMutation.isPending || resetMutation.isPending;

  const overridden = query.data?.source === 'portfolio';

  return (
    <details className="rounded-md border border-neutral-800 bg-neutral-900" open={overridden}>
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-3">
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-neutral-100">
            {t('portfolio.taxReport.treatment.title', { name: portfolioName })}
          </span>
          <span className="text-xs text-neutral-500">
            {t('portfolio.taxReport.treatment.description')}
          </span>
        </span>
        <span
          className={cx(
            'rounded-full px-2 py-0.5 text-xs font-medium',
            overridden ? 'bg-sky-500/10 text-sky-300' : 'bg-neutral-800 text-neutral-400',
          )}
        >
          {overridden
            ? t('portfolio.taxReport.treatment.overridden')
            : t('portfolio.taxReport.treatment.inheriting')}
        </span>
      </summary>
      <div className="flex flex-col gap-3 border-t border-neutral-800 px-4 py-3">
        {query.isPending ? (
          <Skeleton height="h-16" />
        ) : query.isError || !query.data ? (
          <EmptyState
            title={t('portfolio.taxReport.loadError.title')}
            description={t('settings.retryHint')}
          />
        ) : (
          <>
            <TaxModePicker
              value={query.data.effective}
              name={`portfolio-tax-${portfolioId}`}
              busy={busy}
              ariaLabel={t('portfolio.taxReport.treatment.title', { name: portfolioName })}
              onSelect={(body) => overrideMutation.mutate(body)}
            />
            {overridden ? (
              <button
                type="button"
                onClick={() => resetMutation.mutate()}
                disabled={busy}
                className="w-fit text-sm font-medium text-sky-400 hover:text-sky-300 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t('portfolio.taxReport.treatment.reset')}
              </button>
            ) : (
              <Link
                to="/settings/taxes"
                className="w-fit text-xs font-medium text-neutral-400 hover:text-neutral-200"
              >
                {t('portfolio.taxReport.treatment.editDefault')}
              </Link>
            )}
            {error ? <Alert tone="error">{t('settings.taxes.saveError')}</Alert> : null}
          </>
        )}
      </div>
    </details>
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
 * the rest of the section. The active portfolio's tax treatment resolves per
 * portfolio (issue #636): the treatment control lets the user override/reset it,
 * and the report below is gated on that portfolio's EFFECTIVE mode.
 */
export function TaxReportPage() {
  const t = useT();
  const [searchParams] = useSearchParams();
  const [expandedYear, setExpandedYear] = useState<number | null>(null);

  const portfoliosQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => listPortfolios(signal),
    staleTime: 60_000,
  });

  const portfolios = portfoliosQuery.data?.portfolios ?? [];
  const param = searchParams.get(ACTIVE_PORTFOLIO_PARAM);
  const active = resolveActivePortfolio(portfolios, param);

  const settingsQuery = useQuery({
    queryKey: active ? portfolioTaxSettingsKey(active.id) : ['portfolio', 'taxSettings', 'none'],
    queryFn: ({ signal }) => getPortfolioTaxSettings(active!.id, signal),
    enabled: Boolean(active),
    staleTime: 30_000,
  });
  const mode = settingsQuery.data?.effective.mode ?? 'none';
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

  // Loading / error gate on the portfolio list — it resolves the active id that
  // drives everything below (the per-portfolio tax settings + the report).
  if (portfoliosQuery.isPending) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <Skeleton height="h-24" />
      </div>
    );
  }

  if (portfoliosQuery.isError) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <EmptyState
          title={t('portfolio.taxReport.loadError.title')}
          description={t('settings.retryHint')}
        />
      </div>
    );
  }

  if (!active) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <EmptyState
          icon="🧾"
          title={t('portfolio.taxReport.empty.title')}
          description={t('portfolio.taxReport.empty.description')}
        />
      </div>
    );
  }

  const years = reportQuery.data?.years ?? [];

  return (
    <div className="flex flex-col gap-4">
      {header}

      {/* Per-portfolio tax treatment (issue #636): inherit / override / reset. */}
      <PortfolioTaxTreatment portfolioId={active.id} portfolioName={active.name} />

      {settingsQuery.isPending ? (
        <Skeleton height="h-24" />
      ) : settingsQuery.isError ? (
        <EmptyState
          title={t('portfolio.taxReport.loadError.title')}
          description={t('settings.retryHint')}
        />
      ) : !taxActive ? (
        // The report is only meaningful with a tax mode active for THIS
        // portfolio; the treatment control above turns one on.
        <EmptyState
          icon="🧾"
          title={t('portfolio.taxReport.disabled.title')}
          description={t('portfolio.taxReport.disabled.description')}
        />
      ) : reportQuery.isPending ? (
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
