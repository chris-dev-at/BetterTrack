/**
 * Pure, side-effect-free net-worth projection engine (PROJECTPLAN.md §13.5
 * V5-P6b arc (b), issue #596). Given a starting net worth and a set of
 * user-chosen factors it returns a monthly value-over-time series — "predict
 * your net worth if you keep doing what you're doing" — plus one overlay series
 * per what-if plan. The view wires it to real portfolio data; the tests pin it
 * to hand-computed fixtures.
 *
 * ── Model ────────────────────────────────────────────────────────────────────
 * The projection walks **month by month** in an ordinary-annuity convention (a
 * contribution lands at the END of each month, matching `calc.ts`): every step
 * grows the running balance by the monthly-equivalent of the annual return, then
 * adds that month's net cash flow. Month 0 is `asOf` at the starting value with
 * no growth or flow; steps 1..(12·horizonYears) follow.
 *
 * A monthly rate is the geometric monthly-equivalent of the annual figure —
 * `(1 + r/100)^(1/12) − 1` — so exactly twelve steps compound back to the annual
 * return (a €1,000 balance at 10 %/yr reads €1,100 after month 12).
 *
 * ── Net-worth semantics of standing orders (design decision, §16-style) ──────
 * The series tracks **net worth** (total portfolio value), so a factor moves the
 * line only insofar as it moves net worth:
 *   • `cash-add` ("salary")   → **+** flow  — new external money entering.
 *   • `cash-deduct` ("Netflix")→ **−** flow — money leaving to spend.
 *   • `buy-asset` (a recurring buy) → **neutral**, excluded. A buy reallocates
 *     cash you already own into a holding; net worth is unchanged at purchase and
 *     the holding's future appreciation is already captured by the return factor.
 *     Counting the buy as fresh money would double-count the salary that funds
 *     it (salary +€3,000, spend −€2,500, invest the €500 rest ⇒ net worth grows
 *     €500/mo, not €3,500). To model *new* recurring investment, use a what-if
 *     plan — that is exactly the spec's "what if I invest €200/month" tool.
 * This keeps the engine correct-by-construction AND free of any market pricing
 * (a buy's share→EUR cost never has to be resolved client-side).
 *
 * What-if plans are additional contribution streams that do NOT change the base
 * line: each renders as its own overlay = base + the plan's standalone
 * accumulation (its monthly contribution compounded at the plan's own return, or
 * the base return when it names none). Because a fixed-rate system is linear in
 * its flows, "base AND this plan" is exactly base + plan with no cross-term.
 */

import type { StandingOrder } from '@bettertrack/contracts';

/** Horizon bounds the UI enforces; the engine clamps defensively to the same. */
export const FORECAST_HORIZON_MIN_YEARS = 1;
export const FORECAST_HORIZON_MAX_YEARS = 30;

/** A standing order normalized to the only facts the projection needs. */
export interface ForecastStandingOrder {
  /** Signed EUR flow per single occurrence (+ into net worth, − out of it). */
  amountEur: number;
  cadence: 'daily' | 'monthly';
  /** Day-of-month (1–31, clamped to month-end) for `monthly`; null for `daily`. */
  anchorDay: number | null;
  /** First fire date, ISO `YYYY-MM-DD`. */
  startDate: string;
  /** Last fire date inclusive, ISO `YYYY-MM-DD`, or null = open-ended. */
  endDate: string | null;
}

/** A hypothetical recurring investment overlaid on the base projection. */
export interface ForecastWhatIfPlan {
  /** Stable id — also the overlay series' id. */
  id: string;
  /** Display label for the overlay legend. */
  label: string;
  /** Monthly contribution in EUR (into net worth). */
  monthlyContributionEur: number;
  /** The plan's own annual return %/yr, or null to reuse the base return. */
  annualReturnPct: number | null;
}

/** The full, resolved input to one projection run. */
export interface ForecastInput {
  /** The "today" anchor, ISO `YYYY-MM-DD` — month 0 of the series. */
  asOf: string;
  /** Net worth today, EUR. */
  startingNetWorthEur: number;
  /** Projection horizon in whole years (clamped to 1..30). */
  horizonYears: number;
  /** Base annual return %/yr applied to the whole balance; 0 when the factor is off. */
  annualReturnPct: number;
  /** Active standing orders to continue forward; `[]` when the factor is off. */
  standingOrders: ForecastStandingOrder[];
  /** Projected monthly dividend income, EUR; 0 when the factor is off/unavailable. */
  monthlyDividendEur: number;
  /** What-if overlays (add/remove locally); `[]` for none. */
  whatIfPlans: ForecastWhatIfPlan[];
}

/** One point on a projected series. `date` is the month anchor, ISO `YYYY-MM-01`. */
export interface ForecastPoint {
  date: string;
  value: number;
}

/** A named projected series (the base line or one what-if overlay). */
export interface ForecastSeries {
  id: string;
  label: string;
  points: ForecastPoint[];
}

/** The projection result: the base line plus one overlay per what-if plan. */
export interface ForecastResult {
  base: ForecastPoint[];
  overlays: ForecastSeries[];
}

/** Geometric monthly-equivalent of an annual return %/yr (`0` maps to `0`). */
export function monthlyRateFromAnnualPct(annualPct: number): number {
  if (annualPct === 0) return 0;
  return Math.pow(1 + annualPct / 100, 1 / 12) - 1;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function parseIsoDate(iso: string): { year: number; month: number; day: number } {
  const [y, m, d] = iso.split('-').map((p) => Number.parseInt(p, 10));
  return { year: y || 1970, month: m || 1, day: d || 1 };
}

/** Number of days in `month` (1–12) of `year` — deterministic (UTC, no "now"). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Whole-day ordinal for an ISO day — deterministic (UTC, no "now"). */
function epochDay(iso: string): number {
  const { year, month, day } = parseIsoDate(iso);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

/** Advance `(year, month)` (month 1–12) by `add` months, normalizing the wrap. */
function addMonths(year: number, month: number, add: number): { year: number; month: number } {
  const zeroBased = year * 12 + (month - 1) + add;
  return { year: Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1 };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The signed EUR this order contributes during the calendar `year`/`month`:
 * one occurrence for `monthly` (on its clamped anchor day, if inside the
 * start/end window), or one per active day for `daily`. Zero when the order's
 * window does not overlap the month. `defaultAnchorDay` covers a `monthly` order
 * whose anchor is somehow absent (the asOf day-of-month).
 */
function standingOrderMonthAmount(
  order: ForecastStandingOrder,
  year: number,
  month: number,
  defaultAnchorDay: number,
): number {
  const lastDay = daysInMonth(year, month);
  const monthStart = isoDate(year, month, 1);
  const monthEnd = isoDate(year, month, lastDay);
  const { startDate, endDate } = order;

  // No overlap between [startDate, endDate] and this month → nothing fires.
  if (startDate > monthEnd) return 0;
  if (endDate !== null && endDate < monthStart) return 0;

  if (order.cadence === 'monthly') {
    const anchor = order.anchorDay ?? defaultAnchorDay;
    const occurrence = isoDate(year, month, Math.min(anchor, lastDay));
    if (occurrence < startDate) return 0;
    if (endDate !== null && occurrence > endDate) return 0;
    return order.amountEur;
  }

  // Daily: count the days of this month that fall inside [startDate, endDate].
  const firstActive = startDate > monthStart ? startDate : monthStart;
  const lastActive = endDate !== null && endDate < monthEnd ? endDate : monthEnd;
  const days = epochDay(lastActive) - epochDay(firstActive) + 1;
  return days > 0 ? order.amountEur * days : 0;
}

/**
 * Run one net-worth projection. Emits `12 · horizonYears + 1` monthly points on
 * the base line (index 0 = `asOf` at the starting value) and, for every what-if
 * plan, an overlay of the same length whose value is the base plus that plan's
 * standalone accumulation.
 */
export function projectNetWorth(input: ForecastInput): ForecastResult {
  const years = Math.max(
    FORECAST_HORIZON_MIN_YEARS,
    Math.min(FORECAST_HORIZON_MAX_YEARS, Math.round(input.horizonYears)),
  );
  const months = years * 12;
  const baseMonthlyRate = monthlyRateFromAnnualPct(input.annualReturnPct);
  const { year: y0, month: m0, day: d0 } = parseIsoDate(input.asOf);

  // Carry the balance at full precision; round only the emitted points so a
  // long horizon never accumulates rounding drift.
  const raw: number[] = [input.startingNetWorthEur];
  const base: ForecastPoint[] = [
    { date: isoDate(y0, m0, 1), value: round2(input.startingNetWorthEur) },
  ];

  let balance = input.startingNetWorthEur;
  for (let step = 1; step <= months; step++) {
    const { year, month } = addMonths(y0, m0, step);
    let contribution = input.monthlyDividendEur;
    for (const order of input.standingOrders) {
      contribution += standingOrderMonthAmount(order, year, month, d0);
    }
    balance = balance * (1 + baseMonthlyRate) + contribution;
    raw.push(balance);
    base.push({ date: isoDate(year, month, 1), value: round2(balance) });
  }

  const overlays: ForecastSeries[] = input.whatIfPlans.map((plan) => {
    const planRate = monthlyRateFromAnnualPct(plan.annualReturnPct ?? input.annualReturnPct);
    const points: ForecastPoint[] = [{ date: base[0]!.date, value: round2(raw[0]!) }];
    let accumulation = 0;
    for (let step = 1; step <= months; step++) {
      accumulation = accumulation * (1 + planRate) + plan.monthlyContributionEur;
      points.push({ date: base[step]!.date, value: round2(raw[step]! + accumulation) });
    }
    return { id: plan.id, label: plan.label, points };
  });

  return { base, overlays };
}

/**
 * Normalize the caller's standing orders into the projection's factor-1 input:
 * drops **paused** orders (only active orders continue forward) and drops
 * **buy-asset** orders (net-worth-neutral reallocations, see the module note),
 * mapping each cash order to its signed EUR flow.
 */
export function normalizeStandingOrders(orders: readonly StandingOrder[]): ForecastStandingOrder[] {
  const normalized: ForecastStandingOrder[] = [];
  for (const order of orders) {
    if (order.status !== 'active') continue;
    if (order.kind === 'buy-asset') continue;
    const sign = order.kind === 'cash-add' ? 1 : -1;
    normalized.push({
      amountEur: sign * order.amount,
      cadence: order.cadence,
      anchorDay: order.anchorDay,
      startDate: order.startDate,
      endDate: order.endDate,
    });
  }
  return normalized;
}
