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
 * ── One rate convention for the whole tab (#1892) ────────────────────────────
 * That makes every %/yr the Forecast speaks in an **effective annual** rate, and
 * it is the tab's ONLY convention: `calc.ts` derives each of its per-period
 * rates through {@link periodRateFromAnnualPct} instead of dividing nominally,
 * so one annual percentage typed into the compound-interest card and sampled
 * into this projection answers the same question with the same number. The two
 * used to disagree by 5.7 % on €100,000 over 20 years, because a nominal 8 %
 * re-compounded twelve times a year is 8.30 % effective — and the figure they
 * were both fed is a CAGR, an effective rate by definition.
 *
 * ── Net-worth semantics of standing orders (design decision, §16-style) ──────
 * The series tracks **net worth** — `marketValue + cash`, exactly what
 * `portfolioService`'s `computeTotals` sums into `totalValueEur` — so a factor
 * moves the line only insofar as it moves that figure:
 *   • `cash-add` ("salary")   → **+** flow  — new external money entering.
 *   • `cash-deduct` ("Netflix")→ **−** flow — money leaving to spend.
 *   • `buy-asset` (a recurring buy) → **+** flow of `quantity × unit price`
 *     (#1892). A buy is NOT a reallocation of cash the book already holds:
 *     **no engine debits that cash.** The server's
 *     `standingOrderService.bookRow` inserts the BUY transaction with an
 *     explicitly empty `cashMovements: []` ("Buys never touch cash"), and the
 *     vault twin takes the same branch — its `standingOrderRowKind` answers
 *     `transaction` for a buy and `cashMovement` only for the cash kinds. Market
 *     value therefore rises by the full purchase value while cash is untouched,
 *     and recorded net worth rises with it. The projection states what the
 *     engines will record: excluded, a €500/month plan projected €0 over a
 *     20-year horizon where the scheduler will book ~€120,000 of cost plus its
 *     growth — for the single most common order type §6.14 names.
 * A what-if plan remains the tool for investment the schedule does NOT hold yet
 * ("what if I invest €200/month"); a standing order is money that will be booked.
 *
 * ── Factor composition: a return already contains the distributions (#1892) ──
 * `annualReturnPct` is a TOTAL return — the tab samples it from the portfolio's
 * own TWR — and a `dividend` is deliberately INTERNAL to that curve
 * (`packages/domain/src/cashLedger.ts`: `EXTERNAL_CASH_MOVEMENT_KINDS` is
 * deposit/withdrawal only, because "counting it as a deposit would neutralize it
 * out of the performance curve and understate the true return"). Projected
 * dividend income is therefore ALREADY inside the line the return factor draws,
 * and adding it again as a second monthly contribution counts the same euro
 * twice — ~32 % high on a €100,000 book at 7 %/yr with a 3 % yield over twenty
 * years, in the state both factors ship ON.
 *
 * The rule: {@link ForecastInput.monthlyDividend} is a contribution ONLY when
 * the run makes no return assumption at all — `annualReturnPct === null`, which
 * is what the tab hands the engine while the return factor is off. A return
 * factor that is on carries the income already, including at 0 %/yr (a 0 %
 * TOTAL return says the distributions are offset by price decline, not that
 * there are none). {@link returnFactorContainsDistributions} is that rule's one
 * owner, so the view can explain the composition it renders without restating
 * it. Standing orders stack on top in both states: they are EXTERNAL money,
 * which a time-weighted return excludes by construction (#1759).
 *
 * What-if plans are additional contribution streams that do NOT change the base
 * line: each renders as its own overlay = base + the plan's standalone
 * accumulation (its monthly contribution compounded at the plan's own return, or
 * the base return when it names none). Because a fixed-rate system is linear in
 * its flows, "base AND this plan" is exactly base + plan with no cross-term.
 *
 * ── Denomination (#1741, #1759) ──────────────────────────────────────────────
 * The engine is **currency-agnostic**: it converts nothing and knows no rate, so
 * every amount it emits is denominated in whatever its inputs were. That makes
 * the caller responsible for handing it ONE denomination — the user's base
 * currency (§5.4), which is what the starting net worth and the rendered symbol
 * both use. The fields therefore no longer carry an `…Eur` suffix: the projected
 * dividend income used to arrive pinned to EUR and was added straight to a
 * base-denominated balance, so a USD user's curve summed two currencies and
 * rendered the total with one symbol.
 *
 * Standing orders are NOT base-denominated at the source — a cash order's
 * `amount` is a EUR magnitude by contract, and a buy's `amount` is a share
 * QUANTITY that only a unit price turns into money — so the gate that keeps the
 * run single-denomination lives in {@link normalizeStandingOrders}, which
 * refuses any order, of any kind, whose currency is not the base rather than
 * letting the engine mix, and prices a buy from the caller's own portfolio read
 * (the same base-currency holdings the starting net worth is summed from).
 */

import type { StandingOrder } from '@bettertrack/contracts';

/** Horizon bounds the UI enforces; the engine clamps defensively to the same. */
export const FORECAST_HORIZON_MIN_YEARS = 1;
export const FORECAST_HORIZON_MAX_YEARS = 30;

/** Return bounds the UI enforces; the engine clamps defensively to the same. */
export const FORECAST_RETURN_MIN_PCT = -100;
export const FORECAST_RETURN_MAX_PCT = 100;

/** A standing order normalized to the only facts the projection needs. */
export interface ForecastStandingOrder {
  /**
   * Signed flow per single occurrence, base currency (+ into net worth, − out
   * of it). A buy's share quantity is already priced into money here.
   */
  amount: number;
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
  /** Monthly contribution in the base currency (into net worth). */
  monthlyContribution: number;
  /** The plan's own annual return %/yr, or null to reuse the base return. */
  annualReturnPct: number | null;
}

/** The full, resolved input to one projection run. */
export interface ForecastInput {
  /** The "today" anchor, ISO `YYYY-MM-DD` — month 0 of the series. */
  asOf: string;
  /** Net worth today, in the caller's base currency — the denomination of the whole run. */
  startingNetWorth: number;
  /** Projection horizon in whole years (clamped to 1..30). */
  horizonYears: number;
  /**
   * Base annual TOTAL return %/yr applied to the whole balance, or `null` when
   * the return factor is off. `null` is NOT the same statement as `0`: a 0 %
   * total return is an assumption about the market (distributions offset by
   * price decline) and still carries the book's income, while `null` is the
   * absence of any return assumption — see the composition rule in the module
   * note and {@link returnFactorContainsDistributions}.
   */
  annualReturnPct: number | null;
  /** Active standing orders to continue forward; `[]` when the factor is off. */
  standingOrders: ForecastStandingOrder[];
  /**
   * Projected monthly dividend income in the SAME base currency as
   * {@link ForecastInput.startingNetWorth}; 0 when the factor is off, unavailable
   * or denominated in anything else (§5.4 — never sum two denominations).
   *
   * Counted as a contribution ONLY when {@link ForecastInput.annualReturnPct} is
   * `null`. With a return assumption in play the income is already inside that
   * curve, so adding it here would book the same euro twice (#1892).
   */
  monthlyDividend: number;
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

/**
 * Clamp a return-rate input to the range the Forecast model can represent.
 * A loss beyond -100 % would make the geometric monthly-rate calculation take
 * a fractional power of a negative number, which is not a real number.
 */
export function clampForecastReturnPct(annualPct: number): number {
  if (!Number.isFinite(annualPct)) return 0;
  return Math.max(FORECAST_RETURN_MIN_PCT, Math.min(FORECAST_RETURN_MAX_PCT, annualPct));
}

/**
 * Geometric per-period equivalent of an annual return %/yr (`0` maps to `0`):
 * `periodsPerYear` compounds of the result reproduce the annual figure exactly.
 * This is the tab's one rate convention — `calc.ts` solves against this same
 * function, so a rate means the same thing in a calculator card and in the
 * projection (see the module note). A non-positive `periodsPerYear` reads as
 * annual compounding rather than dividing by zero.
 */
export function periodRateFromAnnualPct(annualPct: number, periodsPerYear: number): number {
  const clampedAnnualPct = clampForecastReturnPct(annualPct);
  if (clampedAnnualPct === 0) return 0;
  const periods = Number.isFinite(periodsPerYear) && periodsPerYear > 0 ? periodsPerYear : 1;
  return Math.pow(1 + clampedAnnualPct / 100, 1 / periods) - 1;
}

/** Geometric monthly-equivalent of an annual return %/yr (`0` maps to `0`). */
export function monthlyRateFromAnnualPct(annualPct: number): number {
  return periodRateFromAnnualPct(annualPct, 12);
}

/**
 * Whether a run with this return factor ALREADY contains the income the
 * dividend factor projects — the one owner of the composition rule stated in
 * the module note. Any return assumption is a total return and carries the
 * distributions; only "no return factor at all" (`null`) leaves them to be
 * added as their own flow.
 */
export function returnFactorContainsDistributions(annualReturnPct: number | null): boolean {
  return annualReturnPct !== null;
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
 * The signed base-currency amount this order contributes during `year`/`month`:
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
    return order.amount;
  }

  // Daily: count the days of this month that fall inside [startDate, endDate].
  const firstActive = startDate > monthStart ? startDate : monthStart;
  const lastActive = endDate !== null && endDate < monthEnd ? endDate : monthEnd;
  const days = epochDay(lastActive) - epochDay(firstActive) + 1;
  return days > 0 ? order.amount * days : 0;
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
  const baseMonthlyRate = monthlyRateFromAnnualPct(input.annualReturnPct ?? 0);
  // The composition rule (#1892): a return assumption already carries the book's
  // distributions, so the projected income is a flow of its own only when there
  // is no return factor at all. Resolved once, outside the loop.
  const monthlyDividend = returnFactorContainsDistributions(input.annualReturnPct)
    ? 0
    : input.monthlyDividend;
  const { year: y0, month: m0, day: d0 } = parseIsoDate(input.asOf);

  // Carry the balance at full precision; round only the emitted points so a
  // long horizon never accumulates rounding drift.
  const raw: number[] = [input.startingNetWorth];
  const base: ForecastPoint[] = [
    { date: isoDate(y0, m0, 1), value: round2(input.startingNetWorth) },
  ];

  let balance = input.startingNetWorth;
  for (let step = 1; step <= months; step++) {
    const { year, month } = addMonths(y0, m0, step);
    let contribution = monthlyDividend;
    for (const order of input.standingOrders) {
      contribution += standingOrderMonthAmount(order, year, month, d0);
    }
    balance = balance * (1 + baseMonthlyRate) + contribution;
    raw.push(balance);
    base.push({ date: isoDate(year, month, 1), value: round2(balance) });
  }

  const overlays: ForecastSeries[] = input.whatIfPlans.map((plan) => {
    const planRate = monthlyRateFromAnnualPct(plan.annualReturnPct ?? input.annualReturnPct ?? 0);
    const points: ForecastPoint[] = [{ date: base[0]!.date, value: round2(raw[0]!) }];
    let accumulation = 0;
    for (let step = 1; step <= months; step++) {
      accumulation = accumulation * (1 + planRate) + plan.monthlyContribution;
      points.push({ date: base[step]!.date, value: round2(raw[step]! + accumulation) });
    }
    return { id: plan.id, label: plan.label, points };
  });

  return { base, overlays };
}

/** A current unit price for one asset, as the caller's portfolio read states it. */
export interface ForecastAssetPrice {
  /** Price per unit, denominated in {@link ForecastAssetPrice.currency}. */
  price: number;
  /** The currency that price is quoted in (the asset's own). */
  currency: string;
}

/** What {@link normalizeStandingOrders} could and could not put on the curve. */
export interface NormalizedStandingOrders {
  /**
   * The orders that continue forward, every one of them denominated in the
   * base currency that was passed in — safe to hand straight to the engine.
   */
  orders: ForecastStandingOrder[];
  /**
   * Currencies found on effective-active orders that are NOT the projection's
   * base, deduped and sorted. Non-empty ⇒ `orders` is empty and the factor
   * cannot be resolved: this engine converts nothing, and the caller must say
   * so rather than quietly project a smaller set (see the module note on
   * denomination).
   */
  foreignCurrencies: string[];
  /**
   * Assets whose recurring buy could not be valued — no current unit price was
   * handed in for them — named by symbol (falling back to name, then id),
   * deduped and sorted. Non-empty ⇒ `orders` is empty, on the same
   * all-or-nothing rule as {@link NormalizedStandingOrders.foreignCurrencies}:
   * a buy books money the schedule will really spend, so dropping the one it
   * cannot price would draw a quietly smaller curve with nothing to explain it.
   */
  unpricedAssets: string[];
}

/**
 * Normalize the caller's standing orders into the projection's factor-1 input:
 * drops **paused** and archive-suspended orders (only effective-active orders
 * continue forward), maps each cash order to its signed flow, and values each
 * **buy-asset** order at the money its booking will record — `amount` is a share
 * QUANTITY for that kind, so `quantity × unit price` is the net-worth flow (see
 * the module note on what the booking engines actually write).
 *
 * `baseCurrency` is the denomination of the run the flows will join — the same
 * base the starting net worth is in. A cash order carries a EUR magnitude by
 * contract (`packages/contracts/src/standingOrders.ts`: the server derives
 * `currency` and books the cash leg into the EUR ledger), so for a non-EUR base
 * the two disagree and adding the amount 1:1 would be the #1741 defect again —
 * 3.000 € booked as 3.000 CHF, every month, compounded for up to 30 years. A
 * buy carries the ASSET's native currency for the same reason, and its price is
 * quoted in that currency too. Rather than mix denominations, such an order is
 * refused through the one path both kinds share: it is reported in
 * {@link NormalizedStandingOrders.foreignCurrencies} and the factor as a whole
 * resolves to nothing (all-or-nothing, like the dividend total in #1616) so the
 * caller can name the reason instead of drawing a silently smaller curve.
 *
 * `assetPrices` maps `assetId` → its current unit price, as the caller's own
 * portfolio read states it. A buy whose asset is not in there (or is priced at
 * nothing) cannot be valued at all and lands in
 * {@link NormalizedStandingOrders.unpricedAssets}, refusing the factor on that
 * same all-or-nothing rule.
 */
export function normalizeStandingOrders(
  orders: readonly StandingOrder[],
  baseCurrency: string,
  assetPrices: ReadonlyMap<string, ForecastAssetPrice>,
): NormalizedStandingOrders {
  const normalized: ForecastStandingOrder[] = [];
  const foreign = new Set<string>();
  const unpriced = new Set<string>();
  for (const order of orders) {
    if (order.status !== 'active') continue;
    if (order.suspendedByArchive === true) continue;
    if (order.currency !== baseCurrency) {
      foreign.add(order.currency);
      continue;
    }
    let amount: number;
    if (order.kind === 'buy-asset') {
      const quote = order.assetId === null ? undefined : assetPrices.get(order.assetId);
      // The price is the operand that would join the balance, so it takes the
      // same base gate the order's own currency just took.
      if (quote !== undefined && quote.currency !== baseCurrency) {
        foreign.add(quote.currency);
        continue;
      }
      if (quote === undefined || !Number.isFinite(quote.price) || quote.price <= 0) {
        unpriced.add(order.assetSymbol ?? order.assetName ?? order.assetId ?? order.id);
        continue;
      }
      amount = order.amount * quote.price;
    } else {
      amount = (order.kind === 'cash-add' ? 1 : -1) * order.amount;
    }
    normalized.push({
      amount,
      cadence: order.cadence,
      anchorDay: order.anchorDay,
      startDate: order.startDate,
      endDate: order.endDate,
    });
  }
  const foreignCurrencies = [...foreign].sort();
  const unpricedAssets = [...unpriced].sort();
  const resolved = foreignCurrencies.length === 0 && unpricedAssets.length === 0;
  return { orders: resolved ? normalized : [], foreignCurrencies, unpricedAssets };
}
