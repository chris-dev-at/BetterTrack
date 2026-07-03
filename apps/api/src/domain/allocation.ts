/**
 * Invest Calculator allocation engine (PROJECTPLAN.md §6.7).
 *
 * A **pure** function that turns a Conglomerate's weighted positions plus a EUR
 * budget into a concrete buy list. Like the rest of `domain/**` this is
 * money-critical T1 code: it has **no imports of DB, HTTP, providers, or the
 * clock** — prices arrive already EUR-converted (§5.4), exactly as
 * `backtest.ts` receives pre-converted inputs, and the engine does no FX.
 *
 * **Hard guarantee: `totalCostEur ≤ budgetEur`. Never overshoot.** Every
 * candidate purchase — the initial floors and each greedy fill — is admitted by
 * an exact floating-point `Σ cost ≤ budget` comparison over the same
 * per-position cost values that are reported back, so the invariant holds
 * bit-for-bit in every branch, not merely "within tolerance".
 *
 * **Whole-share mode (§6.7 steps 1–5).**
 *  1. `targetᵢ = B · wᵢ` (weights normalised to sum to exactly 1).
 *  2. `qtyᵢ = floor(targetᵢ / pᵢ)` — never above target.
 *  3. `leftover = B − Σ qtyᵢ·pᵢ`.
 *  4. Greedy fill: while an *affordable* share exists whose purchase **strictly
 *     reduces** `Σᵢ |actualᵢ − targetᵢ|`, buy 1 share of the most-reducing one
 *     (tie-break: larger target weight first, then input order). The
 *     strictness is §6.7's own worked example: with 100 € leftover and BAYN at
 *     25 € affordable, the plan still ends at "900 € spent, 100 € left" —
 *     buying past target when it only worsens the deviation is not a fill.
 *  5. Emit per-position qty, cost, actual % vs target %, Δpp; totals + leftover.
 *
 * **Fractional mode.** `qtyᵢ = (B·wᵢ)/pᵢ` rounded **down** to the step
 * ({@link DEFAULT_FRACTIONAL_STEP} when omitted) ⇒ spend ≈ B minus dust. There
 * is no greedy pass — rounding down already lands each position within one
 * `step·price` of its target.
 *
 * **Precision (§5.4).** No rounding mid-computation: every returned figure is
 * full `number` precision and display rounding lives in the display layer. The
 * only rounded values are the € figures embedded in human-readable notes.
 * Quantity floors are taken with a tiny epsilon ({@link epsilonFloor}) so a
 * quantity that *mathematically* reaches an integer/step boundary is not
 * dropped a whole share by FP division noise; the budget checks stay exact
 * regardless. `Σ positions[].costEur === totalCostEur` exactly, and
 * `totalCostEur + leftoverEur` equals `budgetEur` up to one FP subtraction
 * (≪ 1e-9 relative).
 *
 * **Unreachable weights are surfaced, never silently mis-weighted** (§6.7): a
 * positive-weight position that ends at qty 0 carries a note naming its price,
 * its `B·wᵢ` slice, and the ≈ minimum budget (`pᵢ/wᵢ`) that would reach it —
 * e.g. "GOOGL share price (140 €) exceeds its 100 € slice; raise the budget to
 * ≥ ~1400 € or use fractional mode." The same notes are aggregated in
 * `warnings`.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default fractional-mode quantity step (§6.7 "e.g. 0.0001") when `step` is omitted. */
export const DEFAULT_FRACTIONAL_STEP = 0.0001;

/**
 * How far the position weights may deviate from summing to 1. Weights are
 * stored at `numeric(6,3)` percent precision (§5.5), so a three-way
 * 33.333 % split sums to 0.99999 — legitimate inputs are only ever off by
 * rounding at the third percent decimal, never by whole points.
 */
export const WEIGHT_SUM_TOLERANCE = 1e-3;

/**
 * Granularity for comparing deviation reductions in the greedy fill:
 * differences within this are FP noise from weight normalisation and count as
 * equal, and a "reduction" this small counts as zero (no fill). Far below any
 * real € deviation, far above accumulated double noise.
 */
const REDUCTION_EPS = 1e-9;

const FLOOR_EPS_ABS = 1e-9;
const FLOOR_EPS_REL = 1e-12;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Invalid allocation input — non-finite/negative budget or prices, weights
 * that do not sum to ~1, an empty basket, a non-positive step. A typed error
 * so the API can map caller mistakes to a 4xx instead of a 500; the engine
 * never silently mis-weights (§6.7).
 */
export class AllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllocationError';
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type AllocationMode = 'whole' | 'fractional';

/** One conglomerate position as the calculator sees it: identity, target weight, EUR quote. */
export interface AllocationPositionInput {
  assetId: string;
  /** Ticker symbol, used in human-readable notes. */
  symbol: string;
  /**
   * Target weight as a fraction of the basket (0.3 = 30 %). The basket must
   * sum to ~1 (± {@link WEIGHT_SUM_TOLERANCE}); weights are normalised to sum
   * to exactly 1 before targets are computed.
   */
  weight: number;
  /** Current quote, already converted to EUR (§5.4). Finite and > 0. */
  priceEur: number;
}

export interface AllocationInput {
  /** Budget B in EUR; finite and ≥ 0. */
  budgetEur: number;
  /** `whole` = integer share counts (§6.7 greedy fill); `fractional` = round down to `step`. */
  mode: AllocationMode;
  /**
   * Fractional-mode quantity step, e.g. 0.0001 = buy in ten-thousandths of a
   * share. Defaults to {@link DEFAULT_FRACTIONAL_STEP}; must be finite and > 0
   * when given. Ignored in whole mode.
   */
  step?: number;
  /** Basket positions; at least one. */
  positions: readonly AllocationPositionInput[];
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/** One buy-list row. Quantities/costs are full precision; rounding is the display layer's job. */
export interface AllocationLine {
  assetId: string;
  symbol: string;
  /** Shares to buy: an integer in whole mode, a multiple of the step in fractional mode. */
  qty: number;
  /** `qty · priceEur`, full precision. */
  costEur: number;
  /** Achieved share of the *budget*, percent (`costEur / B · 100`; 0 when B = 0). */
  actualPct: number;
  /** Normalised target weight, percent (`wᵢ · 100`). */
  targetPct: number;
  /** `actualPct − targetPct`, percentage points. */
  deltaPp: number;
  /**
   * The position cannot be bought at all within this budget: its minimum
   * increment (one share, or one step in fractional mode) costs more than B.
   */
  unbuyable?: boolean;
  /**
   * §6.7-style human explanation for a positive-weight position left at qty 0,
   * naming its price, its slice, and the ≈ minimum budget that would reach it.
   */
  note?: string;
}

export interface AllocationResult {
  /** One line per input position, input order preserved. */
  positions: AllocationLine[];
  /** Exact sum of `positions[].costEur`; guaranteed ≤ `budgetEur` (never overshoot). */
  totalCostEur: number;
  /** `budgetEur − totalCostEur`; ≥ 0. */
  leftoverEur: number;
  /** Aggregated position notes (unreachable/unbuyable weights) for a banner. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `Math.floor` with a tolerance for floating-point division noise: a value
 * within 1e-9 (absolute, plus 1e-12 relative) *below* an integer counts as
 * that integer, so a mathematically exact quantity like `5 / 0.0001` is not
 * dropped a whole step when FP division lands at 49 999.999999999996. The
 * budget invariant never relies on this — every candidate sum still passes an
 * exact `≤ budget` comparison afterwards.
 */
function epsilonFloor(x: number): number {
  return Math.floor(x + FLOOR_EPS_ABS + Math.abs(x) * FLOOR_EPS_REL);
}

/** €-figure for a human-readable note: rounded to cents, trailing zeros trimmed. Display-only. */
function fmtEur(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** Mutable working state for one position. `k` counts bought increments (shares, or steps). */
interface PositionState {
  assetId: string;
  symbol: string;
  priceEur: number;
  /** Normalised weight (the basket sums to exactly 1). */
  weight: number;
  /** `targetᵢ = B · wᵢ`, EUR. */
  targetEur: number;
  /** Bought increments; `qty = k · step` (step = 1 in whole mode). */
  k: number;
  /** `(k · step) · priceEur` — always the exact FP product for the current `k`. */
  costEur: number;
}

/**
 * Exact total cost, always summed in input order so the value checked against
 * the budget is bit-identical to the one reported. `replace`/`replacementCost`
 * evaluate a candidate purchase without mutating state.
 */
function totalCostOf(
  states: readonly PositionState[],
  replace?: PositionState,
  replacementCost?: number,
): number {
  let sum = 0;
  for (const s of states) {
    sum += s === replace && replacementCost !== undefined ? replacementCost : s.costEur;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Turn a weighted basket plus a EUR budget into a buy list (§6.7). See the
 * module header for the method and the never-overshoot guarantee. Throws
 * {@link AllocationError} on invalid input — up-front, before any allocation.
 */
export function allocateBudget(input: AllocationInput): AllocationResult {
  const { budgetEur, mode, positions } = input;

  // --- Fail-loud validation (mirrors backtest.ts: everything checked up front).
  if (!Number.isFinite(budgetEur) || budgetEur < 0) {
    throw new AllocationError(`budgetEur must be a finite non-negative number, got ${budgetEur}.`);
  }
  if (mode !== 'whole' && mode !== 'fractional') {
    throw new AllocationError(`mode must be 'whole' or 'fractional', got ${String(mode)}.`);
  }
  if (input.step !== undefined && (!Number.isFinite(input.step) || input.step <= 0)) {
    throw new AllocationError(`step must be a finite positive number, got ${input.step}.`);
  }
  if (positions.length === 0) {
    throw new AllocationError('allocateBudget requires at least one position.');
  }
  const seen = new Set<string>();
  let weightSum = 0;
  for (const pos of positions) {
    if (seen.has(pos.assetId)) {
      throw new AllocationError(`Duplicate position assetId ${pos.assetId}.`);
    }
    seen.add(pos.assetId);
    if (!Number.isFinite(pos.weight) || pos.weight < 0) {
      throw new AllocationError(
        `Position weight for ${pos.symbol} must be a finite non-negative number, got ${pos.weight}.`,
      );
    }
    if (!Number.isFinite(pos.priceEur) || pos.priceEur <= 0) {
      throw new AllocationError(
        `Price for ${pos.symbol} must be a finite positive number of EUR, got ${pos.priceEur}.`,
      );
    }
    weightSum += pos.weight;
  }
  if (Math.abs(weightSum - 1) > WEIGHT_SUM_TOLERANCE) {
    throw new AllocationError(
      `Position weights must sum to ~1 (±${WEIGHT_SUM_TOLERANCE}), got ${weightSum}.`,
    );
  }

  // In whole mode the increment is exactly 1 share, so `qty = k · step` is exact.
  const step = mode === 'fractional' ? (input.step ?? DEFAULT_FRACTIONAL_STEP) : 1;

  // --- Steps 1–2: targets and floored quantities (never above target).
  const states: PositionState[] = positions.map((pos) => {
    const weight = pos.weight / weightSum;
    const targetEur = budgetEur * weight;
    const k = epsilonFloor(targetEur / pos.priceEur / step);
    return {
      assetId: pos.assetId,
      symbol: pos.symbol,
      priceEur: pos.priceEur,
      weight,
      targetEur,
      k,
      costEur: k * step * pos.priceEur,
    };
  });

  // FP backstop: mathematically Σ qtyᵢ·pᵢ ≤ Σ targetᵢ = B, but the epsilon
  // floor / normalisation can nudge the FP sum a hair over B. Shave the
  // cheapest increment until the exact check passes (in practice: never runs).
  let total = totalCostOf(states);
  while (total > budgetEur) {
    let cheapest: PositionState | null = null;
    for (const s of states) {
      if (s.k > 0 && (cheapest === null || s.priceEur < cheapest.priceEur)) cheapest = s;
    }
    if (cheapest === null) break; // unreachable: total is 0 ≤ budget once everything is at 0
    cheapest.k -= 1;
    cheapest.costEur = cheapest.k * step * cheapest.priceEur;
    total = totalCostOf(states);
  }

  // --- Step 4 (whole mode only): greedy leftover fill.
  if (mode === 'whole') {
    for (;;) {
      let best: PositionState | null = null;
      let bestReduction = 0;
      let bestCost = 0;
      for (const s of states) {
        const nextCost = (s.k + 1) * s.priceEur;
        // Affordability is the exact reported-sum comparison — never overshoot.
        if (totalCostOf(states, s, nextCost) > budgetEur) continue;
        const reduction = Math.abs(s.costEur - s.targetEur) - Math.abs(nextCost - s.targetEur);
        // Must *strictly* reduce Σ|actual − target| (§6.7 worked example: an
        // affordable share that only overshoots its target is not a fill).
        if (reduction <= REDUCTION_EPS) continue;
        if (
          best === null ||
          reduction > bestReduction + REDUCTION_EPS ||
          (reduction >= bestReduction - REDUCTION_EPS && s.weight > best.weight)
        ) {
          best = s;
          bestReduction = reduction;
          bestCost = nextCost;
        }
      }
      if (best === null) break;
      best.k += 1;
      best.costEur = bestCost;
      total = totalCostOf(states);
    }
  }

  // --- Step 5: emit lines, totals, and unreachable-weight notes.
  const warnings: string[] = [];
  const lines: AllocationLine[] = states.map((s) => {
    const qty = s.k * step;
    const actualPct = budgetEur > 0 ? (s.costEur / budgetEur) * 100 : 0;
    const targetPct = s.weight * 100;
    const line: AllocationLine = {
      assetId: s.assetId,
      symbol: s.symbol,
      qty,
      costEur: s.costEur,
      actualPct,
      targetPct,
      deltaPp: actualPct - targetPct,
    };

    const minIncrementCost = mode === 'whole' ? s.priceEur : step * s.priceEur;
    if (minIncrementCost > budgetEur) line.unbuyable = true;

    // qty 0 with a positive weight ⇔ the slice B·wᵢ is below one increment —
    // surfaced explicitly, never silently mis-weighted (§6.7).
    if (s.k === 0 && s.weight > 0) {
      line.note =
        mode === 'whole'
          ? `${s.symbol} share price (${fmtEur(s.priceEur)} €) exceeds its ${fmtEur(
              s.targetEur,
            )} € slice; raise the budget to ≥ ~${fmtEur(s.priceEur / s.weight)} € or use fractional mode.`
          : `${s.symbol}: one ${step}-share step (${fmtEur(step * s.priceEur)} €) exceeds its ${fmtEur(
              s.targetEur,
            )} € slice; raise the budget to ≥ ~${fmtEur((step * s.priceEur) / s.weight)} €.`;
      warnings.push(line.note);
    }
    return line;
  });

  return {
    positions: lines,
    totalCostEur: total,
    leftoverEur: budgetEur - total,
    warnings,
  };
}
