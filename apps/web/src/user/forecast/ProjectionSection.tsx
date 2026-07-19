import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { PortfolioSummary } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { getAnalyticsSeries } from '../../lib/analyticsApi';
import { cx } from '../../lib/cx';
import { formatMoney } from '../../lib/format';
import { getPortfolioDividendProjection } from '../../lib/marketIntelApi';
import { getPortfolio } from '../../lib/portfolioApi';
import { listStandingOrders } from '../../lib/standingOrdersApi';
import { EmptyState, StatCard } from '../../ui';
import { overlayColor } from '../../ui/charts';
import { Button, TextField } from '../components/ui';

import {
  FORECAST_HORIZON_MAX_YEARS,
  FORECAST_HORIZON_MIN_YEARS,
  normalizeStandingOrders,
  projectNetWorth,
  type ForecastWhatIfPlan,
} from './projection';

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

/** Base line colour — matches PriceChart's main sky line. */
const BASE_LINE = '#38bdf8';

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
    queryFn: ({ signal }) => getPortfolio(portfolioId!, signal),
    enabled: portfolioId !== null,
    staleTime: 60_000,
  });

  const analyticsQuery = useQuery({
    queryKey: ['analytics', portfolioId, 'series', { mode: 'value', window: returnWindow }],
    queryFn: ({ signal }) =>
      getAnalyticsSeries(portfolioId!, { mode: 'value', from: windowFrom }, signal),
    enabled: portfolioId !== null,
    staleTime: 60_000,
  });

  const ordersQuery = useQuery({
    queryKey: ['standingOrders', portfolioId],
    queryFn: ({ signal }) => listStandingOrders(portfolioId!, signal),
    enabled: portfolioId !== null,
    staleTime: 60_000,
  });

  const dividendQuery = useQuery({
    queryKey: ['portfolio', 'dividend-projection'],
    queryFn: ({ signal }) => getPortfolioDividendProjection(signal),
    staleTime: 60_000,
  });

  // The sampled historical return over the selected window (null when the series
  // is too short to state a CAGR); it drives the return field until edited.
  const sampledReturnPct = analyticsQuery.data?.primary.stats.cagrPct ?? null;
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
  const annualReturnPct = returnEnabled ? safeNumber(returnPct) : 0;
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
    <div className="flex flex-col gap-5 px-4 py-4">
      <p className="text-sm text-neutral-400">{t('forecast.projection.description')}</p>

      {/* ── Factor controls ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
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
          <legend className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
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
                <span className="text-xs text-neutral-500">
                  {t('forecast.projection.returnWindowLabel')}
                </span>
                <div
                  role="group"
                  aria-label={t('forecast.projection.returnWindowLabel')}
                  className="inline-flex gap-0.5 rounded-md bg-neutral-900 p-0.5 ring-1 ring-inset ring-neutral-800"
                >
                  {RETURN_WINDOWS.map((token) => {
                    const selected = token === returnWindow;
                    return (
                      <button
                        key={token}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setReturnWindow(token)}
                        className={cx(
                          'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                          'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
                          selected
                            ? 'bg-sky-600 text-white'
                            : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100',
                        )}
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
                className="sm:w-40"
                label={t('forecast.projection.returnPctLabel')}
                hint={t('forecast.projection.returnPctHint')}
                value={returnPct}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setReturnPct(e.target.value)}
              />
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

      {/* ── Chart + legend ──────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3">
        <div
          role="img"
          aria-label={t('forecast.projection.chartAria')}
          className="w-full"
          style={{ height: 320 }}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
              <CartesianGrid stroke="rgba(82, 82, 91, 0.25)" vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={(value: string) => value.slice(0, 4)}
                minTickGap={48}
                stroke="#a1a1aa"
                fontSize={12}
              />
              <YAxis width={64} tickFormatter={formatCompactEur} stroke="#a1a1aa" fontSize={12} />
              <Tooltip
                formatter={(value) => formatMoney(Number(value))}
                contentStyle={{
                  background: '#0b0e14',
                  border: '1px solid #3f3f46',
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Line
                type="monotone"
                dataKey="base"
                name={t('forecast.projection.baseLabel')}
                stroke={BASE_LINE}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
              {result.overlays.map((overlay, i) => (
                <Line
                  key={overlay.id}
                  type="monotone"
                  dataKey={overlay.id}
                  name={overlay.label}
                  stroke={overlayColor(i)}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  dot={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>

        <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
          {legend.map((series) => (
            <li
              key={series.id}
              data-testid={`projection-series-${series.id}`}
              className="flex items-center gap-1.5 text-xs text-neutral-400"
            >
              <span
                aria-hidden="true"
                className="inline-block h-0.5 w-4"
                style={{ backgroundColor: series.color }}
              />
              <span className="text-neutral-300">{series.label}</span>
              <span className="tabular-nums text-neutral-500">{formatMoney(series.value)}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* ── Headline stats ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <StatCard
          label={t('forecast.projection.startingLabel')}
          value={formatMoney(startingNetWorthEur)}
        />
        <StatCard
          label={t('forecast.projection.projectedLabel', { years: horizonYears })}
          value={formatMoney(finalBase)}
        />
      </div>

      {/* ── What-if plans (local only) ──────────────────────────────────── */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col">
            <h3 className="text-sm font-semibold text-neutral-200">
              {t('forecast.projection.whatIf.title')}
            </h3>
            <p className="text-xs text-neutral-500">
              {t('forecast.projection.whatIf.description')}
            </p>
          </div>
          <Button variant="secondary" onClick={addPlan} className="shrink-0">
            {t('forecast.projection.whatIf.add')}
          </Button>
        </div>

        {plans.length === 0 ? (
          <p className="text-xs text-neutral-500">{t('forecast.projection.whatIf.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {plans.map((plan, index) => (
              <li
                key={plan.id}
                className="grid grid-cols-1 gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 p-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end"
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
                  className="justify-self-start px-2 py-1 text-neutral-400 sm:justify-self-auto"
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
    <label className="flex items-center gap-2 text-sm text-neutral-200">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-neutral-600 bg-neutral-950 text-sky-500 focus:ring-sky-500"
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

/** The window start (ISO `YYYY-MM-DD`) for a sampling window, or undefined for `Max`. */
function windowStartIso(asOf: string, window: ReturnWindow): string | undefined {
  if (window === 'Max') return undefined;
  const years = window === '1Y' ? 1 : window === '3Y' ? 3 : 5;
  const date = new Date(`${asOf}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

/** Compact EUR axis tick, e.g. `€1.2M` / `€820k` — locale-agnostic and short. */
function formatCompactEur(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `€${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `€${Math.round(value / 1_000)}k`;
  return `€${Math.round(value)}`;
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
