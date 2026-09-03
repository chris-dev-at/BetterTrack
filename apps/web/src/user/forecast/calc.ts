/**
 * Pure, side-effect-free math for the four Forecast calculators (PROJECTPLAN.md
 * §13.5 V5-P6b arc (c)). Every function is a total map from typed inputs to a
 * result object and does no I/O — the UI wires them to inputs, the tests pin
 * them to hand-computed fixtures.
 *
 * Conventions across the module:
 *   • Rates are entered as percent-per-year (`5` → 5 %/yr), never as fractions.
 *   • Time inputs are in years for accumulation calculators and in months for
 *     withdrawal calculators (the shape the UI collects them in).
 *   • Contributions accumulate as an **ordinary annuity** — one contribution at
 *     the END of each compounding period. A monthly contribution paired with
 *     yearly compounding rolls up to 12× the monthly figure per period, so the
 *     total contribution over a year stays honest regardless of the compounding
 *     knob.
 *   • Callers pass numbers; validation lives at the UI boundary. The functions
 *     defend only against the mathematical edge cases (zero rate, target already
 *     met by principal, sustainable withdrawal rate).
 *   • Every rate is clamped to the SAME range the projection engine clamps its
 *     return to ({@link clampForecastReturnPct}) before any power or logarithm
 *     touches it — see the note on the re-export below.
 */

import { clampForecastReturnPct } from './projection';

/**
 * The rate bound is the projection's, not a second one: a loss beyond −100 %/yr
 * makes `1 + r` negative, and every solver below then takes either a fractional
 * power of a negative number (`NaN`) or the logarithm of a negative number
 * (`NaN` again) — the withdrawal card rendered that `NaN` straight into its
 * copy. Clamping at the math boundary (not only via the fields' `min`/`max`,
 * which never validate a bare number input outside a form) is what makes the
 * result honest for a pasted `-2000`. Re-exported so the cards bound their
 * inputs from the same single source they compute against.
 */
export {
  clampForecastReturnPct,
  FORECAST_RETURN_MAX_PCT,
  FORECAST_RETURN_MIN_PCT,
} from './projection';

/**
 * Horizon bounds the calculator "Years" fields are held to, mirroring
 * `FORECAST_HORIZON_MIN_YEARS`/`FORECAST_HORIZON_MAX_YEARS` (projection.ts):
 * the cards bound what they hand in and the math below defends the same range.
 * A free-text horizon is not merely a wrong number here — `dividendPlan`
 * materialises one array element per year, so `1000000000` would allocate a
 * 10⁹-element array on the main thread.
 */
export const FORECAST_CALC_MIN_YEARS = 0;
export const FORECAST_CALC_MAX_YEARS = 100;

// ─── Compound interest ───────────────────────────────────────────────────────

export interface CompoundInterestInput {
  /** Starting balance. */
  principal: number;
  /** Contribution made each month (rolls into per-period contributions). */
  monthlyContribution: number;
  /** Annual interest rate, percent (5 = 5 %/yr). */
  ratePctPerYear: number;
  /** Investment horizon in years. */
  years: number;
  /** Compounding events per year (1 = annual, 12 = monthly, …). */
  compoundingPerYear: number;
}

export interface CompoundInterestResult {
  /** Terminal balance. */
  finalBalance: number;
  /** Sum of principal + all contributions made. */
  totalContributions: number;
  /** finalBalance − totalContributions. */
  totalInterest: number;
}

/**
 * Ordinary-annuity compound growth. FV = P·(1+rp)^N + Cp·((1+rp)^N − 1)/rp,
 * with rp = ratePctPerYear/100/n, N = n·years, and Cp = monthly · 12/n.
 * Falls back to the linear formula at r = 0 so the divide never fires.
 *
 * The clamped rate keeps `1 + rp ≥ 0`, which is what guarantees a non-negative
 * final balance from a non-negative principal and contributions: below −100 %/yr
 * the growth factor turned negative and reported LESS than nothing was invested
 * (or `NaN` outright at a fractional number of periods).
 */
export function compoundInterest(input: CompoundInterestInput): CompoundInterestResult {
  const { principal, monthlyContribution, compoundingPerYear: n } = input;
  const ratePctPerYear = clampForecastReturnPct(input.ratePctPerYear);
  // A negative horizon is not a shorter plan — it is a discount factor, and it
  // would report a final balance BELOW the starting principal while still
  // counting contributions as paid in. Floor it at "no time has passed".
  const years = Math.max(FORECAST_CALC_MIN_YEARS, input.years);
  const N = n * years;
  const perPeriodContribution = (monthlyContribution * 12) / n;
  const totalContributions = principal + perPeriodContribution * N;

  let finalBalance: number;
  if (ratePctPerYear === 0) {
    finalBalance = principal + perPeriodContribution * N;
  } else {
    const rp = ratePctPerYear / 100 / n;
    const growth = Math.pow(1 + rp, N);
    finalBalance = principal * growth + (perPeriodContribution * (growth - 1)) / rp;
  }

  return {
    finalBalance,
    totalContributions,
    totalInterest: finalBalance - totalContributions,
  };
}

// ─── Savings plan: solve for contribution or years ───────────────────────────

export interface SavingsContributionInput {
  /** Target terminal balance. */
  target: number;
  principal: number;
  ratePctPerYear: number;
  years: number;
  compoundingPerYear: number;
}

export interface SavingsContributionResult {
  /** The monthly contribution needed to hit the target. 0 when the principal alone reaches it. */
  monthlyContribution: number;
  /**
   * `true` when the target is reachable in this horizon at ≥ 0 contribution;
   * `false` only when years ≤ 0 and the target still exceeds the principal.
   */
  feasible: boolean;
}

/**
 * Invert the compound-interest formula for the monthly contribution: solve
 * FV = P·(1+rp)^N + Cp·((1+rp)^N − 1)/rp for Cp, then rescale to a monthly
 * figure (Cp · n/12). Clamped at 0 — a principal that already exceeds the
 * target reports "zero contribution needed, feasible".
 */
export function savingsPlanContribution(
  input: SavingsContributionInput,
): SavingsContributionResult {
  const { target, principal, compoundingPerYear: n } = input;
  const ratePctPerYear = clampForecastReturnPct(input.ratePctPerYear);
  // Same floor as {@link compoundInterest}: a negative horizon collapses to the
  // zero-horizon answer instead of inverting the growth term.
  const years = Math.max(FORECAST_CALC_MIN_YEARS, input.years);
  const N = n * years;

  if (N <= 0) {
    // Zero-horizon: the target is met iff the principal already covers it.
    return { monthlyContribution: 0, feasible: principal >= target };
  }

  let perPeriodContribution: number;
  if (ratePctPerYear === 0) {
    perPeriodContribution = (target - principal) / N;
  } else {
    const rp = ratePctPerYear / 100 / n;
    const growth = Math.pow(1 + rp, N);
    const annuityFactor = (growth - 1) / rp;
    perPeriodContribution = (target - principal * growth) / annuityFactor;
  }

  if (perPeriodContribution <= 0) {
    return { monthlyContribution: 0, feasible: true };
  }

  return {
    monthlyContribution: (perPeriodContribution * n) / 12,
    feasible: true,
  };
}

export interface SavingsYearsInput {
  target: number;
  principal: number;
  monthlyContribution: number;
  ratePctPerYear: number;
  compoundingPerYear: number;
}

export interface SavingsYearsResult {
  /** Years to reach the target; `null` when the target is unattainable at these inputs. */
  years: number | null;
  feasible: boolean;
}

/**
 * Solve the compound-interest formula for the horizon in years. Returns
 * `{ years: 0, feasible: true }` when the principal already meets the target,
 * and `{ years: null, feasible: false }` when contribution + growth never
 * catches the target (target above principal, r = 0, and contribution ≤ 0).
 */
export function savingsPlanYears(input: SavingsYearsInput): SavingsYearsResult {
  const { target, principal, monthlyContribution, compoundingPerYear: n } = input;
  const ratePctPerYear = clampForecastReturnPct(input.ratePctPerYear);

  if (principal >= target) return { years: 0, feasible: true };
  const perPeriodContribution = (monthlyContribution * 12) / n;

  if (ratePctPerYear === 0) {
    if (perPeriodContribution <= 0) return { years: null, feasible: false };
    const N = (target - principal) / perPeriodContribution;
    return { years: N / n, feasible: true };
  }

  const rp = ratePctPerYear / 100 / n;
  // A total loss per period (−100 %/yr compounded once a year) leaves no growth
  // base at all: `log(1 + rp)` is −∞ there, so no horizon reaches the target.
  if (1 + rp <= 0) return { years: null, feasible: false };
  // FV = (1+rp)^N · (P + Cp/rp) − Cp/rp  ⇒  (1+rp)^N = (FV + Cp/rp)/(P + Cp/rp).
  const offset = perPeriodContribution / rp;
  const numerator = target + offset;
  const denominator = principal + offset;
  // A zero/negative denominator means the growth path can never leave the
  // starting point (e.g. principal + huge negative contribution).
  if (denominator <= 0 || numerator / denominator <= 0) {
    return { years: null, feasible: false };
  }
  const N = Math.log(numerator / denominator) / Math.log(1 + rp);
  if (!Number.isFinite(N) || N < 0) return { years: null, feasible: false };
  return { years: N / n, feasible: true };
}

// ─── Dividend / yield projection ─────────────────────────────────────────────

export interface DividendPlanInput {
  /** Position value today (any currency; the calculator returns the same unit). */
  positionValue: number;
  /** Current dividend yield, percent (3 = 3 %/yr on today's value). */
  yieldPctPerYear: number;
  /** Annual dividend growth, percent. */
  growthPctPerYear: number;
  /** Projection horizon in whole years. */
  years: number;
}

export interface DividendPlanResult {
  /** Projected dividend for each year 1..years. */
  yearlyDividends: number[];
  /** Sum of yearlyDividends. */
  totalDividends: number;
  /**
   * Yield-on-cost of the LAST projected payment, percent — i.e.
   * `yearlyDividends.at(-1) / positionValue · 100`. With no projected year at
   * all it stays at the current yield.
   */
  yieldOnCostFinalPct: number;
}

/**
 * Compound the annual dividend at `growthPctPerYear` for `years` years, seeded
 * from `positionValue · yieldPctPerYear/100`. Sums the stream and reports the
 * yield-on-cost of the final year IN that stream. Non-integer `years` is
 * truncated and the horizon is bounded to `FORECAST_CALC_MIN_YEARS ..
 * FORECAST_CALC_MAX_YEARS` — one element is materialised per year, so an
 * unbounded horizon is an allocation, not just a nonsense figure.
 */
export function dividendPlan(input: DividendPlanInput): DividendPlanResult {
  const { positionValue, years } = input;
  // Both rates take the shared bound: an unbounded growth rate below −100 %/yr
  // makes `1 + g` negative, so the stream alternates sign and the yield-on-cost
  // headline states a NEGATIVE yield on a positive position.
  const yieldPctPerYear = clampForecastReturnPct(input.yieldPctPerYear);
  const growthPctPerYear = clampForecastReturnPct(input.growthPctPerYear);
  const wholeYears = Math.max(
    FORECAST_CALC_MIN_YEARS,
    Math.min(FORECAST_CALC_MAX_YEARS, Number.isFinite(years) ? Math.trunc(years) : 0),
  );
  const g = growthPctPerYear / 100;
  const yearlyDividends: number[] = [];
  let dividend = (positionValue * yieldPctPerYear) / 100;
  for (let year = 1; year <= wholeYears; year++) {
    yearlyDividends.push(dividend);
    dividend *= 1 + g;
  }
  const totalDividends = yearlyDividends.reduce((sum, x) => sum + x, 0);
  // Year 1 is seeded UNGROWN, so the year-N payment is seed·(1+g)^(N−1); the
  // "final year" yield-on-cost has to read off that same payment rather than a
  // growth step past the end of the stream the card shows beside it.
  const yieldOnCostFinalPct =
    wholeYears === 0 ? yieldPctPerYear : yieldPctPerYear * Math.pow(1 + g, wholeYears - 1);
  return { yearlyDividends, totalDividends, yieldOnCostFinalPct };
}

// ─── Withdrawal plan: depletion horizon and sustainable rate ────────────────

export interface WithdrawalHorizonInput {
  /** Starting balance the plan draws down from. */
  balance: number;
  /** Fixed monthly withdrawal. */
  monthlyWithdrawal: number;
  /** Expected annual return on the remaining balance, percent. */
  annualReturnPct: number;
}

export interface WithdrawalHorizonResult {
  /** Months until depletion. `null` when withdrawals never deplete (sustainable). */
  months: number | null;
  /** `true` when the withdrawal rate is at or below the balance's monthly interest. */
  sustainable: boolean;
}

/**
 * Solve N in `B·(1+rm)^N − W·((1+rm)^N − 1)/rm = 0`, where rm is the nominal
 * monthly rate `annualReturnPct/100/12`. At `W ≤ B·rm` withdrawals never
 * exhaust the balance (sustainable). At `rm = 0` the answer collapses to
 * `B/W`.
 */
export function withdrawalHorizon(input: WithdrawalHorizonInput): WithdrawalHorizonResult {
  const { balance, monthlyWithdrawal } = input;
  // The clamp is what keeps `1 + rm` positive: at `rm < -1` the closed form took
  // `Math.log` of a negative number, `months` came back `NaN`, and the card's
  // `months === null` guard let that `NaN` render as "≈ NaN months".
  const annualReturnPct = clampForecastReturnPct(input.annualReturnPct);

  if (monthlyWithdrawal <= 0) {
    return { months: null, sustainable: true };
  }
  if (balance <= 0) {
    return { months: 0, sustainable: false };
  }

  if (annualReturnPct === 0) {
    return { months: balance / monthlyWithdrawal, sustainable: false };
  }

  const rm = annualReturnPct / 100 / 12;
  const interestPerMonth = balance * rm;

  if (rm > 0 && monthlyWithdrawal <= interestPerMonth) {
    return { months: null, sustainable: true };
  }

  const denominator = monthlyWithdrawal - interestPerMonth;
  if (denominator <= 0) return { months: null, sustainable: true };
  const ratio = monthlyWithdrawal / denominator;
  if (ratio <= 0) return { months: null, sustainable: true };
  const months = Math.log(ratio) / Math.log(1 + rm);
  // Belt and braces: the clamp above already rules the non-finite branch out, so
  // a `null` here means "these inputs state no horizon" — which is exactly what
  // the card's `notComputable` copy says — never a figure it cannot render.
  if (!Number.isFinite(months)) return { months: null, sustainable: false };
  return { months, sustainable: false };
}

export interface WithdrawalRateInput {
  balance: number;
  /** Payout horizon in months. */
  months: number;
  annualReturnPct: number;
}

export interface WithdrawalRateResult {
  /** Sustainable monthly withdrawal that exhausts the balance at the end of `months`. */
  monthlyWithdrawal: number;
}

/**
 * The counterpart to {@link withdrawalHorizon}: given a horizon, return the
 * monthly withdrawal that leaves zero at the end. Closed form of the annuity
 * payout: W = B·rm·(1+rm)^N / ((1+rm)^N − 1). Falls back to `B / N` at r = 0.
 *
 * Nothing imports this yet — it takes the same rate clamp as its twin so that
 * wiring it into a card later cannot reintroduce the `NaN` this issue closes.
 */
export function withdrawalRate(input: WithdrawalRateInput): WithdrawalRateResult {
  const { balance, months: N } = input;
  const annualReturnPct = clampForecastReturnPct(input.annualReturnPct);
  if (N <= 0) return { monthlyWithdrawal: 0 };
  if (annualReturnPct === 0) return { monthlyWithdrawal: balance / N };
  const rm = annualReturnPct / 100 / 12;
  const growth = Math.pow(1 + rm, N);
  const monthlyWithdrawal = (balance * rm * growth) / (growth - 1);
  return { monthlyWithdrawal };
}
