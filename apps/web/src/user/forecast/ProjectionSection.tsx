import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { PortfolioHistoryRange, PortfolioSummary } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { getAnalyticsSeries } from '../../lib/analyticsApi';
import { cx } from '../../lib/cx';
import { useDeployCapability } from '../../lib/featureFlags';
import { formatMoney, getMoneyCurrency } from '../../lib/format';
import {
  getPortfolioDividendProjectionFor,
  PORTFOLIO_DIVIDEND_PROJECTION_SCOPED_QUERY_KEY,
} from '../../lib/marketIntelApi';
import { EmptyState, Skeleton, StatCard } from '../../ui';
import { overlayColor } from '../../ui/charts';
import { MAIN_SERIES } from '../../ui/charts/palette';
import { AsyncReadState, type AsyncRead } from '../components/AsyncReadState';
import { Button, TextField } from '../components/ui';
import { usePortfolioStore } from '../portfolio/PortfolioStoreProvider';
import { isVaultedPortfolio } from '../portfolio/lockedPortfolio';
import { clientSeriesCagrPct } from '../vault/engine/clientSeries';
import { useResolvedPrivacyMode } from '../vault/usePrivacyMode';

import {
  FORECAST_HORIZON_MAX_YEARS,
  FORECAST_HORIZON_MIN_YEARS,
  FORECAST_RETURN_MAX_PCT,
  FORECAST_RETURN_MIN_PCT,
  clampForecastReturnPct,
  normalizeStandingOrders,
  projectNetWorth,
  type ForecastWhatIfPlan,
} from './projection';

const ProjectionChart = lazy(() =>
  import('./ProjectionChart').then((module) => ({ default: module.ProjectionChart })),
);

/**
 * Forecast projection view (PROJECTPLAN.md §13.5 V5-P6b arc (b), issue #596) —
 * the deterministic client-side net-worth projection that fills the #594 slot.
 * It reads the active portfolio's value + sampled historical return, its active
 * standing orders and the projected dividend income, then draws the base
 * projection with one overlay per local what-if plan. Every factor toggles
 * individually and the base line responds; what-if plans are local state only
 * (never persisted). The engine (`./projection`) is pure and hand-fixtured; this
 * surface only resolves inputs and renders — compact per the anti-bloat rule.
 */

/**
 * Base line colour — matches PriceChart's main sky line. Single owner: the
 * legend chip below and the lazily-loaded renderer both read it from here.
 */
const BASE_LINE = MAIN_SERIES;

/** Historical-return sampling windows offered to the user (default 5 years). */
const RETURN_WINDOWS = ['1Y', '3Y', '5Y', 'Max'] as const;
type ReturnWindow = (typeof RETURN_WINDOWS)[number];
const DEFAULT_RETURN_WINDOW: ReturnWindow = '5Y';

/** A locally-edited what-if plan draft (kept as strings; parsed at projection time). */
interface WhatIfDraft {
  id: string;
  label: string;
  monthlyContribution: string;
  ownReturn: string;
}

export function ProjectionSection({ portfolios }: { portfolios: PortfolioSummary[] }) {
  const t = useT();
  const store = usePortfolioStore();
  const privacyMode = useResolvedPrivacyMode();
  // Whether this deployment has market intelligence at all (§13.5 V5-P5). Off ⇒
  // the dividend factor does not exist here; that is a different statement from
  // "configured, but this portfolio's projection could not be computed".
  const marketIntel = useDeployCapability('marketIntel');

  const portfolioId = useMemo(() => {
    const available = portfolios.filter((portfolio) => !isVaultedPortfolio(portfolio));
    return (available.find((portfolio) => portfolio.isDefault) ?? available[0])?.id ?? null;
  }, [portfolios]);

  // ── Factor state ───────────────────────────────────────────────────────────
  const [horizon, setHorizon] = useState('20');
  const [returnEnabled, setReturnEnabled] = useState(true);
  const [returnWindow, setReturnWindow] = useState<ReturnWindow>(DEFAULT_RETURN_WINDOW);
  const [returnPct, setReturnPct] = useState('');
  const [ordersEnabled, setOrdersEnabled] = useState(true);
  const [dividendEnabled, setDividendEnabled] = useState(true);
  const [plans, setPlans] = useState<WhatIfDraft[]>([]);
  const nextPlanId = useRef(1);

  const asOf = todayIso();
  const windowFrom = windowStartIso(asOf, returnWindow);

  // ── Read-only data sources (all degrade to an empty/off factor on error) ────
  const portfolioQuery = useQuery({
    queryKey: ['portfolio', portfolioId],
    queryFn: ({ signal }) => store.getPortfolio(portfolioId!, signal),
    enabled: portfolioId !== null,
    staleTime: 60_000,
  });

  // The sampled return has one source per account mode, and they are different
  // series — see `usePortfolioPrefill` in ForecastPage.tsx for the full note.
  // Normal accounts keep the server's holdings-only analytics window verbatim
  // (same endpoint, same params, same query key as before the store seam).
  const analyticsQuery = useQuery({
    queryKey: ['analytics', portfolioId, 'series', { mode: 'value', window: returnWindow }],
    queryFn: ({ signal }) =>
      getAnalyticsSeries(portfolioId!, { mode: 'value', from: windowFrom }, signal),
    enabled: portfolioId !== null && privacyMode === 'normal',
    staleTime: 60_000,
  });

  // Paranoid accounts have no analytics endpoint: the decrypted vault's own
  // net-worth curve is the only value series it can state. The 3Y control reads
  // the 5Y envelope and trims to the exact boundary locally.
  const historyQuery = useQuery({
    queryKey: ['portfolio', portfolioId, 'history', returnHistoryRange(returnWindow), false],
    queryFn: ({ signal }) =>
      store.getPortfolioHistory(portfolioId!, returnHistoryRange(returnWindow), false, signal),
    enabled: portfolioId !== null && privacyMode === 'paranoid',
    staleTime: 60_000,
  });

  const ordersQuery = useQuery({
    queryKey: ['standingOrders', portfolioId],
    queryFn: ({ signal }) => store.listStandingOrders(portfolioId!, signal),
    enabled: portfolioId !== null,
    staleTime: 60_000,
  });

  // Scoped to the portfolio this section projects, key included: the starting
  // value is ONE portfolio's `totalValueEur`, so a user-wide dividend total
  // would add the other portfolios' income to this portfolio's curve, and a
  // portfolio-less key would then serve that figure to the next portfolio too.
  const dividendQuery = useQuery({
    queryKey: PORTFOLIO_DIVIDEND_PROJECTION_SCOPED_QUERY_KEY(portfolioId ?? ''),
    queryFn: ({ signal }) => getPortfolioDividendProjectionFor(portfolioId!, signal),
    enabled: portfolioId !== null && privacyMode === 'normal' && marketIntel,
    staleTime: 60_000,
  });

  const prefillLoading =
    portfolioQuery.isLoading ||
    analyticsQuery.isLoading ||
    historyQuery.isLoading ||
    ordersQuery.isLoading ||
    dividendQuery.isLoading;
  // The reads that actually apply to this account: without a portfolio nothing
  // is enabled, and each mode samples its return from a different series. The
  // group is handed over whole so `AsyncReadState` classifies each failure on
  // its own — one read's 5xx can no longer be masked by another's confirmed
  // 403, and Retry re-runs only the reads that are genuinely recoverable.
  const prefillReads: AsyncRead[] =
    portfolioId === null
      ? []
      : [
          { error: portfolioQuery.error, refetch: () => portfolioQuery.refetch() },
          { error: ordersQuery.error, refetch: () => ordersQuery.refetch() },
          ...(privacyMode === 'normal'
            ? [
                { error: analyticsQuery.error, refetch: () => analyticsQuery.refetch() },
                { error: dividendQuery.error, refetch: () => dividendQuery.refetch() },
              ]
            : [{ error: historyQuery.error, refetch: () => historyQuery.refetch() }]),
        ];

  // The sampled historical return over the selected window (null when the series
  // is too short to state a CAGR); it drives the return field until edited. The
  // paranoid branch goes through `clientSeriesCagrPct` so the window's zero
  // edges are trimmed exactly like the analytics header trims them.
  const sampledReturnPct =
    privacyMode === 'paranoid'
      ? historyQuery.data == null
        ? null
        : clientSeriesCagrPct(
            historyQuery.data.points.filter(
              (point) => windowFrom === undefined || point.date >= windowFrom,
            ),
          )
      : (analyticsQuery.data?.primary.stats.cagrPct ?? null);
  useEffect(() => {
    setReturnPct(sampledReturnPct === null ? '' : String(round2(sampledReturnPct)));
  }, [sampledReturnPct]);

  // ── Resolve the projection factors ──────────────────────────────────────────
  const startingNetWorth = portfolioQuery.data?.totals.totalValueEur ?? 0;
  // `projectNetWorth` projects WHOLE years (it rounds its own input), so the
  // horizon is resolved to that same integer here, once, at the section
  // boundary: the label, the chart and the projected stat then all describe the
  // horizon that was actually modelled. The field is a bare number input with no
  // enclosing form, so constraint validation never fires and a typed or pasted
  // "2.5" reaches this state verbatim — without the rounding it would headline
  // the 3-year figure as "Projected in 2.5 years".
  const horizonYears = clamp(
    Math.round(safeNumber(horizon, FORECAST_HORIZON_MIN_YEARS)),
    FORECAST_HORIZON_MIN_YEARS,
    FORECAST_HORIZON_MAX_YEARS,
  );
  const enteredReturnPct = safeNumber(returnPct);
  const annualReturnPct = returnEnabled ? clampForecastReturnPct(enteredReturnPct) : 0;
  const returnPctIsClamped = returnEnabled && enteredReturnPct !== annualReturnPct;
  const standingOrders = ordersEnabled
    ? normalizeStandingOrders(ordersQuery.data?.orders ?? [])
    : [];
  // Three distinct dividend-factor states (#1681). No market intel on this
  // deployment, or an account mode that never reads the endpoint (paranoid
  // vaults project locally) ⇒ `dividendProjection` stays undefined and no
  // control renders. A resolved projection ⇒ a normal toggle. A projection this
  // portfolio could not resolve — #1616 makes the total all-or-nothing, so one
  // unresolvable holding lands here — ⇒ the control stays on the page, disabled
  // and explained, rather than removing the reason for the lower curve. Either
  // way an unusable factor contributes exactly 0, as before.
  const dividendProjection = marketIntel ? dividendQuery.data : undefined;
  // The projection now names its own denomination — the caller's base (§5.4) —
  // and the balance it is added to is in that same base. They can still disagree
  // for one render after a base change (either response may be the cached one),
  // and adding a figure in another currency to this balance is exactly the
  // defect #1741 closes: a mismatch counts as "could not resolve", so the factor
  // contributes 0 and says so rather than silently distorting the curve.
  //
  // The comparison is against the OTHER OPERAND's own denomination — the base
  // that travels beside `totals.totalValueEur` in the very same payload — not
  // against the display global. Comparing to the global would compare one
  // operand to the label and let a stale portfolio payload through in exactly
  // the window this guard exists for. Without a portfolio payload there is no
  // balance either (the start is 0), so the display currency it renders under is
  // the right fallback.
  const netWorthCurrency = portfolioQuery.data?.baseCurrency ?? getMoneyCurrency();
  const dividendDenominationMatches =
    dividendProjection === undefined || dividendProjection.currency === netWorthCurrency;
  const dividendAvailable = dividendProjection?.available === true && dividendDenominationMatches;
  const dividendUnresolved = dividendProjection !== undefined && !dividendAvailable;
  const monthlyDividend =
    dividendEnabled && dividendAvailable ? dividendProjection!.monthlyTotalBase : 0;

  const whatIfPlans: ForecastWhatIfPlan[] = plans.map((plan, index) => ({
    id: plan.id,
    label: plan.label.trim() || t('forecast.projection.whatIf.defaultLabel', { n: index + 1 }),
    monthlyContribution: safeNumber(plan.monthlyContribution),
    annualReturnPct: plan.ownReturn.trim() === '' ? null : safeNumber(plan.ownReturn),
  }));

  const result = useMemo(
    () =>
      projectNetWorth({
        asOf,
        startingNetWorth,
        horizonYears,
        annualReturnPct,
        standingOrders,
        monthlyDividend,
        whatIfPlans,
      }),
    [
      asOf,
      startingNetWorth,
      horizonYears,
      annualReturnPct,
      JSON.stringify(standingOrders),
      monthlyDividend,
      JSON.stringify(whatIfPlans),
    ],
  );

  if (portfolioId === null) {
    return (
      <EmptyState
        icon="📈"
        title={t('forecast.projection.noPortfolioTitle')}
        description={t('forecast.projection.noPortfolioDescription')}
      />
    );
  }

  const chartData = result.base.map((point, i) => {
    const row: Record<string, number | string> = { date: point.date, base: point.value };
    for (const overlay of result.overlays) row[overlay.id] = overlay.points[i]!.value;
    return row;
  });

  const finalBase = result.base[result.base.length - 1]?.value ?? startingNetWorth;

  // The base line plus each overlay, paired with a colour and final value — feeds
  // both the SVG lines and the accessible HTML legend the tests read.
  const legend = [
    { id: 'base', label: t('forecast.projection.baseLabel'), color: BASE_LINE, value: finalBase },
    ...result.overlays.map((overlay, i) => ({
      id: overlay.id,
      label: overlay.label,
      color: overlayColor(i),
      value: overlay.points[overlay.points.length - 1]?.value ?? 0,
    })),
  ];

  function addPlan() {
    const id = `wif-${nextPlanId.current++}`;
    setPlans((prev) => [...prev, { id, label: '', monthlyContribution: '200', ownReturn: '' }]);
  }
  function removePlan(id: string) {
    setPlans((prev) => prev.filter((plan) => plan.id !== id));
  }
  function patchPlan(id: string, patch: Partial<WhatIfDraft>) {
    setPlans((prev) => prev.map((plan) => (plan.id === id ? { ...plan, ...patch } : plan)));
  }

  return (
    <div className="flex flex-col gap-5 px-4 py-4">
      <p className="text-sm bt-muted">{t('forecast.projection.description')}</p>

      <AsyncReadState
        loading={prefillLoading}
        reads={prefillReads}
        errorLabel={t('forecast.prefill.error')}
        loadingLabel={t('forecast.prefill.loading')}
      />

      {/* ── Factor controls ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4 bt-panel bt-panel--pad">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            type="number"
            inputMode="numeric"
            min={FORECAST_HORIZON_MIN_YEARS}
            max={FORECAST_HORIZON_MAX_YEARS}
            label={t('forecast.projection.horizonLabel')}
            hint={t('forecast.projection.horizonHint')}
            value={horizon}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setHorizon(e.target.value)}
          />
        </div>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-xs font-semibold uppercase tracking-wide bt-muted">
            {t('forecast.projection.factorsLegend')}
          </legend>

          <FactorToggle
            label={t('forecast.projection.factor.return')}
            checked={returnEnabled}
            onChange={setReturnEnabled}
          />
          {returnEnabled ? (
            <div className="ml-6 flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs bt-muted">
                  {t('forecast.projection.returnWindowLabel')}
                </span>
                <div
                  role="group"
                  aria-label={t('forecast.projection.returnWindowLabel')}
                  className="bt-seg"
                >
                  {RETURN_WINDOWS.map((token) => {
                    const selected = token === returnWindow;
                    return (
                      <button
                        key={token}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setReturnWindow(token)}
                        className={cx('', selected && 'is-active')}
                      >
                        {t(`forecast.projection.window.${token}`)}
                      </button>
                    );
                  })}
                </div>
              </div>
              <TextField
                type="number"
                inputMode="decimal"
                min={FORECAST_RETURN_MIN_PCT}
                max={FORECAST_RETURN_MAX_PCT}
                step="any"
                className="sm:w-40"
                label={t('forecast.projection.returnPctLabel')}
                hint={t('forecast.projection.returnPctHint')}
                value={returnPct}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setReturnPct(e.target.value)}
              />
              {returnPctIsClamped ? (
                <p role="alert" className="text-xs bt-gold-note">
                  {t('forecast.projection.returnPctClamped')}
                </p>
              ) : null}
            </div>
          ) : null}

          <FactorToggle
            label={t('forecast.projection.factor.standingOrders')}
            checked={ordersEnabled}
            onChange={setOrdersEnabled}
          />
          {dividendAvailable || dividendUnresolved ? (
            <FactorToggle
              label={t('forecast.projection.factor.dividends')}
              checked={dividendEnabled && dividendAvailable}
              disabled={dividendUnresolved}
              note={dividendUnresolved ? t('forecast.projection.dividendsUnresolved') : undefined}
              onChange={setDividendEnabled}
            />
          ) : null}
        </fieldset>
      </div>

      {/* ── Chart + legend ──────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3">
        <div
          role="img"
          aria-label={t('forecast.projection.chartAria')}
          className="w-full"
          style={{ height: 320 }}
        >
          <Suspense fallback={<Skeleton className="rounded-md" height="h-full" />}>
            <ProjectionChart
              baseColor={BASE_LINE}
              baseLabel={t('forecast.projection.baseLabel')}
              data={chartData}
              overlays={result.overlays.map((overlay, index) => ({
                id: overlay.id,
                label: overlay.label,
                color: overlayColor(index),
              }))}
            />
          </Suspense>
        </div>

        <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
          {legend.map((series) => (
            <li
              key={series.id}
              data-testid={`projection-series-${series.id}`}
              className="flex items-center gap-1.5 text-xs bt-muted"
            >
              <span
                aria-hidden="true"
                className="inline-block h-0.5 w-4"
                style={{ backgroundColor: series.color }}
              />
              <span className="bt-soft">{series.label}</span>
              <span className="tabular-nums bt-muted">{formatMoney(series.value)}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* ── Headline stats ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <StatCard
          label={t('forecast.projection.startingLabel')}
          value={formatMoney(startingNetWorth)}
        />
        <StatCard
          label={t('forecast.projection.projectedLabel', { years: horizonYears })}
          value={formatMoney(finalBase)}
        />
      </div>

      {/* ── What-if plans (local only) ──────────────────────────────────── */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-col">
            <h3 className="text-sm font-semibold bt-soft">
              {t('forecast.projection.whatIf.title')}
            </h3>
            <p className="text-xs bt-muted">{t('forecast.projection.whatIf.description')}</p>
          </div>
          <Button variant="secondary" onClick={addPlan} className="shrink-0">
            {t('forecast.projection.whatIf.add')}
          </Button>
        </div>

        {plans.length === 0 ? (
          <p className="text-xs bt-muted">{t('forecast.projection.whatIf.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {plans.map((plan, index) => (
              <li
                key={plan.id}
                className="grid grid-cols-1 gap-3 bt-panel p-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end"
              >
                <TextField
                  label={t('forecast.projection.whatIf.labelLabel')}
                  placeholder={t('forecast.projection.whatIf.defaultLabel', { n: index + 1 })}
                  value={plan.label}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    patchPlan(plan.id, { label: e.target.value })
                  }
                />
                <TextField
                  type="number"
                  inputMode="decimal"
                  className="sm:w-36"
                  label={t('forecast.projection.whatIf.monthlyLabel')}
                  value={plan.monthlyContribution}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    patchPlan(plan.id, { monthlyContribution: e.target.value })
                  }
                />
                <TextField
                  type="number"
                  inputMode="decimal"
                  className="sm:w-32"
                  label={t('forecast.projection.whatIf.returnLabel')}
                  placeholder={t('forecast.projection.whatIf.returnPlaceholder')}
                  value={plan.ownReturn}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    patchPlan(plan.id, { ownReturn: e.target.value })
                  }
                />
                <Button
                  variant="ghost"
                  onClick={() => removePlan(plan.id)}
                  className="justify-self-start px-2 py-1 bt-muted sm:justify-self-auto"
                  aria-label={t('forecast.projection.whatIf.remove')}
                >
                  {t('forecast.projection.whatIf.remove')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Small building blocks ───────────────────────────────────────────────────

/**
 * A labelled checkbox factor toggle; the wrapping label is its accessible name.
 * An optional `note` sits outside that label — a disabled factor has to say why
 * without renaming the control the assertion and the user both look for.
 */
function FactorToggle({
  label,
  checked,
  onChange,
  disabled = false,
  note,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  note?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className={cx('flex items-center gap-2 text-sm bt-soft', disabled && 'opacity-60')}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded"
          style={{ accentColor: 'var(--bt-gold-graphic)' }}
        />
        <span>{label}</span>
      </label>
      {note ? <p className="text-xs bt-muted">{note}</p> : null}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Today as ISO `YYYY-MM-DD` — the projection's month-0 anchor. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function returnHistoryRange(window: ReturnWindow): PortfolioHistoryRange {
  if (window === '1Y') return '1Y';
  if (window === 'Max') return 'MAX';
  return '5Y';
}

/** Exact sample boundary; the 3Y control reads a 5Y envelope then trims locally. */
function windowStartIso(asOf: string, window: ReturnWindow): string | undefined {
  if (window === 'Max') return undefined;
  const years = window === '1Y' ? 1 : window === '3Y' ? 3 : 5;
  const date = new Date(`${asOf}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

function safeNumber(raw: string, fallback = 0): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
