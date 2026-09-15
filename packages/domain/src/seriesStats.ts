/**
 * Series statistics for the Analytics deep-dive page (PROJECTPLAN.md §13.3,
 * V3-P9): side-by-side compare stats (total %, CAGR, max drawdown, best/worst
 * day), the performance-% display mode, real-terms (inflation) deflation, the
 * time-weighted window statistics a forecast samples as its return factor
 * (§13.5 V5-P6b), and the per-asset contribution table.
 *
 * Like the rest of `domain/**` this is money-critical T1 code and a **pure**
 * module: it imports nothing at runtime (only the value/flow point *types* of
 * `holdings.ts`, so the money-weighted window reads the very series the TWR
 * curve is built from), reads no clock (`dateToMs` is a deterministic parse of
 * a *passed-in* ISO string, not a `Date.now()`), performs no I/O, and never
 * mutates its inputs — every function is deterministic given its arguments.
 * No rounding happens here (§5.4): every figure is returned at full `number`
 * precision; display rounding lives in the display layer.
 *
 * `computeSeriesStats` mirrors the stat formulas of the backtest engine's
 * `computeStats` (backtest.ts, §6.6) — same total-return, ACT/365.25 CAGR,
 * running-peak drawdown, and consecutive-day best/worst rules — but adds the
 * guards a *generic* value series needs which a base-100 backtest index never
 * does: the backtest series opens at exactly 100 and stays positive, whereas an
 * arbitrary portfolio/benchmark series may be empty or touch zero, so every
 * division here is guarded against a non-positive base.
 */

import type { FlowPoint, ValuePoint } from './holdings';

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

/**
 * UTC midnight epoch-ms of an ISO `YYYY-MM-DD` date that MUST parse — the
 * money-weighted window throws on a malformed date rather than weighting a
 * flow by `NaN` (the TWR's `assertIsoDate` discipline, holdings.ts).
 */
function isoDayToMs(date: string, what: string): number {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(date) ? dateToMs(date) : Number.NaN;
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid ${what}: expected ISO YYYY-MM-DD, got ${JSON.stringify(date)}`);
  }
  return ms;
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
 *  - `index`: `value · index(startMonth)/index(pointMonth)`. The index level
 *    for a `YYYY-MM` month is **linearly interpolated** between the anchors
 *    that bracket it (fractional-month-of-year units), so any window shorter
 *    than the anchor spacing — a 6-month window inside a year of annual
 *    anchors — still deflates smoothly (V4-P0 preset-fix). Months before the
 *    earliest anchor floor to that anchor's value; months **after the latest
 *    anchor extrapolate** linearly along the slope of the last two anchors —
 *    without extrapolation a portfolio whose whole history sits past the last
 *    checked-in observation would flatline (bug #468, root cause). Entries
 *    sort stably by month; a single-anchor set carries that value everywhere.
 *    An empty index leaves the series unchanged.
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

  const indexAt = buildIndexResolver(deflator.monthly);
  if (!indexAt) return series.map((pt) => ({ date: pt.date, value: pt.value }));
  const baseLevel = indexAt(first.date.slice(0, 7));
  return series.map((pt) => ({
    date: pt.date,
    value: pt.value * (baseLevel / indexAt(pt.date.slice(0, 7))),
  }));
}

/**
 * ISO `YYYY-MM` → a comparable month-of-anchor number (year * 12 + month). Any
 * strictly monotonic-in-month mapping would do; year*12+month keeps the
 * arithmetic exact so the interpolation weight is a plain rational number.
 */
function monthKey(month: string): number {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return y * 12 + (m - 1);
}

/**
 * Build the `indexAt(month)` resolver used by both {@link deflateSeries} and
 * {@link indexAveragePctPerYear} — one code path so the fix and the "%/yr"
 * label a UI shows agree on how a given month reads. `null` when the anchor
 * set is empty (caller degrades to the identity).
 */
function buildIndexResolver(
  monthly: ReadonlyArray<{ readonly month: string; readonly value: number }>,
): ((month: string) => number) | null {
  if (monthly.length === 0) return null;
  const sorted = [...monthly].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  const earliest = sorted[0]!;
  const latest = sorted[sorted.length - 1]!;
  return (month: string): number => {
    if (month <= earliest.month) return earliest.value;
    if (month >= latest.month) {
      // Linear extrapolation along the slope of the last two anchors, so a
      // window whose points all sit past the last observation still deflates.
      // With a single anchor no slope exists → carry forward the level.
      if (sorted.length === 1) return latest.value;
      const prev = sorted[sorted.length - 2]!;
      const dx = monthKey(latest.month) - monthKey(prev.month);
      if (dx === 0) return latest.value;
      const slope = (latest.value - prev.value) / dx;
      return latest.value + slope * (monthKey(month) - monthKey(latest.month));
    }
    // Interior: find the bracket (a, b) with a.month <= month < b.month and
    // interpolate linearly. `sorted` is already ascending; a single pass is
    // fine (analytics anchor sets are tiny — one per year).
    for (let i = 1; i < sorted.length; i += 1) {
      const b = sorted[i]!;
      const a = sorted[i - 1]!;
      if (month < b.month) {
        const dx = monthKey(b.month) - monthKey(a.month);
        if (dx === 0) return a.value;
        const t = (monthKey(month) - monthKey(a.month)) / dx;
        return a.value + (b.value - a.value) * t;
      }
    }
    // Unreachable: the `>= latest.month` guard above catches this.
    return latest.value;
  };
}

/**
 * Effective annualised %/yr an inflation-index preset averaged over its
 * checked-in observations. Computed as the CAGR from the first to the last
 * anchor `(last/first)^(1/years) − 1`, so a UI can show "≈ 2.6 %/yr" next to
 * the preset label (V4-P0). Uses the same {@link buildIndexResolver} range —
 * empty / single-anchor / non-positive base all resolve to `null`.
 */
export function indexAveragePctPerYear(
  monthly: ReadonlyArray<{ readonly month: string; readonly value: number }>,
): number | null {
  if (monthly.length < 2) return null;
  const sorted = [...monthly].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (first.value <= 0) return null;
  const months = monthKey(last.month) - monthKey(first.month);
  if (months <= 0) return null;
  const years = months / 12;
  return (Math.pow(last.value / first.value, 1 / years) - 1) * 100;
}

// ---------------------------------------------------------------------------
// Time-weighted return statistics
// ---------------------------------------------------------------------------

/**
 * The window statistics of a **time-weighted** return series (#1759): the
 * flow-neutral counterpart of {@link SeriesStats}'s `totalReturnPct`/`cagrPct`.
 */
export interface TwrStats {
  /** TWR over the window, percent, rebased so the first point is 0 %. */
  readonly totalReturnPct: number;
  /** Annualised TWR (ACT/365.25); `null` when no calendar time elapsed. */
  readonly cagrPct: number | null;
}

/**
 * Window statistics of a cumulative **time-weighted** return series — the
 * annualised figure a forecast may sample as "the return this portfolio has
 * historically earned" (§13.5 V5-P6b, #1759).
 *
 * The CAGR of a portfolio's *value* series is not a rate of return: every
 * deposit raises the value, so a saver who contributes monthly reads their own
 * contributions back as performance. A TWR series carries no such inflation —
 * {@link https://en.wikipedia.org/wiki/Time-weighted_return} links each period's
 * return across the flows — so annualising IT answers the question the value
 * CAGR only appeared to.
 *
 * The input is the cumulative-percent curve the portfolio already computes
 * (`holdings.timeWeightedReturn`, §6.9): `pct` is the compounded return since
 * the curve's own anchor. It is rebased here onto the FIRST point of whatever
 * window is passed in (compounding, never subtraction — percentages don't add
 * across time), so slicing a since-inception curve to a 1Y/3Y/5Y window and
 * handing it over states that window's return. An optional {@link Deflator}
 * expresses the result in real terms, exactly as {@link deflateSeries} does for
 * a value series.
 *
 * The rebased index is then measured by {@link computeSeriesStats} itself, so
 * the total-return and ACT/365.25 CAGR formulas have ONE definition in this
 * module: for a portfolio with no external flows the TWR index is `V/V₀` point
 * for point, and this function therefore returns exactly the value series'
 * `totalReturnPct`/`cagrPct` — the no-flows case cannot diverge between the two
 * statistics.
 *
 * `null` when the window cannot state a return at all: an empty series, or a
 * base point at or below −100 % (a non-positive index, which a well-formed TWR
 * curve never reaches).
 */
export function computeTwrStats(
  performance: ReadonlyArray<PerfPoint>,
  deflator: Deflator | null = null,
): TwrStats | null {
  const first = performance[0];
  if (first === undefined) return null;
  const base = 1 + first.pct / 100;
  if (!Number.isFinite(base) || base <= 0) return null;
  const index: StatSeriesPoint[] = performance.map((pt) => ({
    date: pt.date,
    value: (1 + pt.pct / 100) / base,
  }));
  const stats = computeSeriesStats(deflator ? deflateSeries(index, deflator) : index);
  return { totalReturnPct: stats.totalReturnPct, cagrPct: stats.cagrPct };
}

// ---------------------------------------------------------------------------
// Money-weighted return — Modified Dietz (#1669)
// ---------------------------------------------------------------------------

/** One external cash flow inside a Modified Dietz window, at an exact instant. */
export interface DietzFlow {
  /** Epoch-ms instant the money was put to work (positive) or taken out (negative). */
  readonly atMs: number;
  /** Signed amount in the window's currency: into the portfolio positive, out negative. */
  readonly amount: number;
}

/** The ingredients of one Modified Dietz window — see {@link modifiedDietz}. */
export interface DietzWindow {
  /** Epoch-ms instant the window opens; `startValue` is the capital at work then. */
  readonly startMs: number;
  /** Epoch-ms instant the window closes (never before `startMs`); `endValue` is the value then. */
  readonly endMs: number;
  readonly startValue: number;
  readonly endValue: number;
  /** External flows; those outside `[startMs, endMs]` are ignored (see {@link modifiedDietz}). */
  readonly flows: ReadonlyArray<DietzFlow>;
}

/**
 * Modified Dietz return of one window, percent (#1669, §16 2026-09-14):
 *
 *     MD = (V_end − V_start − Σ F_i) / (V_start + Σ w_i · F_i)
 *     w_i = (t_end − t_i) / (t_end − t_start)   — the fraction of the window
 *                                                 remaining after flow i
 *
 * — the gain the window produced, over the capital that was at work in it,
 * each flow counting for the share of the window it was invested for. This is
 * the **money-weighted** counterpart of the time-weighted curve
 * ({@link computeTwrStats}, `holdings.timeWeightedReturn`): a deposit made just
 * before a rally raises it and the same deposit made just after a crash barely
 * moves it, whereas the TWR — by design — ignores both. That is exactly why the
 * two are served side by side: a tiny early stake that lost two thirds before
 * the real money arrived drags the TWR deep into the red while the money-
 * weighted figure reports what the money actually earned. Exact XIRR is
 * deliberately not attempted (the headline is a summary; Dietz is what the
 * reference tools print for "your money's return").
 *
 *  - Flows before `startMs` are already inside `startValue` and flows after
 *    `endMs` have not happened yet: both are ignored. A flow AT `startMs`
 *    weighs 1, a flow AT `endMs` weighs 0. A zero-length window
 *    (`startMs === endMs`) has no time to weight by: a flow at that instant
 *    weighs 1 — it IS the capital.
 *  - `null` when the window has no capital to measure against: a denominator
 *    within {@link EPSILON} of zero or below it (nothing invested, or
 *    withdrawals that outweigh the start value — the known Dietz blind spot,
 *    which the ruling maps to "no figure", never to a sign flip).
 *  - Throws on a non-finite input or a window that runs backwards: this is
 *    the money path, and a silent `NaN` would surface as a wrong headline.
 *  - Full precision (§5.4); the display layer rounds.
 */
export function modifiedDietz(window: DietzWindow): number | null {
  const { startMs, endMs, startValue, endValue, flows } = window;
  for (const [label, n] of [
    ['startMs', startMs],
    ['endMs', endMs],
    ['startValue', startValue],
    ['endValue', endValue],
  ] as const) {
    if (!Number.isFinite(n)) throw new Error(`modifiedDietz: ${label} must be finite, got ${n}`);
  }
  if (endMs < startMs) {
    throw new Error(`modifiedDietz: window runs backwards (${startMs} → ${endMs})`);
  }
  const span = endMs - startMs;

  let netFlow = 0;
  let weightedFlow = 0;
  for (const flow of flows) {
    if (!Number.isFinite(flow.atMs) || !Number.isFinite(flow.amount)) {
      throw new Error(`modifiedDietz: flow must be finite, got ${flow.atMs} / ${flow.amount}`);
    }
    if (flow.atMs < startMs || flow.atMs > endMs) continue;
    const weight = span > 0 ? (endMs - flow.atMs) / span : 1;
    netFlow += flow.amount;
    weightedFlow += weight * flow.amount;
  }

  const denominator = startValue + weightedFlow;
  if (denominator <= EPSILON) return null;
  return ((endValue - startValue - netFlow) / denominator) * 100;
}

/**
 * Where a daily-series Dietz window opens relative to its first point — the
 * two anchors the served TWR curve already uses (§6.8, #125), so the two
 * headline figures of a range always measure the same window:
 *
 *  - `'inception'` — the MAX / since-inception anchor. The window opens just
 *    BEFORE the first day's own flows with no capital at all, so the money
 *    that opened the position is the first flow (weight 1) and day one's
 *    execution→close move counts as return — exactly as `timeWeightedReturn`
 *    anchors its index at 1 before day one (never re-based to the first
 *    plotted point).
 *  - `'first-point'` — the re-based range slice (1W … 5Y). The window opens
 *    at the first point's close, that value is the starting capital and the
 *    first day's flows are already inside it (they are not counted) — exactly
 *    as `rebasePerformance` divides the curve by its first point.
 */
export type DietzAnchor = 'inception' | 'first-point';

/**
 * Money-weighted (Modified Dietz) return of a daily value series over the
 * window its points span, percent, or `null` when the window has no capital
 * (#1669). Consumes the SAME `values`/`flows` the time-weighted curve is
 * built from (`holdings.timeWeightedReturn` — `flows` are the external
 * deposits/withdrawals `externalCashFlowsForTwr` classifies, never cash-funded
 * buys, sell proceeds or internal transfers), so the two figures can never
 * disagree about what counts as money crossing the portfolio boundary.
 *
 * Daily flows are placed on the clock by the TWR's own hybrid convention: the
 * day's NET flow counts as an **inflow at the start of its day** (the previous
 * close — the new money is at work for that whole day's move) or as an
 * **outflow at its close** (the money left with the day's move already
 * earned). Over a single day this makes the Dietz figure equal the TWR's
 * daily link `r_d − 1` exactly, for either sign — the two headlines start from
 * one definition of "when did the money arrive" and diverge only in how they
 * chain across days.
 *
 *  - `window.anchor` picks the start, see {@link DietzAnchor}. Under
 *    `'inception'` a first day that brings no measurable money in (net flow
 *    not positive — a series whose history starts before its FX pair's, say,
 *    V3-P10d) has nothing to anchor at; the window then opens at the first
 *    point like a slice does, which is what `timeWeightedReturn` effectively
 *    does when its day-one link is flat.
 *  - A flow dated inside the window counts whether or not that day carries a
 *    value point; flows before the window are inside its start value, flows
 *    after it have not happened yet (a future-dated transaction), and both are
 *    ignored — the TWR ignores the latter the same way.
 *  - Empty series ⇒ `null`. A single-point `'first-point'` window has no
 *    elapsed time and no counted flows, so it reads 0 % on any positive value
 *    (and `null` on none), exactly like the re-based one-point TWR.
 *  - Unsorted input is tolerated (sorted on a copy); nothing is mutated.
 *    Throws on a non-finite value/flow or a malformed date, as the TWR does.
 */
export function modifiedDietzReturn(
  values: ReadonlyArray<ValuePoint>,
  flows: ReadonlyArray<FlowPoint>,
  window: { readonly anchor: DietzAnchor },
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  for (const point of sorted) {
    isoDayToMs(point.date, 'value point date');
    if (!Number.isFinite(point.valueEur)) {
      throw new Error(`Value on ${point.date} must be a finite number, got ${point.valueEur}`);
    }
  }

  // The day's NET external flow, as the TWR links it (one bucket per day).
  const netByDate = new Map<string, number>();
  for (const flow of flows) {
    isoDayToMs(flow.date, 'flow point date');
    if (!Number.isFinite(flow.flowEur)) {
      throw new Error(`Flow on ${flow.date} must be a finite number, got ${flow.flowEur}`);
    }
    netByDate.set(flow.date, (netByDate.get(flow.date) ?? 0) + flow.flowEur);
  }

  // A point's instant stands in for its close; only differences matter, so
  // UTC midnight is as good a close as any. An inflow on day d is at work from
  // the previous close (d − 1 day), an outflow leaves at d's own close.
  const firstMs = isoDayToMs(first.date, 'value point date');
  const endMs = isoDayToMs(last.date, 'value point date');
  const anchor: DietzAnchor =
    window.anchor === 'inception' && (netByDate.get(first.date) ?? 0) > EPSILON
      ? 'inception'
      : 'first-point';
  const startMs = anchor === 'inception' ? firstMs - MS_PER_DAY : firstMs;
  const startValue = anchor === 'inception' ? 0 : first.valueEur;

  const dietzFlows: DietzFlow[] = [];
  for (const [date, net] of netByDate) {
    if (net === 0) continue;
    const inWindow = anchor === 'inception' ? date >= first.date : date > first.date;
    if (!inWindow || date > last.date) continue;
    const dayMs = isoDayToMs(date, 'flow point date');
    dietzFlows.push({ atMs: net > 0 ? dayMs - MS_PER_DAY : dayMs, amount: net });
  }

  return modifiedDietz({ startMs, endMs, startValue, endValue: last.valueEur, flows: dietzFlows });
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

// ---------------------------------------------------------------------------
// N-series comparison (deltas vs a chosen baseline)
// ---------------------------------------------------------------------------

/**
 * The stat metrics an N-series comparison ranks side by side (§13.5 V5-P6): a
 * flat numeric projection of the backtest engine's `BacktestStats`. This
 * generalises the V4-P7 two-series benchmark table (basket vs benchmark) to any
 * number of aligned series — the same six metrics, now compared against one
 * caller-chosen baseline instead of a fixed benchmark. The engine already runs
 * every series over one shared window, so the vectors are apples-to-apples by
 * construction; this module only computes the pairwise deltas.
 */
export const COMPARISON_METRICS = [
  'totalReturnPct',
  'cagrPct',
  'maxDrawdownPct',
  'volatilityPct',
  'bestDayPct',
  'worstDayPct',
] as const;
export type ComparisonMetric = (typeof COMPARISON_METRICS)[number];

/**
 * One series' comparable stat vector. A metric is `null` exactly where the
 * underlying `BacktestStats` figure is undefined (CAGR / volatility on a
 * single-day window, best/worst day with no returns) — the delta against it is
 * then `null`, never a spurious `0`.
 */
export type ComparisonMetricVector = Readonly<Record<ComparisonMetric, number | null>>;

/** One input series to {@link compareSeriesStats}: an id + its stat vector. */
export interface ComparisonSeriesInput {
  readonly id: string;
  readonly metrics: ComparisonMetricVector;
}

/**
 * Per-metric delta of a series against the baseline (`metric − baselineMetric`,
 * in the metric's own units — percentage points). `null` when either side is
 * `null` (an undefined stat has no meaningful delta).
 */
export type ComparisonMetricDeltas = Readonly<Record<ComparisonMetric, number | null>>;

/** One series in the comparison result: its vector echoed back + deltas vs the baseline. */
export interface ComparisonSeriesResult {
  readonly id: string;
  readonly metrics: ComparisonMetricVector;
  readonly deltas: ComparisonMetricDeltas;
}

/** The comparison outcome: the chosen baseline id + one result per input (input order preserved). */
export interface SeriesComparison {
  readonly baselineId: string;
  readonly series: ComparisonSeriesResult[];
}

/**
 * Compare N aligned series' stat vectors against one baseline series (§13.5
 * V5-P6, generalising the V4-P7 `basket − benchmark` delta to N series).
 *
 * For every input series and every {@link COMPARISON_METRICS} metric the result
 * carries `metric − baselineMetric`, at full precision (no rounding, §5.4), with
 * a `null` wherever either operand is `null`. The baseline series compares
 * against itself, so its own deltas are `0` (or `null` where its metric is
 * `null`). Input order is preserved so the caller can zip the result back onto
 * its series list. The function is pure: it reads no clock, mutates nothing, and
 * is deterministic given its arguments.
 *
 * Rejects (throws) on structurally invalid input — the caller must have already
 * validated the request: no series, a `baselineId` absent from the set, or a
 * duplicate id (which would make "the baseline" ambiguous).
 */
export function compareSeriesStats(
  inputs: ReadonlyArray<ComparisonSeriesInput>,
  baselineId: string,
): SeriesComparison {
  if (inputs.length === 0) {
    throw new Error('compareSeriesStats requires at least one series');
  }
  const ids = new Set<string>();
  for (const input of inputs) {
    if (ids.has(input.id)) {
      throw new Error(`compareSeriesStats: duplicate series id ${input.id}`);
    }
    ids.add(input.id);
  }
  const baseline = inputs.find((s) => s.id === baselineId);
  if (baseline === undefined) {
    throw new Error(`compareSeriesStats: baselineId ${baselineId} is not among the series`);
  }

  const series = inputs.map((input) => {
    const deltas = {} as Record<ComparisonMetric, number | null>;
    for (const metric of COMPARISON_METRICS) {
      const value = input.metrics[metric];
      const base = baseline.metrics[metric];
      deltas[metric] = value === null || base === null ? null : value - base;
    }
    return { id: input.id, metrics: input.metrics, deltas };
  });

  return { baselineId, series };
}
