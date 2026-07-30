import { useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import type {
  PortfolioSummary,
  TaxMode,
  TaxYearDeSummary,
  TaxYearPosition,
  TaxYearSell,
  TaxYearSummary,
} from '@bettertrack/contracts';

import { useI18n, useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { EM_DASH, formatDate, formatQuantity } from '../../lib/format';
import {
  getPortfolioTaxSettings,
  getTaxYearReport,
  getTaxYearReports,
  listPortfolios,
  taxYearReportCsvUrl,
} from '../../lib/portfolioApi';
import { Disclaimer, EmptyState, MoneyText } from '../../ui';
import { Badge, Icon, PageHead, Panel, SkeletonBlock } from '../../ui/origin';
import { Alert } from '../components/ui';
import { vaultMoneyErrorKey } from '../vault/engine/errorCopy';
import { asMoneyFailure, type VaultMoneyFailure } from '../vault/engine/errors';
import { clientTaxYears } from '../vault/engine/taxEngine';
import type { ClientTaxReport } from '../vault/engine/types';
import {
  useVaultMoneySession,
  type VaultMoneySession,
} from '../vault/engine/VaultMoneyEngineProvider';
import { deliverClientDownload, printClientDocument } from '../vault/export/deliver';
import { createClientTaxCsv } from '../vault/export/taxCsv';
import { createPrintableTaxReport } from '../vault/export/taxPrint';
import { usePrivacyMode } from '../vault/usePrivacyMode';
import { portfolioTaxSettingsKey, taxModeLabelKey } from './portfolioTax';
import {
  ACTIVE_PORTFOLIO_PARAM,
  portfolioSearch,
  resolveActivePortfolio,
} from './PortfolioSwitcher';

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
  summary,
  expanded,
  onToggle,
  detail,
}: {
  summary: TaxYearSummary;
  expanded: boolean;
  onToggle: () => void;
  /** The drill-down content rendered while expanded (server-fetched or client-derived). */
  detail: ReactNode;
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
            {detail}
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
  const [searchParams] = useSearchParams();
  const [expandedYear, setExpandedYear] = useState<number | null>(null);

  // Paranoid accounts never fetch server tax data (PD7): every server query
  // below stays disabled until the account resolves to 'normal'. Pre-populated
  // caches must not leak through either — a cached ['portfolios'] entry would
  // otherwise resolve an active id and start the settings/report reads while
  // privacy is still pending or already paranoid.
  const privacy = usePrivacyMode();
  const serverReadsEnabled = privacy.privacyMode === 'normal';

  const portfoliosQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => listPortfolios(signal),
    staleTime: 60_000,
    enabled: serverReadsEnabled,
  });

  const portfolios = serverReadsEnabled ? (portfoliosQuery.data?.portfolios ?? []) : [];
  const param = searchParams.get(ACTIVE_PORTFOLIO_PARAM);
  const active = resolveActivePortfolio(portfolios, param);

  const settingsQuery = useQuery({
    queryKey: active ? portfolioTaxSettingsKey(active.id) : ['portfolio', 'taxSettings', 'none'],
    queryFn: ({ signal }) => getPortfolioTaxSettings(active!.id, signal),
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

  if (privacy.isPending) {
    return (
      <div>
        {header}
        <SkeletonBlock height={96} />
      </div>
    );
  }

  if (privacy.isError) {
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

  if (privacy.privacyMode === 'paranoid') {
    return <ParanoidTaxReport header={header} />;
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

/**
 * The paranoid tax surface (PD7): every number derives client-side from the
 * decrypted vault through the shared audited domain — no server tax endpoint
 * is ever consulted. Requires an unlocked vault money session; while locked it
 * renders the unlock prompt instead of any figure.
 */
function ParanoidTaxReport({ header }: { header: ReactNode }) {
  const t = useT();
  const [searchParams] = useSearchParams();
  const session = useVaultMoneySession();
  const param = searchParams.get(ACTIVE_PORTFOLIO_PARAM);
  const [portfolios, setPortfolios] = useState<
    | { status: 'pending' }
    | { status: 'error'; failure: VaultMoneyFailure }
    | { status: 'ready'; list: PortfolioSummary[] }
  >({ status: 'pending' });

  useEffect(() => {
    if (session === null) return;
    const controller = new AbortController();
    setPortfolios({ status: 'pending' });
    session.store.listPortfolios(controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) {
          setPortfolios({ status: 'ready', list: result.portfolios });
        }
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) {
          setPortfolios({ status: 'error', failure: asMoneyFailure(cause) });
        }
      },
    );
    return () => controller.abort();
  }, [session]);

  if (session === null) {
    return (
      <div>
        {header}
        <EmptyState
          description={t('portfolio.taxReport.paranoid.locked.description')}
          icon="🔒"
          title={t('portfolio.taxReport.paranoid.locked.title')}
        />
      </div>
    );
  }

  if (portfolios.status === 'pending') {
    return (
      <div>
        {header}
        <SkeletonBlock height={96} />
      </div>
    );
  }

  if (portfolios.status === 'error') {
    return (
      <div>
        {header}
        <EmptyState
          description={t(vaultMoneyErrorKey(portfolios.failure))}
          title={t('portfolio.taxReport.loadError.title')}
        />
      </div>
    );
  }

  const active = resolveActivePortfolio(portfolios.list, param);
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

  return (
    <div>
      {header}
      <div className="bt-section">
        <ParanoidYearTable session={session} portfolio={active} />
      </div>
    </div>
  );
}

type ParanoidDerivation =
  | { status: 'pending' }
  | { status: 'error'; failure: VaultMoneyFailure }
  | { status: 'ready'; mode: TaxMode; reports: ClientTaxReport[] };

/**
 * Client-side year index + per-year reports for one portfolio. One derivation
 * per activity year through the engine; the drill-down and both exports reuse
 * the identical in-memory report object, so screen, CSV, and print never
 * disagree. Typed failures render as-is — never a partial table.
 */
function ParanoidYearTable({
  session,
  portfolio,
}: {
  session: VaultMoneySession;
  portfolio: PortfolioSummary;
}) {
  const t = useT();
  const [expandedYear, setExpandedYear] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [derived, setDerived] = useState<ParanoidDerivation>({ status: 'pending' });

  // Re-runs the whole derivation: the retry after a retryable failure, and the
  // way out of a stale table — a vault write synced in from another device
  // invalidates the derived reports, which the exports detect (scope assertion)
  // but the rendered table cannot see on its own.
  const rederive = () => setAttempt((current) => current + 1);

  useEffect(() => {
    const controller = new AbortController();
    setDerived({ status: 'pending' });
    void (async () => {
      const overview = clientTaxYears(session.sync, portfolio.id);
      if (!overview.ok) {
        if (!controller.signal.aborted) setDerived({ status: 'error', failure: overview.error });
        return;
      }
      const reports: ClientTaxReport[] = [];
      if (overview.value.mode !== 'none') {
        for (const year of overview.value.years) {
          const report = await session.engine.deriveTaxReport(
            portfolio.id,
            year,
            controller.signal,
          );
          if (!report.ok) {
            if (!controller.signal.aborted) setDerived({ status: 'error', failure: report.error });
            return;
          }
          reports.push(report.value);
        }
      }
      if (!controller.signal.aborted) {
        setDerived({ status: 'ready', mode: overview.value.mode, reports });
      }
    })();
    return () => controller.abort();
  }, [attempt, portfolio.id, session]);

  if (derived.status === 'pending') {
    return <SkeletonBlock height={96} />;
  }

  if (derived.status === 'error') {
    return (
      <EmptyState
        cta={
          derived.failure.retryable ? (
            <button className="bt-btn bt-btn--quiet bt-btn--sm" onClick={rederive} type="button">
              {t('portfolio.taxReport.paranoid.retry')}
            </button>
          ) : undefined
        }
        description={t(vaultMoneyErrorKey(derived.failure))}
        title={t('portfolio.taxReport.loadError.title')}
      />
    );
  }

  if (derived.mode === 'none') {
    return (
      <EmptyState
        description={t('portfolio.taxReport.paranoid.disabledDescription')}
        icon="🧾"
        title={t('portfolio.taxReport.disabled.title')}
      />
    );
  }

  if (derived.reports.length === 0) {
    return (
      <EmptyState
        description={t('portfolio.taxReport.empty.description')}
        icon="🧾"
        title={t('portfolio.taxReport.empty.title')}
      />
    );
  }

  return (
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
          {derived.reports.map((tax) => (
            <YearRow
              key={tax.report.year}
              summary={tax.report.summary}
              expanded={expandedYear === tax.report.year}
              onToggle={() =>
                setExpandedYear((cur) => (cur === tax.report.year ? null : tax.report.year))
              }
              detail={
                <ParanoidYearDetail
                  onStale={rederive}
                  portfolio={portfolio}
                  session={session}
                  tax={tax}
                />
              }
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The client-derived drill-down — same blocks as the server detail, no fetch. */
function ParanoidYearDetail({
  session,
  portfolio,
  tax,
  onStale,
}: {
  session: VaultMoneySession;
  portfolio: PortfolioSummary;
  tax: ClientTaxReport;
  /** Re-derives the table when an export refuses this now-stale report. */
  onStale: () => void;
}) {
  const t = useT();
  const positions = tax.report.positions;
  return (
    <div className="flex flex-col gap-3 p-3">
      <ParanoidYearActions onStale={onStale} portfolio={portfolio} session={session} tax={tax} />
      {tax.report.summary.de ? <DeYearBlock de={tax.report.summary.de} t={t} /> : null}
      {positions.length === 0 ? (
        <p className="bt-meta" style={{ padding: '8px 0' }}>
          {t('portfolio.taxReport.detailEmpty')}
        </p>
      ) : (
        positions.map((position) => (
          <PositionBlock key={position.asset.id} position={position} t={t} />
        ))
      )}
      {/* Owner-mandated liability framing (#635): repeated under each year block. */}
      <Disclaimer>{t('settings.taxes.disclaimer')}</Disclaimer>
    </div>
  );
}

/**
 * Per-year export actions in paranoid mode: the CSV and the printable document
 * are generated in the browser from the SAME in-memory report the table shows
 * — no server round trip, no persistence beyond the transient download.
 */
function ParanoidYearActions({
  session,
  portfolio,
  tax,
  onStale,
}: {
  session: VaultMoneySession;
  portfolio: PortfolioSummary;
  tax: ClientTaxReport;
  /** Re-derives the table after a retryable refusal (typically a stale report). */
  onStale: () => void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const [failure, setFailure] = useState<VaultMoneyFailure | null>(null);
  const exportLocale = locale === 'de' ? 'de' : 'en';

  function onCsv() {
    const csv = createClientTaxCsv(session.sync, portfolio.id, tax, exportLocale);
    if (!csv.ok) {
      setFailure(csv.error);
      return;
    }
    setFailure(null);
    deliverClientDownload(csv.value.text, csv.value.mediaType, csv.value.filename);
  }

  function onPrint() {
    const doc = createPrintableTaxReport(
      session.sync,
      portfolio.id,
      tax,
      exportLocale,
      portfolio.name,
    );
    if (!doc.ok) {
      setFailure(doc.error);
      return;
    }
    setFailure(null);
    printClientDocument(doc.value.html);
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center justify-end gap-2">
        <button className="bt-btn bt-btn--quiet bt-btn--sm" onClick={onCsv} type="button">
          <Icon name="download" size={15} />
          {t('portfolio.taxReport.export.csv')}
        </button>
        <button className="bt-btn bt-btn--quiet bt-btn--sm" onClick={onPrint} type="button">
          <Icon name="printer" size={15} />
          {t('portfolio.taxReport.export.print')}
        </button>
      </div>
      {failure ? (
        <Alert tone="error">
          <span className="flex flex-wrap items-center gap-2">
            {t(vaultMoneyErrorKey(failure))}
            {/* A refused export usually means the vault moved under the rendered
                report (another device synced a write) — re-deriving is the way
                out, so the alert carries the same retry the table error has. */}
            {failure.retryable ? (
              <button className="bt-link" onClick={onStale} type="button">
                {t('portfolio.taxReport.paranoid.retry')}
              </button>
            ) : null}
          </span>
        </Alert>
      ) : null}
    </div>
  );
}
