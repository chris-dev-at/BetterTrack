import { lazy, Suspense, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useI18n, useT } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { getTaxYearReport, getTaxYearReports, taxYearReportCsvUrl } from '../../lib/portfolioApi';
import { relockTaxYear, unlockTaxYear } from '../../lib/settingsApi';
import { Disclaimer, EmptyState } from '../../ui';
import { Button, Icon, PageHead, SkeletonBlock } from '../../ui/origin';
import { Alert, TextField } from '../components/ui';
import { Dialog } from '../components/Dialog';
import { useMutationFeedback } from '../hooks/useMutationFeedback';
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

/**
 * The unlock ritual (§16 2026-08-07): a passed year's taxes never change until
 * the user re-authenticates with their password and opens that ONE year for
 * amendments. The dialog is deliberately explicit about what unlocking means —
 * backdated entries will change the year's settled taxes until it is re-locked.
 */
function UnlockYearDialog({
  year,
  onClose,
  onUnlocked,
}: {
  year: number;
  onClose: () => void;
  onUnlocked: () => void;
}) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => unlockTaxYear(year, password),
    onSuccess: () => {
      onUnlocked();
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError && err.code === 'INVALID_CREDENTIALS') {
        setError(t('portfolio.taxReport.unlockDialog.wrongPassword'));
      } else if (err instanceof ApiError && err.status === 429) {
        setError(t('portfolio.taxReport.unlockDialog.throttled'));
      } else {
        setError(t('common.genericError'));
      }
    },
  });

  return (
    <Dialog
      description={t('portfolio.taxReport.unlockDialog.description', { year })}
      onClose={onClose}
      phoneSheet
      title={t('portfolio.taxReport.unlockDialog.title', { year })}
      widthClassName="max-w-md"
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          mutation.mutate();
        }}
      >
        <Alert tone="info">{t('portfolio.taxReport.unlockDialog.consequence', { year })}</Alert>
        <TextField
          autoComplete="current-password"
          label={t('portfolio.taxReport.unlockDialog.passwordLabel')}
          name="password"
          onChange={(e) => setPassword(e.target.value)}
          required
          type="password"
          value={password}
        />
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button disabled={mutation.isPending} onClick={onClose} variant="quiet">
            {t('common.cancel')}
          </Button>
          <Button disabled={mutation.isPending || password.length === 0} type="submit">
            {t('portfolio.taxReport.unlockDialog.confirm', { year })}
          </Button>
        </div>
      </form>
    </Dialog>
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
  const queryClient = useQueryClient();
  const feedback = useMutationFeedback();
  const [searchParams] = useSearchParams();
  const [expandedYear, setExpandedYear] = useState<number | null>(null);
  // Tax year locking (§16 2026-08-07): which year the unlock ritual is open for.
  const [unlockingYear, setUnlockingYear] = useState<number | null>(null);

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

  // The lock state is PER USER (an amendment is an account-level legal act):
  // every portfolio's report of the same year flips together, so the whole
  // taxYears family invalidates on either transition.
  const invalidateReports = () =>
    void queryClient.invalidateQueries({ queryKey: ['portfolio', 'taxYears'] });
  const relockMutation = useMutation({
    mutationFn: (year: number) => relockTaxYear(year),
    onSuccess: (_state, year) => {
      invalidateReports();
      feedback.success(t('portfolio.taxReport.relockSuccess', { year }));
    },
    onError: (err: unknown) => {
      feedback.error(t('common.genericError'), err);
    },
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
  // Elapsed years the user explicitly opened for amendments (§16 2026-08-07):
  // the wire states them as `locked: false` (locked years are `true`, open
  // years omit the key). They stay amendable until explicitly re-locked, so
  // the banner below keeps the state loudly visible.
  const unlockedYears = years.filter((summary) => summary.locked === false);

  return (
    <div>
      {header}

      {unlockedYears.length > 0 ? (
        <div className="bt-section">
          <Alert tone="info">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="font-semibold">
                {unlockedYears.length === 1
                  ? t('portfolio.taxReport.unlockedBannerOne', { year: unlockedYears[0]!.year })
                  : t('portfolio.taxReport.unlockedBannerOther', {
                      years: unlockedYears.map((summary) => summary.year).join(', '),
                    })}
              </span>
              {unlockedYears.map((summary) => (
                <Button
                  disabled={relockMutation.isPending}
                  key={summary.year}
                  onClick={() => relockMutation.mutate(summary.year)}
                  size="sm"
                  variant="quiet"
                >
                  {t('portfolio.taxReport.relockYearAction', { year: summary.year })}
                </Button>
              ))}
            </div>
          </Alert>
        </div>
      ) : null}

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
                    onUnlock={(year) => setUnlockingYear(year)}
                    onRelock={(year) => relockMutation.mutate(year)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {unlockingYear !== null ? (
        <UnlockYearDialog
          year={unlockingYear}
          onClose={() => setUnlockingYear(null)}
          onUnlocked={() => {
            const year = unlockingYear;
            setUnlockingYear(null);
            invalidateReports();
            feedback.success(t('portfolio.taxReport.unlockSuccess', { year }));
          }}
        />
      ) : null}
    </div>
  );
}
