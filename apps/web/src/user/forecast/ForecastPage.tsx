import { useMemo, useState, type ChangeEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useT, type TranslateFn } from '../../i18n';
import { getAnalyticsSeries } from '../../lib/analyticsApi';
import { cx } from '../../lib/cx';
import { formatMoney, formatPercent } from '../../lib/format';
import type { PortfolioSummary } from '@bettertrack/contracts';
import { StatCard } from '../../ui';
import { Alert, Button, Spinner, TextField } from '../components/ui';

import {
  clampForecastReturnPct,
  compoundInterest,
  dividendPlan,
  savingsPlanContribution,
  savingsPlanYears,
  withdrawalHorizon,
  withdrawalRate,
  FORECAST_CALC_MAX_YEARS,
  FORECAST_CALC_MIN_YEARS,
  FORECAST_RETURN_MAX_PCT,
  FORECAST_RETURN_MIN_PCT,
  type CompoundInterestInput,
  type DividendPlanInput,
  type SavingsContributionInput,
  type SavingsYearsInput,
  type WithdrawalHorizonInput,
  type WithdrawalRateInput,
} from './calc';
import { ProjectionSection } from './ProjectionSection';
import { StandingOrdersSection } from './StandingOrdersSection';
import { usePortfolioStore } from '../portfolio/PortfolioStoreProvider';
import { isVaultedPortfolio } from '../portfolio/lockedPortfolio';
import { clientSeriesTwrCagrPct } from '../vault/engine/clientSeries';
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
 *
 * §6.14 names FIVE calculator modes, not four: the savings plan also solves for
 * the years needed, and the withdrawal plan also solves for the sustainable
 * withdrawal rate. Those two are alternate SOLVE TARGETS of the two cards above
 * — same subject, inverted unknown — so they fold into their sibling card behind
 * a {@link SolveSwitch} rather than becoming a fifth and sixth top-level card,
 * which is what the anti-bloat rule (§13.5) requires of them.
 */

// ─── Prefill wiring ──────────────────────────────────────────────────────────

interface Prefill {
  /** The active portfolio's total value in EUR, headline `totalValueEur`. */
  portfolioValueEur: number | null;
  /**
   * Historical annualised TIME-WEIGHTED return of the active portfolio (%/yr)
   * over its inception window (#1759). Not the value curve's CAGR: that number
   * counts every deposit the user made as performance, and a calculator
   * prefilled with it compounds their own contributions forward as if they were
   * market growth. See {@link usePortfolioPrefill} for the per-mode source.
   */
  averageReturnPctPerYear: number | null;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Resolve the active portfolio (default one, or first available), then fetch
 * its headline value + inception return. The tab never blocks on this — cards
 * degrade to their standalone inputs when the fetch is missing or a field is
 * `null`.
 *
 * The prefilled return is the portfolio's TIME-WEIGHTED return in both account
 * modes (#1759) — the same net-worth curve the projection starts from, measured
 * so that the user's own deposits are not read back as performance. It has one
 * source per mode:
 *
 * - **normal** — `analytics/…/series` `twr`, which the server derives from the
 *   §6.9 overview curve. It replaced `primary.stats.cagrPct`, the CAGR of the
 *   holdings VALUE series: every buy lifted that curve, so a monthly saver was
 *   prefilled with a rate made mostly of their own money.
 * - **paranoid** — there is no analytics endpoint, so the decrypted vault's own
 *   performance curve (`getPortfolioHistory().performance`, server-parity TWR)
 *   answers the same question locally.
 *
 * Both are net-worth figures, so idle cash damps them; that matches the
 * projection, whose starting value is net worth too (docs/paranoid-design.md §8).
 */
function usePortfolioPrefill(): {
  prefill: Prefill;
  isLoading: boolean;
  isError: boolean;
  portfolioListLoading: boolean;
  portfolioListError: boolean;
  portfolios: PortfolioSummary[];
  retryPortfolioList: () => void;
  retry: () => void;
} {
  const store = usePortfolioStore();
  const paranoid = useResolvedPrivacyMode() === 'paranoid';
  const portfoliosQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => store.listPortfolios(signal),
    staleTime: 60_000,
  });
  const portfolios = (portfoliosQuery.data?.portfolios ?? []).filter(
    (portfolio) => !isVaultedPortfolio(portfolio),
  );
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
  // The vault's own since-inception TWR — the local answer to the question the
  // server's `twr` block answers for a normal account.
  const historyTwr =
    historyQuery.data == null ? null : clientSeriesTwrCagrPct(historyQuery.data.performance);

  const modeQuery = paranoid ? historyQuery : analyticsQuery;
  return {
    prefill: {
      portfolioValueEur: portfolioQuery.data?.totals.totalValueEur ?? null,
      averageReturnPctPerYear: paranoid
        ? historyTwr == null
          ? null
          : round2(historyTwr)
        : (analyticsQuery.data?.twr?.cagrPct ?? null),
    },
    isLoading: portfoliosQuery.isLoading || portfolioQuery.isLoading || modeQuery.isLoading,
    isError: portfoliosQuery.isError || portfolioQuery.isError || modeQuery.isError,
    portfolioListLoading: portfoliosQuery.isLoading,
    portfolioListError: portfoliosQuery.isError,
    portfolios,
    retryPortfolioList: () => {
      void portfoliosQuery.refetch();
    },
    retry: () => {
      if (portfolioId !== null) {
        void portfolioQuery.refetch();
        void modeQuery.refetch();
      }
    },
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

// ─── Solve-target switch ─────────────────────────────────────────────────────

interface SolveSwitchProps<T extends string> {
  /** Group label — what the two buttons choose between. */
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (next: T) => void;
}

/**
 * Picks which unknown a card solves for. The same `bt-seg` segmented control the
 * standing-order dialog uses, so a second calculator mode costs one row inside
 * the card it belongs to instead of another card in the tab.
 */
function SolveSwitch<T extends string>({ label, value, options, onChange }: SolveSwitchProps<T>) {
  return (
    <div className="bt-seg mb-3" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={option.value === value}
          className={cx(
            'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition',
            option.value === value ? 'is-active' : 'bt-muted hover:bt-soft',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// ─── Rate field ──────────────────────────────────────────────────────────────

interface RateFieldProps {
  t: TranslateFn;
  label: string;
  value: string;
  onChange: (next: string) => void;
}

/**
 * Every percent-per-year field in the suite, held to the one bound the whole
 * Forecast tab uses ({@link clampForecastReturnPct}). The `min`/`max` attributes
 * only tell the browser; these are bare number inputs outside any form, so a
 * typed or pasted `-2000` reaches state verbatim and the MATH is what clamps it
 * (each solver in `./calc` does that itself). The notice mirrors the
 * projection's own clamp alert — a card that silently answers a different
 * question than the one typed is the defect, not the bounded answer.
 */
function RateField({ t, label, value, onChange }: RateFieldProps) {
  const entered = safeNumber(value);
  const isClamped = entered !== clampForecastReturnPct(entered);
  return (
    <div className="flex flex-col gap-1">
      <TextField
        type="number"
        inputMode="decimal"
        min={FORECAST_RETURN_MIN_PCT}
        max={FORECAST_RETURN_MAX_PCT}
        step="any"
        label={label}
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      />
      {isClamped ? (
        <p role="alert" className="text-xs bt-gold-note">
          {t('forecast.calculators.ratePctClamped')}
        </p>
      ) : null}
    </div>
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
    years: clampYears(years),
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
        <RateField
          t={t}
          label={t('forecast.compound.ratePct')}
          value={ratePctPerYear}
          onChange={setRatePctPerYear}
        />
        <TextField
          type="number"
          inputMode="decimal"
          min={FORECAST_CALC_MIN_YEARS}
          max={FORECAST_CALC_MAX_YEARS}
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

// ─── Savings plan card (solve for monthly contribution, or for years) ────────

/** Which unknown the savings card solves for — §6.14's two savings-plan modes. */
type SavingsSolveTarget = 'contribution' | 'years';

function SavingsPlanCard({ prefill, t }: { prefill: Prefill; t: TranslateFn }) {
  const [solveFor, setSolveFor] = useState<SavingsSolveTarget>('contribution');
  const [target, setTarget] = useState('100000');
  const [principal, setPrincipal] = useState('10000');
  const [monthlyContribution, setMonthlyContribution] = useState('500');
  const [ratePctPerYear, setRatePctPerYear] = useState('5');
  const [years, setYears] = useState('15');
  const [compoundingPerYear, setCompoundingPerYear] = useState('12');

  const solvingYears = solveFor === 'years';
  const shared = {
    target: safeNumber(target),
    principal: safeNumber(principal),
    ratePctPerYear: safeNumber(ratePctPerYear),
    compoundingPerYear: Math.max(1, safeNumber(compoundingPerYear, 12)),
  };
  // Only the active target is solved: the two modes take a different unknown
  // (years in, contribution out — or the reverse), so the idle branch's input
  // field is not even rendered.
  const contributionInput: SavingsContributionInput = { ...shared, years: safeNumber(years) };
  const yearsInput: SavingsYearsInput = {
    ...shared,
    monthlyContribution: safeNumber(monthlyContribution),
  };
  const contributionResult = solvingYears ? null : savingsPlanContribution(contributionInput);
  const yearsResult = solvingYears ? savingsPlanYears(yearsInput) : null;
  const feasible = solvingYears ? yearsResult!.feasible : contributionResult!.feasible;
  // An unreachable target is a real answer, not a missing one: it says so in
  // words rather than degrading to a blank or an em-dash (`savingsPlanYears`
  // returns `{ years: null }` there, and `formatMoney`-style fallbacks would
  // read as "we could not compute this").
  const yearsValue =
    yearsResult === null
      ? null
      : yearsResult.years === null || !Number.isFinite(yearsResult.years)
        ? t('forecast.savings.notReachable')
        : t('forecast.savings.yearsValue', {
            years: Math.max(0, Math.round(yearsResult.years * 10) / 10),
          });
  const canPrefill = prefill.portfolioValueEur !== null || prefill.averageReturnPctPerYear !== null;

  return (
    <>
      <SolveSwitch
        label={t('forecast.savings.solve.label')}
        value={solveFor}
        onChange={setSolveFor}
        options={[
          { value: 'contribution', label: t('forecast.savings.solve.contribution') },
          { value: 'years', label: t('forecast.savings.solve.years') },
        ]}
      />
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
        <RateField
          t={t}
          label={t('forecast.savings.ratePct')}
          value={ratePctPerYear}
          onChange={setRatePctPerYear}
        />
        {solvingYears ? (
          <TextField
            type="number"
            inputMode="decimal"
            label={t('forecast.savings.monthlyContributionInput')}
            value={monthlyContribution}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setMonthlyContribution(e.target.value)}
          />
        ) : (
          <TextField
            type="number"
            inputMode="decimal"
            label={t('forecast.savings.years')}
            value={years}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setYears(e.target.value)}
          />
        )}
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
        {solvingYears ? (
          <StatCard label={t('forecast.savings.yearsNeeded')} value={yearsValue!} />
        ) : (
          <StatCard
            label={t('forecast.savings.monthlyContribution')}
            value={formatMoney(contributionResult!.monthlyContribution)}
          />
        )}
        <StatCard
          label={t('forecast.savings.feasible')}
          value={feasible ? t('common.yes') : t('common.no')}
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
    years: clampYears(years),
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
        <RateField
          t={t}
          label={t('forecast.dividend.yieldPct')}
          value={yieldPctPerYear}
          onChange={setYieldPctPerYear}
        />
        <RateField
          t={t}
          label={t('forecast.dividend.growthPct')}
          value={growthPctPerYear}
          onChange={setGrowthPctPerYear}
        />
        <TextField
          type="number"
          inputMode="decimal"
          min={FORECAST_CALC_MIN_YEARS}
          max={FORECAST_CALC_MAX_YEARS}
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

/** Which unknown the withdrawal card solves for — §6.14's two withdrawal modes. */
type WithdrawalSolveTarget = 'horizon' | 'rate';

function WithdrawalPlanCard({ prefill, t }: { prefill: Prefill; t: TranslateFn }) {
  const [solveFor, setSolveFor] = useState<WithdrawalSolveTarget>('horizon');
  const [balance, setBalance] = useState('100000');
  const [monthlyWithdrawal, setMonthlyWithdrawal] = useState('500');
  const [horizonYears, setHorizonYears] = useState('20');
  const [annualReturnPct, setAnnualReturnPct] = useState('5');

  const solvingRate = solveFor === 'rate';
  const horizonInput: WithdrawalHorizonInput = {
    balance: safeNumber(balance),
    monthlyWithdrawal: safeNumber(monthlyWithdrawal),
    annualReturnPct: safeNumber(annualReturnPct),
  };
  // The horizon is collected in YEARS and handed over in months, so it takes the
  // one `clampYears` bound the rest of the suite uses rather than a second
  // months-shaped idiom. The bound is also what keeps the answer a number: the
  // annuity factor is `(1 + rm)^N`, which overflows to `Infinity` — and then to
  // `Infinity/Infinity = NaN` — for an unbounded horizon at a positive rate.
  const rateInput: WithdrawalRateInput = {
    balance: safeNumber(balance),
    months: clampYears(horizonYears) * 12,
    annualReturnPct: safeNumber(annualReturnPct),
  };
  const result = solvingRate ? null : withdrawalHorizon(horizonInput);
  const rateResult = solvingRate ? withdrawalRate(rateInput) : null;
  const canPrefill = prefill.portfolioValueEur !== null || prefill.averageReturnPctPerYear !== null;

  // A non-finite horizon is treated exactly like `null`. The card interpolates
  // its months into copy rather than routing them through `formatMoney`, so a
  // `NaN` that slipped past this guard would render as the literal "NaN months"
  // — the one place in the suite where a bad figure is not even an em-dash.
  const horizonValue =
    result === null
      ? null
      : result.sustainable
        ? t('forecast.withdrawal.sustainable')
        : result.months === null || !Number.isFinite(result.months)
          ? t('forecast.withdrawal.notComputable')
          : t('forecast.withdrawal.monthsValue', {
              months: Math.max(0, Math.round(result.months * 10) / 10),
              years: Math.max(0, Math.round((result.months / 12) * 10) / 10),
            });

  return (
    <>
      <SolveSwitch
        label={t('forecast.withdrawal.solve.label')}
        value={solveFor}
        onChange={setSolveFor}
        options={[
          { value: 'horizon', label: t('forecast.withdrawal.solve.horizon') },
          { value: 'rate', label: t('forecast.withdrawal.solve.rate') },
        ]}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField
          type="number"
          inputMode="decimal"
          label={t('forecast.withdrawal.balance')}
          value={balance}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setBalance(e.target.value)}
        />
        {solvingRate ? (
          <TextField
            type="number"
            inputMode="decimal"
            min={FORECAST_CALC_MIN_YEARS}
            max={FORECAST_CALC_MAX_YEARS}
            label={t('forecast.withdrawal.horizonYears')}
            value={horizonYears}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setHorizonYears(e.target.value)}
          />
        ) : (
          <TextField
            type="number"
            inputMode="decimal"
            label={t('forecast.withdrawal.monthlyWithdrawal')}
            value={monthlyWithdrawal}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setMonthlyWithdrawal(e.target.value)}
          />
        )}
        <RateField
          t={t}
          label={t('forecast.withdrawal.annualReturnPct')}
          value={annualReturnPct}
          onChange={setAnnualReturnPct}
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
        {solvingRate ? (
          <StatCard
            label={t('forecast.withdrawal.rateLabel')}
            value={formatMoney(rateResult!.monthlyWithdrawal)}
          />
        ) : (
          <>
            <StatCard label={t('forecast.withdrawal.horizonLabel')} value={horizonValue!} />
            <StatCard
              label={t('forecast.withdrawal.statusLabel')}
              value={
                result!.sustainable
                  ? t('forecast.withdrawal.statusSustainable')
                  : t('forecast.withdrawal.statusDepletes')
              }
            />
          </>
        )}
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
  const {
    prefill,
    portfolios,
    isLoading: prefillLoading,
    isError: prefillError,
    portfolioListLoading,
    portfolioListError,
    retryPortfolioList,
    retry: retryPrefill,
  } = usePortfolioPrefill();

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('forecast.title')}</h1>
        <p className="text-sm bt-muted">{t('forecast.subtitle')}</p>
      </header>

      {portfolioListLoading && !portfolioListError ? (
        <div className="bt-panel bt-panel--soft p-4">
          <Spinner label={t('forecast.prefill.loading')} />
        </div>
      ) : portfolioListError ? (
        <div className="flex flex-col items-start gap-3">
          <Alert tone="error">{t('forecast.prefill.error')}</Alert>
          <Button onClick={retryPortfolioList}>{t('common.retry')}</Button>
        </div>
      ) : (
        <>
          <section
            aria-labelledby="forecast-projection-heading"
            className="bt-panel bt-panel--soft"
          >
            <div className="bt-b-rule px-4 py-3">
              <h2 id="forecast-projection-heading" className="text-sm font-semibold bt-soft">
                {t('forecast.projection.title')}
              </h2>
            </div>
            <ProjectionSection portfolios={portfolios} />
          </section>

          <StandingOrdersSection portfolios={portfolios} />
        </>
      )}

      <section aria-labelledby="forecast-calculators-heading" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="forecast-calculators-heading" className="text-sm font-semibold bt-soft">
            {t('forecast.calculators.title')}
          </h2>
          <p className="text-xs bt-muted">{t('forecast.calculators.description')}</p>
        </div>
        {!portfolioListLoading && !portfolioListError && prefillLoading && !prefillError ? (
          <div className="bt-panel bt-panel--soft p-4">
            <Spinner label={t('forecast.prefill.loading')} />
          </div>
        ) : !portfolioListError && prefillError ? (
          <div className="flex flex-col items-start gap-3">
            <Alert tone="error">{t('forecast.prefill.error')}</Alert>
            <Button onClick={retryPrefill}>{t('common.retry')}</Button>
          </div>
        ) : !prefillLoading &&
          !prefillError &&
          prefill.portfolioValueEur === null &&
          prefill.averageReturnPctPerYear === null ? (
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

/**
 * Bound a raw "Years" field to the calculator horizon range — the same
 * parse-then-clamp the projection horizon does at its own boundary. The fields
 * are bare number inputs outside any form, so their `min`/`max` never validate
 * anything on their own and a pasted `1000000000` would otherwise reach the
 * math verbatim.
 */
function clampYears(raw: string): number {
  return Math.max(FORECAST_CALC_MIN_YEARS, Math.min(FORECAST_CALC_MAX_YEARS, safeNumber(raw)));
}
