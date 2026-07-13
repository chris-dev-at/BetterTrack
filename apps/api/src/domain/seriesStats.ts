/**
 * Series statistics for the Analytics deep-dive page (PROJECTPLAN.md §13.3,
 * V3-P9): side-by-side compare stats (total %, CAGR, max drawdown, best/worst
 * day), the performance-% display mode, real-terms (inflation) deflation, and
 * the per-asset contribution table.
 *
 * Like the rest of `domain/**` this is money-critical T1 code and a **pure**
 * module: it imports nothing, reads no clock (`dateToMs` is a deterministic
 * parse of a *passed-in* ISO string, not a `Date.now()`), performs no I/O, and
 * never mutates its inputs — every function is deterministic given its
 * arguments. No rounding happens here (§5.4): every figure is returned at full
 * `number` precision; display rounding lives in the display layer.
 *
 * `computeSeriesStats` mirrors the stat formulas of the backtest engine's
 * `computeStats` (backtest.ts, §6.6) — same total-return, ACT/365.25 CAGR,
 * running-peak drawdown, and consecutive-day best/worst rules — but adds the
 * guards a *generic* value series needs which a base-100 backtest index never
 * does: the backtest series opens at exactly 100 and stays positive, whereas an
 * arbitrary portfolio/benchmark series may be empty or touch zero, so every
 * division here is guarded against a non-positive base.
 */

// ---------------------------------------------------------------------------
// Constants & date helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/**
 * Calendar days per year for CAGR/deflation exponents (ACT/365.25 — averages
 * in the leap day so multi-year annualisation does not drift). Same constant
 * as the backtest engine (§6.6).
 */
const DAYS_PER_YEAR = 365.25;

/** Tolerance below which a total is treated as zero (guards 0/0 divisions). */
const EPSILON = 1e-9;

/** UTC midnight epoch-ms of an ISO `YYYY-MM-DD` date (no clock read; deterministic). */
function dateToMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/** Elapsed calendar years from ISO date `a` to ISO date `b` (signed, ACT/365.25). */
function yearsBetween(a: string, b: string): number {
  return (dateToMs(b) - dateToMs(a)) / (MS_PER_DAY * DAYS_PER_YEAR);
}

// ---------------------------------------------------------------------------
// Series statistics
// ---------------------------------------------------------------------------

/** One point of a dated value series (portfolio value, benchmark index, …). */
export interface StatSeriesPoint {
  readonly date: string;
  readonly value: number;
}

/** A single day's percentage return, tagged with the *later* day's date. */
export interface DayReturn {
  readonly date: string;
  readonly returnPct: number;
}

/** The V3-P9 side-by-side stats block (total %, CAGR, max drawdown, best/worst day). */
export interface SeriesStats {
  totalReturnPct: number;
  /** Annualised return (ACT/365.25); `null` when no calendar time elapsed. */
  cagrPct: number | null;
  /** Deepest peak-to-trough loss, always ≤ 0 (0 when the series only rises). */
  maxDrawdownPct: number;
  bestDay: DayReturn | null;
  worstDay: DayReturn | null;
}

const EMPTY_STATS: SeriesStats = Object.freeze({
  totalReturnPct: 0,
  cagrPct: null,
  maxDrawdownPct: 0,
  bestDay: null,
  worstDay: null,
});

/**
 * Performance statistics for an arbitrary value series (mirrors the backtest
 * engine's `computeStats`, §6.6, minus volatility).
 *
 *  - Empty series, or a series whose first value is ≤ 0 (no meaningful base to
 *    divide by), returns the zeroed defaults with `null` CAGR and days.
 *  - `totalReturnPct` is last/first − 1; `cagrPct` annualises it over elapsed
 *    calendar time and is `null` for a single-day window (`years === 0`).
 *  - Max drawdown is a single running-peak sweep: `value/peak − 1`, minimum
 *    tracked, so it is 0 for a series that never dips below a prior high.
 *  - Daily returns are ratios of *consecutive* points, tagged with the later
 *    point's date; strict `>`/`<` comparisons make the FIRST occurrence win
 *    ties. A day whose previous value is ≤ 0 has no meaningful ratio return
 *    and is skipped (guarded division — the base-100 backtest never needs
 *    this). Fewer than 2 points ⇒ `bestDay`/`worstDay` are `null`.
 */
export function computeSeriesStats(series: ReadonlyArray<StatSeriesPoint>): SeriesStats {
  const first = series[0];
  const last = series[series.length - 1];
  if (first === undefined || last === undefined || first.value <= 0) {
    return { ...EMPTY_STATS };
  }

  const totalReturnPct = (last.value / first.value - 1) * 100;

  const years = (dateToMs(last.date) - dateToMs(first.date)) / (MS_PER_DAY * DAYS_PER_YEAR);
  const cagrPct = years > 0 ? (Math.pow(last.value / first.value, 1 / years) - 1) * 100 : null;

  // Single sweep (as in backtest.computeStats): running peak for drawdown,
  // consecutive ratios for daily returns. `peak` starts at the first value,
  // which the guard above proves positive, and only ever rises — so the
  // drawdown division is safe even if the series later touches ≤ 0.
  let peak = first.value;
  let maxDd = 0;
  let bestDay: DayReturn | null = null;
  let worstDay: DayReturn | null = null;
  for (let i = 0; i < series.length; i += 1) {
    const pt = series[i];
    if (pt === undefined) continue; // unreachable
    if (pt.value > peak) peak = pt.value;
    const dd = pt.value / peak - 1;
    if (dd < maxDd) maxDd = dd;
    if (i > 0) {
      const prev = series[i - 1];
      if (prev !== undefined && prev.value > 0) {
        const r: DayReturn = { date: pt.date, returnPct: (pt.value / prev.value - 1) * 100 };
        if (bestDay === null || r.returnPct > bestDay.returnPct) bestDay = r;
        if (worstDay === null || r.returnPct < worstDay.returnPct) worstDay = r;
      }
    }
  }

  return { totalReturnPct, cagrPct, maxDrawdownPct: maxDd * 100, bestDay, worstDay };
}

// ---------------------------------------------------------------------------
// Performance-% display mode
// ---------------------------------------------------------------------------

/** One point of a cumulative-percent (performance mode) series. */
export interface PerfPoint {
  readonly date: string;
  readonly pct: number;
}

/**
 * Rebase a value series to cumulative percent from its first point
 * (`pct = value/first − 1`, so the first point is exactly 0). Dates are
 * preserved. Empty input ⇒ `[]`; a non-positive first value has no meaningful
 * base, so every point is emitted as 0 % (guarded division).
 */
export function toPerformanceSeries(series: ReadonlyArray<StatSeriesPoint>): PerfPoint[] {
  const first = series[0];
  if (first === undefined) return [];
  if (first.value <= 0) {
    return series.map((pt) => ({ date: pt.date, pct: 0 }));
  }
  const base = first.value;
  return series.map((pt) => ({ date: pt.date, pct: (pt.value / base - 1) * 100 }));
}

// ---------------------------------------------------------------------------
// Inflation mode (real-terms deflation)
// ---------------------------------------------------------------------------

/**
 * How to deflate nominal values into real terms (V3-P9 inflation mode):
 * either a flat annual rate ("custom flat %/yr") or a monthly price-index
 * series (AT/EU HICP, US CPI). Index months are ISO `YYYY-MM`; index values
 * are expected positive (a CPI level), unsorted input is tolerated.
 */
export type Deflator =
  | { readonly kind: 'flat'; readonly pctPerYear: number }
  | {
      readonly kind: 'index';
      readonly monthly: ReadonlyArray<{ readonly month: string; readonly value: number }>;
    };

/**
 * Convert a nominal series to real (inflation-adjusted) terms, expressed in
 * **start-date money**: the first point is the base, so
 * `real[0].value === series[0].value` and later points are discounted by the
 * price growth since then. A flat positive rate therefore bends a flat nominal
 * curve visibly downward (the V3-P9 acceptance test).
 *
 *  - `flat`: `value · (1 + r/100)^(−yearsElapsed)` with ACT/365.25 years.
 *  - `index`: `value · index(startMonth)/index(pointMonth)`, where a month's
 *    index level is the latest monthly entry at-or-before it (carry-forward
 *    over missing months); months before the earliest entry use the earliest
 *    entry's level. Entries sort stably by month, so of duplicate months the
 *    last one in input order wins. An empty index leaves the series unchanged.
 *
 * Dates are preserved; the result is always a fresh array of fresh points
 * (inputs are never mutated). Empty input ⇒ `[]`.
 */
export function deflateSeries(
  series: ReadonlyArray<StatSeriesPoint>,
  deflator: Deflator,
): StatSeriesPoint[] {
  const first = series[0];
  if (first === undefined) return [];

  if (deflator.kind === 'flat') {
    const growth = 1 + deflator.pctPerYear / 100;
    return series.map((pt) => ({
      date: pt.date,
      value: pt.value * growth ** -yearsBetween(first.date, pt.date),
    }));
  }

  if (deflator.monthly.length === 0) {
    return series.map((pt) => ({ date: pt.date, value: pt.value }));
  }
  const sorted = [...deflator.monthly].sort((a, b) =>
    a.month < b.month ? -1 : a.month > b.month ? 1 : 0,
  );
  const earliest = sorted[0];
  if (earliest === undefined) {
    // Unreachable: monthly.length > 0 checked above.
    return series.map((pt) => ({ date: pt.date, value: pt.value }));
  }
  /** Index level for a `YYYY-MM` month: latest entry ≤ it, earliest as floor. */
  const indexAt = (month: string): number => {
    let level = earliest.value;
    for (const entry of sorted) {
      if (entry.month <= month) level = entry.value;
      else break;
    }
    return level;
  };
  const baseLevel = indexAt(first.date.slice(0, 7));
  return series.map((pt) => ({
    date: pt.date,
    value: pt.value * (baseLevel / indexAt(pt.date.slice(0, 7))),
  }));
}

// ---------------------------------------------------------------------------
// Per-asset contribution table
// ---------------------------------------------------------------------------

/** Per-asset inputs for the contribution table over a chosen period. */
export interface ContributionInput {
  readonly assetId: string;
  /** Asset value at the period start. */
  readonly startValue: number;
  /** Asset value at the period end. */
  readonly endValue: number;
  /** Asset value now (drives the portfolio weight column). */
  readonly currentValue: number;
}

/** One row of the V3-P9 contribution table. */
export interface ContributionShare {
  readonly assetId: string;
  /** `currentValue / Σ currentValue`; 0 when the total is ~0. */
  readonly weight: number;
  /** `(endValue − startValue) / Σ startValue · 100`; 0 when the start total is ~0. */
  readonly contributionPct: number;
}

/**
 * Per-asset weight and contribution to the period's change. Contributions are
 * additive against the *common* start total, so
 * `Σ contributionPct === (Σ end / Σ start − 1) · 100` — the rows sum exactly
 * to the filtered total return. Input order is preserved; degenerate totals
 * (|Σ start| or Σ current within {@link EPSILON} of 0) yield 0 instead of a
 * division by ~0. Empty input ⇒ `[]`.
 */
export function computeContributions(
  inputs: ReadonlyArray<ContributionInput>,
): ContributionShare[] {
  let totalStart = 0;
  let totalCurrent = 0;
  for (const input of inputs) {
    totalStart += input.startValue;
    totalCurrent += input.currentValue;
  }
  return inputs.map((input) => ({
    assetId: input.assetId,
    weight: totalCurrent > EPSILON ? input.currentValue / totalCurrent : 0,
    contributionPct:
      Math.abs(totalStart) > EPSILON ? ((input.endValue - input.startValue) / totalStart) * 100 : 0,
  }));
}
