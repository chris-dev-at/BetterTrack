import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

import type { PortfolioSummary, TaxMode } from '@bettertrack/contracts';

import { useI18n, useT } from '../../i18n';
import { Disclaimer, EmptyState } from '../../ui';
import { Button, Icon, Page, SkeletonBlock } from '../../ui/origin';
import { Alert } from '../components/ui';
import { vaultMoneyErrorKey } from '../vault/engine/errorCopy';
import { asMoneyFailure, type VaultMoneyFailure } from '../vault/engine/errors';
import { clientTaxYears } from '../vault/engine/taxEngine';
import type { ClientTaxReport } from '../vault/engine/types';
import {
  useVaultMoneySession,
  type VaultMoneySession,
} from '../vault/engine/VaultMoneyEngineContext';
import { deliverClientDownload, printClientDocument } from '../vault/export/deliver';
import { createClientTaxCsv } from '../vault/export/taxCsv';
import { createPrintableTaxReport } from '../vault/export/taxPrint';
import { ACTIVE_PORTFOLIO_PARAM, resolveActivePortfolio } from './PortfolioSwitcher';
import { DeYearBlock, PositionBlock, YearRow } from './taxReportRows';

/**
 * The paranoid tax surface (PD7): every number derives client-side from the
 * decrypted vault through the shared audited domain — no server tax endpoint
 * is ever consulted. Requires an unlocked vault money session; while locked it
 * renders the unlock prompt instead of any figure.
 *
 * Its own module because it is the only part of `/portfolio/tax` that needs the
 * client money engine and the client exporters: `TaxReportPage` reaches it
 * through `lazy()`, so a normal-mode account opening the tax report never
 * downloads that graph (#1089).
 */
export function ParanoidTaxReport({ header }: { header: ReactNode }) {
  const t = useT();
  const [searchParams] = useSearchParams();
  const session = useVaultMoneySession();
  const param = searchParams.get(ACTIVE_PORTFOLIO_PARAM);
  const [portfolioAttempt, setPortfolioAttempt] = useState(0);
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
  }, [portfolioAttempt, session]);

  if (session === null) {
    return (
      <Page className="bt-portfolio-page bt-tax-report-page" width="wide">
        {header}
        <EmptyState
          description={t('portfolio.taxReport.paranoid.locked.description')}
          icon="🔒"
          title={t('portfolio.taxReport.paranoid.locked.title')}
        />
      </Page>
    );
  }

  if (portfolios.status === 'pending') {
    return (
      <Page className="bt-portfolio-page bt-tax-report-page" width="wide">
        {header}
        <SkeletonBlock height={96} />
      </Page>
    );
  }

  if (portfolios.status === 'error') {
    return (
      <Page className="bt-portfolio-page bt-tax-report-page" width="wide">
        {header}
        <EmptyState
          cta={
            portfolios.failure.retryable ? (
              <Button onClick={() => setPortfolioAttempt((attempt) => attempt + 1)}>
                {t('portfolio.taxReport.paranoid.retry')}
              </Button>
            ) : undefined
          }
          description={t(vaultMoneyErrorKey(portfolios.failure))}
          title={t('portfolio.taxReport.loadError.title')}
        />
      </Page>
    );
  }

  const active = resolveActivePortfolio(portfolios.list, param);
  if (!active) {
    return (
      <Page className="bt-portfolio-page bt-tax-report-page" width="wide">
        {header}
        <EmptyState
          description={t('portfolio.taxReport.empty.description')}
          icon="🧾"
          title={t('portfolio.taxReport.empty.title')}
        />
      </Page>
    );
  }

  return (
    <Page className="bt-portfolio-page bt-tax-report-page" width="wide">
      {header}
      <div className="bt-section">
        <ParanoidYearTable session={session} portfolio={active} />
      </div>
    </Page>
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
