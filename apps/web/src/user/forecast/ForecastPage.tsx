import { useMemo, useState, type ChangeEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useT, type TranslateFn } from '../../i18n';
import { getAnalyticsSeries } from '../../lib/analyticsApi';
import { cx } from '../../lib/cx';
import { formatMoney, formatPercent } from '../../lib/format';
import type { PortfolioSummary } from '@bettertrack/contracts';
import { computeSeriesStats } from '@bettertrack/domain/seriesStats';
import { StatCard } from '../../ui';
import { Alert, Button, TextField } from '../components/ui';

import {
  compoundInterest,
  dividendPlan,
  savingsPlanContribution,
  withdrawalHorizon,
  type CompoundInterestInput,
  type DividendPlanInput,
  type SavingsContributionInput,
  type WithdrawalHorizonInput,
} from './calc';
import { ProjectionSection } from './ProjectionSection';
import { StandingOrdersSection } from './StandingOrdersSection';
import { usePortfolioStore } from '../portfolio/PortfolioStoreProvider';
import { useResolvedPrivacyMode } from '../vault/usePrivacyMode';

/**
 * Forecast tab (PROJECTPLAN.md §13.5 V5-P6b arc (c)). Two zones live in the
 * page:
 *   1. The net-worth projection view (arc (b), issue #596): a deterministic
 *      client-side projection with per-factor toggles and local what-if
 *      overlays ({@link ProjectionSection}).
 *   2. A compact calculator suite: compound-interest, savings-plan,
 *      dividend/yield, withdrawal-plan — each collapsed by default per the
 *      anti-bloat rule, each standalone AND pre-fillable from the current
 *      portfolio (value + historical average return). The tab shell owns the
 *      one prefill fetch; each card reads the resolved `prefill` view.
 */

// ─── Prefill wiring ──────────────────────────────────────────────────────────

interface Prefill {
  /** The active portfolio's total value in EUR, headline `totalValueEur`. */
  portfolioValueEur: number | null;
  /**
   * Historical CAGR of the active portfolio (%/yr) — inception-window, `perf`
   * mode. Normal accounts read the server's analytics `primary` series (the
   * holdings-only sum); see {@link usePortfolioPrefill} for the paranoid
   * substitute and why it is a different series.
   */
  averageReturnPctPerYear: number | null;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Resolve the active portfolio (default one, or first available), then fetch
 * its headline value + inception CAGR. The tab never blocks on this — cards
 * degrade to their standalone inputs when the fetch is missing or a field is
 * `null`.
 *
 * The prefilled return has ONE source per account mode, and they are not the
 * same series:
 *
 * - **normal** — `analytics/…/series` `primary.stats.cagrPct`, i.e. the
 *   server's `getAssetValueSeries` summed over the visible assets: HOLDINGS
 *   only. This is the number the tab has always prefilled, so it stays exactly
 *   that (same endpoint, same query key, unrounded) rather than becoming a
 *   net-worth CAGR because the store happens to expose history.
 * - **paranoid** — there is no analytics endpoint (and the client engine
 *   derives no per-asset series), so the only value curve a decrypted vault can
 *   state is its NET-WORTH series (`getPortfolioHistory` = holdings + cash).
 *   Idle cash therefore damps this figure relative to the normal one; it is a
 *   starting point the user edits, and the projection's starting value is a
 *   net-worth figure too (see docs/paranoid-design.md §8).
 */
function usePortfolioPrefill(): {
  prefill: Prefill;
  isLoading: boolean;
  portfolios: PortfolioSummary[];
} {
  const store = usePortfolioStore();
  const paranoid = useResolvedPrivacyMode() === 'paranoid';
  const portfoliosQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => store.listPortfolios(signal),
    staleTime: 60_000,
  });
  const portfolios = portfoliosQuery.data?.portfolios ?? [];
  const portfolioId = useMemo(() => {
    return (portfolios.find((p) => p.isDefault) ?? portfolios[0])?.id ?? null;
  }, [portfolios]);

  const portfolioQuery = useQuery({
    queryKey: ['portfolio', portfolioId],
    queryFn: ({ signal }) => store.getPortfolio(portfolioId!, signal),
    enabled: portfolioId !== null,
    staleTime: 60_000,
  });

  const analyticsQuery = useQuery({
    queryKey: ['analytics', portfolioId, 'series', { mode: 'perf' }],
    queryFn: ({ signal }) => getAnalyticsSeries(portfolioId!, { mode: 'perf' }, signal),
    enabled: portfolioId !== null && !paranoid,
    staleTime: 60_000,
  });

  const historyQuery = useQuery({
    queryKey: ['portfolio', portfolioId, 'history', 'MAX', false],
    queryFn: ({ signal }) => store.getPortfolioHistory(portfolioId!, 'MAX', false, signal),
    enabled: portfolioId !== null && paranoid,
    staleTime: 60_000,
  });
  const historyCagr =
    historyQuery.data == null
      ? null
      : computeSeriesStats(
          historyQuery.data.points.map((point) => ({
            date: point.date,
            value: point.valueEur,
          })),
        ).cagrPct;

  const modeQuery = paranoid ? historyQuery : analyticsQuery;
  return {
    prefill: {
      portfolioValueEur: portfolioQuery.data?.totals.totalValueEur ?? null,
      averageReturnPctPerYear: paranoid
        ? historyCagr == null
          ? null
          : round2(historyCagr)
        : (analyticsQuery.data?.primary.stats.cagrPct ?? null),
    },
    isLoading: portfoliosQuery.isLoading || portfolioQuery.isLoading || modeQuery.isLoading,
    portfolios,
  };
}

// ─── Collapsible calculator card ─────────────────────────────────────────────

interface CalculatorCardProps {
  id: string;
  title: string;
  summary: string;
  children: ReactNode;
}

/**
 * Compact wrapper: a headed toggle row + a body region rendered only when
 * expanded. Collapsed by default (anti-bloat) — `aria-expanded` and
 * `aria-controls` wire the button to the region for screen readers, and the
 * region carries a stable `id` for test targeting.
 */
function CalculatorCard({ id, title, summary, children }: CalculatorCardProps) {
  const [open, setOpen] = useState(false);
  const regionId = `${id}-region`;
  return (
    <section className="bt-panel">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((prev) => !prev)}
        className={cx(
          'flex w-full items-center justify-between gap-3 rounded-lg px-4 py-3 text-left',
          'transition-colors ',
          '',
        )}
      >
        <span className="flex flex-col">
          <span className="text-sm font-semibold">{title}</span>
          <span className="text-xs bt-muted">{summary}</span>
        </span>
        <span aria-hidden="true" className="bt-muted">
          {open ? '−' : '+'}
        </span>
      </button>
      {open ? (
        <div id={regionId} className="bt-t-rule px-4 py-4">
          {children}
        </div>
      ) : null}
    </section>
  );
}

// ─── Prefill button ──────────────────────────────────────────────────────────

interface PrefillButtonProps {
  label: string;
  disabled: boolean;
  onClick: () => void;
}

function PrefillButton({ label, disabled, onClick }: PrefillButtonProps) {
  return (
    <Button variant="ghost" onClick={onClick} disabled={disabled} className="bt-btn--sm self-start">
      {label}
    </Button>
  );
}

// ─── Compound interest card ──────────────────────────────────────────────────

function CompoundInterestCard({ prefill, t }: { prefill: Prefill; t: TranslateFn }) {
  const [principal, setPrincipal] = useState('10000');
  const [monthlyContribution, setMonthlyContribution] = useState('250');
  const [ratePctPerYear, setRatePctPerYear] = useState('5');
  const [years, setYears] = useState('20');
  const [compoundingPerYear, setCompoundingPerYear] = useState('12');

  const input: CompoundInterestInput = {
    principal: safeNumber(principal),
    monthlyContribution: safeNumber(monthlyContribution),
    ratePctPerYear: safeNumber(ratePctPerYear),
    years: safeNumber(years),
    compoundingPerYear: Math.max(1, safeNumber(compoundingPerYear, 12)),
  };
  const result = compoundInterest(input);
  const canPrefill = prefill.portfolioValueEur !== null || prefill.averageReturnPctPerYear !== null;

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField
          type="number"
          inputMode="decimal"
          label={t('forecast.compound.principal')}
          value={principal}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setPrincipal(e.target.value)}
        />
        <TextField
          type="number"
          inputMode="decimal"
          label={t('forecast.compound.monthlyContribution')}
          value={monthlyContribution}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setMonthlyContribution(e.target.value)}
        />
        <TextField
          type="number"
          inputMode="decimal"
          label={t('forecast.compound.ratePct')}
          value={ratePctPerYear}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setRatePctPerYear(e.target.value)}
        />
        <TextField
          type="number"
          inputMode="decimal"
          label={t('forecast.compound.years')}
          value={years}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setYears(e.target.value)}
        />
        <TextField
          type="number"
          inputMode="decimal"
          label={t('forecast.compound.compoundingPerYear')}
          hint={t('forecast.compound.compoundingHint')}
          value={compoundingPerYear}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setCompoundingPerYear(e.target.value)}
        />
      </div>
      <PrefillButton
        label={t('forecast.prefillFromPortfolio')}
        disabled={!canPrefill}
        onClick={() => {
          if (prefill.portfolioValueEur !== null) {
            setPrincipal(String(prefill.portfolioValueEur));
          }
          if (prefill.averageReturnPctPerYear !== null) {
            setRatePctPerYear(String(prefill.averageReturnPctPerYear));
          }
        }}
      />
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          label={t('forecast.compound.finalBalance')}
          value={formatMoney(result.finalBalance)}
        />
        <StatCard
          label={t('forecast.compound.totalContributions')}
          value={formatMoney(result.totalContributions)}
        />
        <StatCard
          label={t('forecast.compound.totalInterest')}
          value={formatMoney(result.totalInterest)}
        />
      </div>
    </>
  );
}

// ─── Savings plan card (solve for monthly contribution) ──────────────────────

function SavingsPlanCard({ prefill, t }: { prefill: Prefill; t: TranslateFn }) {
  const [target, setTarget] = useState('100000');
  const [principal, setPrincipal] = useState('10000');
  const [ratePctPerYear, setRatePctPerYear] = useState('5');
  const [years, setYears] = useState('15');
  const [compoundingPerYear, setCompoundingPerYear] = useState('12');

  const input: SavingsContributionInput = {
    target: safeNumber(target),
    principal: safeNumber(principal),
    ratePctPerYear: safeNumber(ratePctPerYear),
    years: safeNumber(years),
    compoundingPerYear: Math.max(1, safeNumber(compoundingPerYear, 12)),
  };
  const result = savingsPlanContribution(input);
  const canPrefill = prefill.portfolioValueEur !== null || prefill.averageReturnPctPerYear !== null;

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField
          type="number"
          inputMode="decimal"
          label={t('forecast.savings.target')}
          value={target}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setTarget(e.target.value)}
        />
        <TextField
          type="number"
          inputMode="decimal"
          label={t('forecast.savings.principal')}
          value={principal}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setPrincipal(e.target.value)}
        />
        <TextField
          type="number"
          inputMode="decimal"
          label={t('forecast.savings.ratePct')}
          value={ratePctPerYear}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setRatePctPerYear(e.target.value)}
        />
        <TextField
          type="number"
          inputMode="decimal"
          label={t('forecast.savings.years')}
          value={years}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setYears(e.target.value)}
        />
        <TextField
          type="number"
          inputMode="decimal"
          label={t('forecast.savings.compoundingPerYear')}
          hint={t('forecast.savings.compoundingHint')}
          value={compoundingPerYear}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setCompoundingPerYear(e.target.value)}
        />
      </div>
      <PrefillButton
        label={t('forecast.prefillFromPortfolio')}
        disabled={!canPrefill}
        onClick={() => {
          if (prefill.portfolioValueEur !== null) {
            setPrincipal(String(prefill.portfolioValueEur));
          }
          if (prefill.averageReturnPctPerYear !== null) {
            setRatePctPerYear(String(prefill.averageReturnPctPerYear));
          }
        }}
      />
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <StatCard
          label={t('forecast.savings.monthlyContribution')}
          value={formatMoney(result.monthlyContribution)}
        />
        <StatCard
          label={t('forecast.savings.feasible')}
          value={result.feasible ? t('common.yes') : t('common.no')}
        />
      </div>
    </>
  );
}

// ─── Dividend / yield card ───────────────────────────────────────────────────

function DividendCard({ prefill, t }: { prefill: Prefill; t: TranslateFn }) {
  const [positionValue, setPositionValue] = useState('10000');
  const [yieldPctPerYear, setYieldPctPerYear] = useState('3');
  const [growthPctPerYear, setGrowthPctPerYear] = useState('5');
  const [years, setYears] = useState('10');

  const input: DividendPlanInput = {
    positionValue: safeNumber(positionValue),
    yieldPctPerYear: safeNumber(yieldPctPerYear),
    growthPctPerYear: safeNumber(growthPctPerYear),
    years: safeNumber(years),
  };
  const result = dividendPlan(input);
  const canPrefill = prefill.portfolioValueEur !== null;

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField
          type="number"
          inputMode="decimal"
          label={t('forecast.dividend.positionValue')}
          value={positionValue}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setPositionValue(e.target.value)}
        />
        <TextField
          type="number"
          inputMode="decimal"
          label={t('forecast.dividend.yieldPct')}
          value={yieldPctPerYear}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setYieldPctPerYear(e.target.value)}
        />
        <TextField
          type="number"
          inputMode="decimal"
          label={t('forecast.dividend.growthPct')}
          value={growthPctPerYear}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setGrowthPctPerYear(e.target.value)}
        />
        <TextField
          type="number"
          inputMode="decimal"
          label={t('forecast.dividend.years')}
          value={years}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setYears(e.target.value)}
        />
      </div>
      <PrefillButton
        label={t('forecast.prefillFromPortfolio')}
        disabled={!canPrefill}
        onClick={() => {
          if (prefill.portfolioValueEur !== null) {
            setPositionValue(String(prefill.portfolioValueEur));
          }
        }}
      />
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          label={t('forecast.dividend.totalDividends')}
          value={formatMoney(result.totalDividends)}
        />
        <StatCard
          label={t('forecast.dividend.firstYear')}
          value={formatMoney(result.yearlyDividends[0] ?? 0)}
        />
        <StatCard
          label={t('forecast.dividend.yieldOnCostFinal')}
          value={formatPercent(result.yieldOnCostFinalPct)}
        />
      </div>
    </>
  );
}

// ─── Withdrawal plan card ────────────────────────────────────────────────────

function WithdrawalPlanCard({ prefill, t }: { prefill: Prefill; t: TranslateFn }) {
  const [balance, setBalance] = useState('100000');
  const [monthlyWithdrawal, setMonthlyWithdrawal] = useState('500');
  const [annualReturnPct, setAnnualReturnPct] = useState('5');

  const input: WithdrawalHorizonInput = {
    balance: safeNumber(balance),
    monthlyWithdrawal: safeNumber(monthlyWithdrawal),
    annualReturnPct: safeNumber(annualReturnPct),
  };
  const result = withdrawalHorizon(input);
  const canPrefill = prefill.portfolioValueEur !== null || prefill.averageReturnPctPerYear !== null;

  const horizonValue = result.sustainable
    ? t('forecast.withdrawal.sustainable')
    : result.months === null
      ? t('forecast.withdrawal.notComputable')
      : t('forecast.withdrawal.monthsValue', {
          months: Math.max(0, Math.round(result.months * 10) / 10),
          years: Math.max(0, Math.round((result.months / 12) * 10) / 10),
        });

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField
          type="number"
          inputMode="decimal"
          label={t('forecast.withdrawal.balance')}
          value={balance}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setBalance(e.target.value)}
        />
        <TextField
          type="number"
          inputMode="decimal"
          label={t('forecast.withdrawal.monthlyWithdrawal')}
          value={monthlyWithdrawal}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setMonthlyWithdrawal(e.target.value)}
        />
        <TextField
          type="number"
          inputMode="decimal"
          label={t('forecast.withdrawal.annualReturnPct')}
          value={annualReturnPct}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setAnnualReturnPct(e.target.value)}
        />
      </div>
      <PrefillButton
        label={t('forecast.prefillFromPortfolio')}
        disabled={!canPrefill}
        onClick={() => {
          if (prefill.portfolioValueEur !== null) {
            setBalance(String(prefill.portfolioValueEur));
          }
          if (prefill.averageReturnPctPerYear !== null) {
            setAnnualReturnPct(String(prefill.averageReturnPctPerYear));
          }
        }}
      />
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <StatCard label={t('forecast.withdrawal.horizonLabel')} value={horizonValue} />
        <StatCard
          label={t('forecast.withdrawal.statusLabel')}
          value={
            result.sustainable
              ? t('forecast.withdrawal.statusSustainable')
              : t('forecast.withdrawal.statusDepletes')
          }
        />
      </div>
    </>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

/**
 * `/workbench/forecasts` route (V5-P6b arc (c)). Renders the projection-view slot, then
 * the compact calculator suite. The projection engine + what-if plans land in
 * a sibling issue and replace the empty state here.
 */
export function ForecastPage() {
  const t = useT();
  const { prefill, portfolios } = usePortfolioPrefill();

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('forecast.title')}</h1>
        <p className="text-sm bt-muted">{t('forecast.subtitle')}</p>
      </header>

      <section aria-labelledby="forecast-projection-heading" className="bt-panel bt-panel--soft">
        <div className="bt-b-rule px-4 py-3">
          <h2 id="forecast-projection-heading" className="text-sm font-semibold bt-soft">
            {t('forecast.projection.title')}
          </h2>
        </div>
        <ProjectionSection portfolios={portfolios} />
      </section>

      <StandingOrdersSection portfolios={portfolios} />

      <section aria-labelledby="forecast-calculators-heading" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="forecast-calculators-heading" className="text-sm font-semibold bt-soft">
            {t('forecast.calculators.title')}
          </h2>
          <p className="text-xs bt-muted">{t('forecast.calculators.description')}</p>
        </div>
        {prefill.portfolioValueEur === null && prefill.averageReturnPctPerYear === null ? (
          <Alert tone="info">{t('forecast.calculators.prefillUnavailable')}</Alert>
        ) : null}
        <CalculatorCard
          id="forecast-compound"
          title={t('forecast.compound.title')}
          summary={t('forecast.compound.summary')}
        >
          <CompoundInterestCard prefill={prefill} t={t} />
        </CalculatorCard>
        <CalculatorCard
          id="forecast-savings"
          title={t('forecast.savings.title')}
          summary={t('forecast.savings.summary')}
        >
          <SavingsPlanCard prefill={prefill} t={t} />
        </CalculatorCard>
        <CalculatorCard
          id="forecast-dividend"
          title={t('forecast.dividend.title')}
          summary={t('forecast.dividend.summary')}
        >
          <DividendCard prefill={prefill} t={t} />
        </CalculatorCard>
        <CalculatorCard
          id="forecast-withdrawal"
          title={t('forecast.withdrawal.title')}
          summary={t('forecast.withdrawal.summary')}
        >
          <WithdrawalPlanCard prefill={prefill} t={t} />
        </CalculatorCard>
      </section>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parse a raw input string into a finite number, falling back to `fallback` (default 0). */
function safeNumber(raw: string, fallback = 0): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
