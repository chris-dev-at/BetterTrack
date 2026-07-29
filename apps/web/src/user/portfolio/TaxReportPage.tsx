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
import { Disclaimer, EmptyState, MoneyText } from '../../ui';
import { Badge, Icon, PageHead, Panel, SkeletonBlock } from '../../ui/origin';
import { Alert } from '../components/ui';
import { TaxModePicker } from '../settings/taxModePicker';
import { ACTIVE_PORTFOLIO_PARAM, resolveActivePortfolio } from './PortfolioSwitcher';

/** Query key for one portfolio's resolved tax treatment (issue #636). */
const portfolioTaxSettingsKey = (portfolioId: string) =>
  ['portfolio', 'taxSettings', portfolioId] as const;

/** One sell inside a year's drill-down (#369 uncovered sells render their real basis). */
function SellRow({ sell }: { sell: TaxYearSell }) {
  return (
    <tr>
      <td className="bt-muted">{formatDate(sell.executedAt)}</td>
      <td className="is-num bt-soft">{formatQuantity(sell.quantity)}</td>
      <td className="is-num bt-soft">
        <MoneyText amount={sell.proceedsEur} currency="EUR" />
      </td>
      <td className="is-num bt-soft">
        <MoneyText amount={sell.costBasisEur} currency="EUR" />
      </td>
      <td className="is-num">
        <MoneyText amount={sell.realizedPnlEur} currency="EUR" signed />
      </td>
      <td className="is-num bt-soft">
        {sell.taxAmountEur === null ? (
          <span className="bt-muted">{EM_DASH}</span>
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
    <Panel className="flex flex-col gap-2" soft>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex items-baseline gap-2">
          <span className="bt-row-title">{position.asset.symbol}</span>
          <span className="bt-row-sub truncate">{position.asset.name}</span>
        </span>
        <span className="flex items-center gap-4">
          <span className="bt-meta">
            {t('portfolio.taxReport.realized')}{' '}
            <MoneyText amount={position.realizedPnlEur} currency="EUR" signed />
          </span>
          <span className="bt-meta">
            {t('portfolio.taxReport.tax')}{' '}
            <span className="bt-soft">
              <MoneyText amount={position.taxEur} currency="EUR" />
            </span>
          </span>
        </span>
      </div>
      {position.sells.length > 0 ? (
        <div className="bt-table-wrap">
          <table className="bt-table" style={{ fontSize: 12.5 }}>
            <thead>
              <tr>
                <th scope="col">{t('portfolio.taxReport.sell.date')}</th>
                <th className="is-num" scope="col">
                  {t('portfolio.taxReport.sell.quantity')}
                </th>
                <th className="is-num" scope="col">
                  {t('portfolio.taxReport.sell.proceeds')}
                </th>
                <th className="is-num" scope="col">
                  {t('portfolio.taxReport.sell.costBasis')}
                </th>
                <th className="is-num" scope="col">
                  {t('portfolio.taxReport.sell.realized')}
                </th>
                <th className="is-num" scope="col">
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
        </div>
      ) : null}
    </Panel>
  );
}

/** One label/value pair inside the compact DE year block. */
function DeStat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
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
      <span aria-hidden="true" className="bt-muted">
        {' → '}
      </span>
      <MoneyText amount={outEur} currency="EUR" />
    </>
  );
  return (
    <Panel className="flex flex-col gap-2" soft>
      <span className="bt-row-title">{t('portfolio.taxReport.de.title')}</span>
      <dl className="bt-kv">
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
    </Panel>
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
    <div className="flex items-center justify-end gap-2">
      <a
        className="bt-btn bt-btn--quiet bt-btn--sm"
        download
        href={taxYearReportCsvUrl(portfolioId, year, csvLocale)}
      >
        <Icon name="download" size={15} />
        {t('portfolio.taxReport.export.csv')}
      </a>
      <Link
        className="bt-btn bt-btn--quiet bt-btn--sm"
        rel="noopener"
        target="_blank"
        to={printHref}
      >
        <Icon name="printer" size={15} />
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
        <SkeletonBlock height={40} />
        <SkeletonBlock height={40} />
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
        <p className="bt-meta" style={{ padding: '8px 0' }}>
          {t('portfolio.taxReport.detailEmpty')}
        </p>
        {/* Owner-mandated liability framing (#635): repeated under each year block. */}
        <Disclaimer>{t('settings.taxes.disclaimer')}</Disclaimer>
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
      {/* Owner-mandated liability framing (#635): repeated under each year block. */}
      <Disclaimer>{t('settings.taxes.disclaimer')}</Disclaimer>
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
      <tr>
        <td>
          <button
            aria-expanded={expanded}
            aria-label={t(
              expanded ? 'portfolio.taxReport.collapseYear' : 'portfolio.taxReport.expandYear',
              { year: summary.year },
            )}
            className="bt-row-title"
            onClick={onToggle}
            style={{
              alignItems: 'center',
              background: 'none',
              border: 0,
              cursor: 'pointer',
              display: 'inline-flex',
              gap: 8,
              padding: 0,
            }}
            type="button"
          >
            <span aria-hidden="true" className="bt-muted">
              {expanded ? '▾' : '▸'}
            </span>
            {summary.year}
          </button>
          {summary.locked ? (
            <Badge
              className="ml-2"
              outline
              style={{ verticalAlign: 'middle' }}
              title={t('portfolio.taxReport.passedHint')}
            >
              {t('portfolio.taxReport.passed')}
            </Badge>
          ) : null}
        </td>
        <td className="is-num">
          <MoneyText amount={summary.realizedPnlEur} currency="EUR" signed />
        </td>
        <td className="is-num bt-soft">
          <MoneyText amount={summary.dividendsGrossEur} currency="EUR" />
        </td>
        <td className="is-num bt-soft">
          <MoneyText amount={summary.taxWithheldEur} currency="EUR" />
        </td>
        <td className="is-num bt-pos">
          {summary.taxRefundedEur > 0 ? (
            <MoneyText amount={summary.taxRefundedEur} currency="EUR" />
          ) : (
            <span className="bt-muted">{EM_DASH}</span>
          )}
        </td>
        <td className="is-num">
          <MoneyText amount={summary.taxNetEur} currency="EUR" />
        </td>
      </tr>
      {expanded ? (
        <tr style={{ background: 'var(--bt-bg-raised)' }}>
          <td colSpan={6} style={{ padding: 0 }}>
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
    <details className="bt-panel bt-band" open={overridden}>
      <summary className="bt-band__row flex cursor-pointer flex-wrap items-center justify-between gap-2">
        <span className="flex flex-col gap-0.5">
          <span className="bt-row-title">
            {t('portfolio.taxReport.treatment.title', { name: portfolioName })}
          </span>
          <span className="bt-row-sub">{t('portfolio.taxReport.treatment.description')}</span>
        </span>
        <Badge tone={overridden ? 'blue' : 'neutral'}>
          {overridden
            ? t('portfolio.taxReport.treatment.overridden')
            : t('portfolio.taxReport.treatment.inheriting')}
        </Badge>
      </summary>
      <div className="bt-band__row flex flex-col gap-3">
        {query.isPending ? (
          <SkeletonBlock height={64} />
        ) : query.isError || !query.data ? (
          <EmptyState
            description={t('settings.retryHint')}
            title={t('portfolio.taxReport.loadError.title')}
          />
        ) : (
          <>
            <TaxModePicker
              ariaLabel={t('portfolio.taxReport.treatment.title', { name: portfolioName })}
              busy={busy}
              name={`portfolio-tax-${portfolioId}`}
              onSelect={(body) => overrideMutation.mutate(body)}
              value={query.data.effective}
            />
            {overridden ? (
              <button
                className="bt-link w-fit"
                disabled={busy}
                onClick={() => resetMutation.mutate()}
                type="button"
              >
                {t('portfolio.taxReport.treatment.reset')}
              </button>
            ) : (
              <Link className="bt-link w-fit" to="/settings/taxes">
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
    <PageHead sub={t('portfolio.taxReport.subtitle')} title={t('portfolio.taxReport.title')}>
      {/* Owner-mandated liability framing (#635): keep the wording as decided. */}
      <Disclaimer>{t('settings.taxes.disclaimer')}</Disclaimer>
    </PageHead>
  );

  // Loading / error gate on the portfolio list — it resolves the active id that
  // drives everything below (the per-portfolio tax settings + the report).
  if (portfoliosQuery.isPending) {
    return (
      <div>
        {header}
        <SkeletonBlock height={96} />
      </div>
    );
  }

  if (portfoliosQuery.isError) {
    return (
      <div>
        {header}
        <EmptyState
          description={t('settings.retryHint')}
          title={t('portfolio.taxReport.loadError.title')}
        />
      </div>
    );
  }

  if (!active) {
    return (
      <div>
        {header}
        <EmptyState
          description={t('portfolio.taxReport.empty.description')}
          icon="🧾"
          title={t('portfolio.taxReport.empty.title')}
        />
      </div>
    );
  }

  const years = reportQuery.data?.years ?? [];

  return (
    <div>
      {header}

      {/* Per-portfolio tax treatment (issue #636): inherit / override / reset. */}
      <div className="bt-section">
        <PortfolioTaxTreatment portfolioId={active.id} portfolioName={active.name} />
      </div>

      <div className="bt-section">
        {settingsQuery.isPending ? (
          <SkeletonBlock height={96} />
        ) : settingsQuery.isError ? (
          <EmptyState
            description={t('settings.retryHint')}
            title={t('portfolio.taxReport.loadError.title')}
          />
        ) : !taxActive ? (
          // The report is only meaningful with a tax mode active for THIS
          // portfolio; the treatment control above turns one on.
          <EmptyState
            description={t('portfolio.taxReport.disabled.description')}
            icon="🧾"
            title={t('portfolio.taxReport.disabled.title')}
          />
        ) : reportQuery.isPending ? (
          <SkeletonBlock height={96} />
        ) : reportQuery.isError ? (
          <EmptyState
            description={t('settings.retryHint')}
            title={t('portfolio.taxReport.loadError.title')}
          />
        ) : years.length === 0 ? (
          <EmptyState
            description={t('portfolio.taxReport.empty.description')}
            icon="🧾"
            title={t('portfolio.taxReport.empty.title')}
          />
        ) : (
          <div className="bt-table-wrap bt-table-wrap--panel">
            <table className="bt-table">
              <thead>
                <tr>
                  <th scope="col">{t('portfolio.taxReport.column.year')}</th>
                  <th className="is-num" scope="col">
                    {t('portfolio.taxReport.column.realized')}
                  </th>
                  <th className="is-num" scope="col">
                    {t('portfolio.taxReport.column.dividends')}
                  </th>
                  <th className="is-num" scope="col">
                    {t('portfolio.taxReport.column.withheld')}
                  </th>
                  <th className="is-num" scope="col">
                    {t('portfolio.taxReport.column.refund')}
                  </th>
                  <th className="is-num" scope="col">
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
    </div>
  );
}
