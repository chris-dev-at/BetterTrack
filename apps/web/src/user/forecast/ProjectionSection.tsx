import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { PortfolioHistoryRange, PortfolioSummary } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { getAnalyticsSeries } from '../../lib/analyticsApi';
import { cx } from '../../lib/cx';
import { formatMoney, isDiscreetMode } from '../../lib/format';
import { getPortfolioDividendProjection } from '../../lib/marketIntelApi';
import { EmptyState, Skeleton } from '../../ui';
import { Stat, StatStrip } from '../../ui/origin';
import { overlayColor } from '../../ui/charts';
import { MAIN_SERIES } from '../../ui/charts/palette';
import { AsyncReadState, type AsyncRead } from '../components/AsyncReadState';
import { Button, TextField } from '../components/ui';
import { usePortfolioStore } from '../portfolio/PortfolioStoreProvider';
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

  const portfolioId = useMemo(
    () => (portfolios.find((p) => p.isDefault) ?? portfolios[0])?.id ?? null,
    [portfolios],
  );

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

  const dividendQuery = useQuery({
    queryKey: ['portfolio', 'dividend-projection'],
    queryFn: ({ signal }) => getPortfolioDividendProjection(signal),
    enabled: portfolioId !== null && privacyMode === 'normal',
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
  const startingNetWorthEur = portfolioQuery.data?.totals.totalValueEur ?? 0;
  const horizonYears = clamp(
    safeNumber(horizon, FORECAST_HORIZON_MIN_YEARS),
    FORECAST_HORIZON_MIN_YEARS,
    FORECAST_HORIZON_MAX_YEARS,
  );
  const enteredReturnPct = safeNumber(returnPct);
  const annualReturnPct = returnEnabled ? clampForecastReturnPct(enteredReturnPct) : 0;
  const returnPctIsClamped = returnEnabled && enteredReturnPct !== annualReturnPct;
  const standingOrders = ordersEnabled
    ? normalizeStandingOrders(ordersQuery.data?.orders ?? [])
    : [];
  const dividendAvailable = dividendQuery.data?.available === true;
  const monthlyDividendEur =
    dividendEnabled && dividendAvailable ? dividendQuery.data!.monthlyTotalEur : 0;

  const whatIfPlans: ForecastWhatIfPlan[] = plans.map((plan, index) => ({
    id: plan.id,
    label: plan.label.trim() || t('forecast.projection.whatIf.defaultLabel', { n: index + 1 }),
    monthlyContributionEur: safeNumber(plan.monthlyContribution),
    annualReturnPct: plan.ownReturn.trim() === '' ? null : safeNumber(plan.ownReturn),
  }));

  const result = useMemo(
    () =>
      projectNetWorth({
        asOf,
        startingNetWorthEur,
        horizonYears,
        annualReturnPct,
        standingOrders,
        monthlyDividendEur,
        whatIfPlans,
      }),
    [
      asOf,
      startingNetWorthEur,
      horizonYears,
      annualReturnPct,
      JSON.stringify(standingOrders),
      monthlyDividendEur,
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

  const finalBase = result.base[result.base.length - 1]?.value ?? startingNetWorthEur;

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
    <div className="bt-forecast-projection">
      <div className="bt-forecast-projection__intro">
        <p className="text-sm bt-muted">{t('forecast.projection.description')}</p>
        <AsyncReadState
          loading={prefillLoading}
          reads={prefillReads}
          errorLabel={t('forecast.prefill.error')}
          loadingLabel={t('forecast.prefill.loading')}
        />
      </div>

      {/* The money outcome leads; the plot and its assumptions stay attached below it. */}
      <StatStrip className="bt-forecast-projection__stats">
        <Stat
          label={t('forecast.projection.startingLabel')}
          value={formatMoney(startingNetWorthEur)}
        />
        <Stat
          label={t('forecast.projection.projectedLabel', { years: horizonYears })}
          value={
            <span
              className={
                isDiscreetMode()
                  ? undefined
                  : finalBase > startingNetWorthEur
                    ? 'bt-pos'
                    : finalBase < startingNetWorthEur
                      ? 'bt-neg'
                      : undefined
              }
            >
              {formatMoney(finalBase)}
            </span>
          }
        />
      </StatStrip>

      <div className="bt-forecast-projection__chart-wrap">
        <div
          role="img"
          aria-label={t('forecast.projection.chartAria')}
          className="bt-forecast-projection__chart"
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

        <ul className="bt-forecast-projection__legend">
          {legend.map((series) => (
            <li key={series.id} data-testid={`projection-series-${series.id}`}>
              <span
                aria-hidden="true"
                className="bt-forecast-projection__legend-line"
                style={{ backgroundColor: series.color }}
              />
              <span className="bt-soft">{series.label}</span>
              <span className="tabular-nums bt-muted">{formatMoney(series.value)}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* ── Factor controls ─────────────────────────────────────────────── */}
      <div className="bt-forecast-factors">
        <TextField
          type="number"
          inputMode="numeric"
          min={FORECAST_HORIZON_MIN_YEARS}
          max={FORECAST_HORIZON_MAX_YEARS}
          className="bt-forecast-factors__horizon"
          label={t('forecast.projection.horizonLabel')}
          hint={t('forecast.projection.horizonHint')}
          value={horizon}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setHorizon(e.target.value)}
        />

        <fieldset className="bt-forecast-factors__fieldset">
          <legend className="bt-label">{t('forecast.projection.factorsLegend')}</legend>

          <FactorToggle
            label={t('forecast.projection.factor.return')}
            checked={returnEnabled}
            onChange={setReturnEnabled}
          />
          {returnEnabled ? (
            <div className="bt-forecast-return-settings">
              <div className="bt-forecast-return-window">
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
                className="bt-forecast-return-rate"
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
          {dividendAvailable ? (
            <FactorToggle
              label={t('forecast.projection.factor.dividends')}
              checked={dividendEnabled}
              onChange={setDividendEnabled}
            />
          ) : null}
        </fieldset>
      </div>

      {/* ── What-if plans (local only) ──────────────────────────────────── */}
      <div className="bt-forecast-what-if">
        <div className="bt-forecast-what-if__head">
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
          <ul className="bt-forecast-plan-list">
            {plans.map((plan, index) => (
              <li key={plan.id} className="bt-forecast-plan-row">
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
                  className="bt-forecast-plan-row__amount"
                  label={t('forecast.projection.whatIf.monthlyLabel')}
                  value={plan.monthlyContribution}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    patchPlan(plan.id, { monthlyContribution: e.target.value })
                  }
                />
                <TextField
                  type="number"
                  inputMode="decimal"
                  className="bt-forecast-plan-row__return"
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
                  className="bt-forecast-plan-row__remove bt-muted"
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

/** A labelled checkbox factor toggle; the wrapping label is its accessible name. */
function FactorToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm bt-soft">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded"
        style={{ accentColor: 'var(--bt-gold-graphic)' }}
      />
      <span>{label}</span>
    </label>
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
