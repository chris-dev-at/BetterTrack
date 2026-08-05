import { lazy, Suspense, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { useI18n, useT } from '../../i18n';
import { getTaxYearReport, getTaxYearReports, taxYearReportCsvUrl } from '../../lib/portfolioApi';
import { Disclaimer, EmptyState } from '../../ui';
import { Button, Icon, PageHead, SkeletonBlock } from '../../ui/origin';
import { Alert } from '../components/ui';
import { useResolvedPrivacyMode } from '../vault/usePrivacyMode';
import { portfolioTaxSettingsKey, taxModeLabelKey } from './portfolioTax';
import {
  ACTIVE_PORTFOLIO_PARAM,
  portfolioSearch,
  resolveActivePortfolio,
} from './PortfolioSwitcher';
import { usePortfolioStore } from './PortfolioStoreProvider';
import { DeYearBlock, PositionBlock, YearRow } from './taxReportRows';

/**
 * The client-derived report is a separate chunk: it is the only part of this
 * route that needs the vault money engine and the client exporters, and a
 * normal-mode account must never download those (#1089). Reached only after
 * the account resolves to paranoid.
 */
const ParanoidTaxReport = lazy(() =>
  import('./ParanoidTaxReport').then((module) => ({ default: module.ParanoidTaxReport })),
);

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
      <div className="flex flex-col items-start gap-2 p-3">
        <Alert tone="error">{t('portfolio.taxReport.detailError')}</Alert>
        <Button onClick={() => void query.refetch()} size="sm">
          {t('common.retry')}
        </Button>
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

/**
 * Portfolio → Tax report (PROJECTPLAN.md §13.3 V3-P4). Per Europe/Vienna calendar
 * year (newest first): realized P/L, gross dividends, tax withheld, the same-year
 * loss-offset **refund** line, and the **net** tax the year holds — each year
 * expandable to a per-asset drill-down whose sells show their real basis (an
 * uncovered sell, #369, never fabricates gain on the portion you didn't hold).
 *
 * Portfolio-scoped: reads the active portfolio from the `?portfolio=` param like
 * the rest of the section, and the report is gated on that portfolio's EFFECTIVE
 * tax mode (issue #636).
 *
 * READ-ONLY about configuration. Choosing the mode lives on the Settings tab
 * (`PortfolioTaxSection`) — this page only *names* the mode its numbers were
 * computed under and links there, so a report that looks wrong can be diagnosed
 * without hunting for the switch.
 */
export function TaxReportPage() {
  const t = useT();
  const store = usePortfolioStore();
  const [searchParams] = useSearchParams();
  const [expandedYear, setExpandedYear] = useState<number | null>(null);

  // Paranoid accounts never fetch server tax data (PD7): every server query
  // below stays disabled until the account resolves to 'normal'. Pre-populated
  // caches must not leak through either — a cached ['portfolios'] entry would
  // otherwise resolve an active id and start the settings/report reads while
  // privacy is still pending or already paranoid.
  const privacyMode = useResolvedPrivacyMode();
  const serverReadsEnabled = privacyMode === 'normal';

  const portfoliosQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => store.listPortfolios(signal),
    staleTime: 60_000,
    enabled: serverReadsEnabled,
  });

  const portfolios = serverReadsEnabled ? (portfoliosQuery.data?.portfolios ?? []) : [];
  const param = searchParams.get(ACTIVE_PORTFOLIO_PARAM);
  const active = resolveActivePortfolio(portfolios, param);

  const settingsQuery = useQuery({
    queryKey: active ? portfolioTaxSettingsKey(active.id) : ['portfolio', 'taxSettings', 'none'],
    queryFn: ({ signal }) => store.getPortfolioTaxSettings(active!.id, signal),
    enabled: serverReadsEnabled && Boolean(active),
    staleTime: 30_000,
  });
  const mode = settingsQuery.data?.effective.mode ?? 'none';
  const taxActive = mode !== 'none';

  const reportQuery = useQuery({
    queryKey: ['portfolio', 'taxYears', active?.id],
    queryFn: ({ signal }) => getTaxYearReports(active!.id, signal),
    enabled: serverReadsEnabled && Boolean(active) && taxActive,
    staleTime: 30_000,
  });

  const header = (
    <PageHead sub={t('portfolio.taxReport.subtitle')} title={t('portfolio.taxReport.title')}>
      {/* Owner-mandated liability framing (#635): keep the wording as decided. */}
      <Disclaimer>{t('settings.taxes.disclaimer')}</Disclaimer>
    </PageHead>
  );

  if (privacyMode === 'paranoid') {
    return (
      <Suspense
        fallback={
          <div>
            {header}
            <SkeletonBlock height={96} />
          </div>
        }
      >
        <ParanoidTaxReport header={header} />
      </Suspense>
    );
  }

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
          cta={<Button onClick={() => void portfoliosQuery.refetch()}>{t('common.retry')}</Button>}
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

      {/* Which mode these numbers were computed under — read-only (issue #636).
          Configuration lives in the Settings tab; naming the mode here is what
          makes a wrong-looking report diagnosable without hunting for it. */}
      {settingsQuery.data ? (
        <p className="bt-pftax-line">
          <span>
            {t('portfolio.taxReport.mode.line', {
              mode: t(taxModeLabelKey(settingsQuery.data.effective)),
            })}
          </span>
          <span className="bt-badge">
            {settingsQuery.data.source === 'portfolio'
              ? t('portfolio.settings.tax.overridden')
              : t('portfolio.settings.tax.inheriting')}
          </span>
          <Link
            className="bt-link"
            to={{ pathname: '/portfolio/settings', search: portfolioSearch(active.id) }}
          >
            {t('portfolio.taxReport.mode.change')}
          </Link>
        </p>
      ) : null}

      <div className="bt-section">
        {settingsQuery.isPending ? (
          <SkeletonBlock height={96} />
        ) : settingsQuery.isError ? (
          <EmptyState
            description={t('settings.retryHint')}
            title={t('portfolio.taxReport.loadError.title')}
            cta={<Button onClick={() => void settingsQuery.refetch()}>{t('common.retry')}</Button>}
          />
        ) : !taxActive ? (
          // The report is only meaningful with a tax mode active for THIS
          // portfolio; the Settings tab is where one gets turned on.
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
            cta={<Button onClick={() => void reportQuery.refetch()}>{t('common.retry')}</Button>}
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
                    summary={summary}
                    expanded={expandedYear === summary.year}
                    onToggle={() =>
                      setExpandedYear((cur) => (cur === summary.year ? null : summary.year))
                    }
                    detail={<YearDetail portfolioId={active.id} year={summary.year} />}
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
