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
 * **At-least-one-share mode (opt-in, default OFF; whole mode only).** With
 * `atLeastOneShare` set, positions whose slice `B·wᵢ` cannot afford one whole
 * share (`floor(targetᵢ/pᵢ) = 0`, `wᵢ > 0`) and whose price fits the budget are
 * each granted exactly **one** share *before* the floor step — admitted largest
 * target weight first (ties: input order) by the same exact `Σ cost ≤ budget`
 * comparison, so forcing can never overshoot. A candidate that no longer fits
 * is skipped, never forced — dropping the least-affordable rather than blowing
 * B — while cheaper lower-weight candidates may still fit. A price above the
 * whole budget stays flagged unbuyable, never forced. The remainder
 * `B′ = B − Σ forced` then rebalances across the non-forced positions by their
 * weights (`targetⱼ = B′·wⱼ/Σ_rest w`) through the normal floor + greedy fill;
 * forced positions keep exactly their one share (the greedy fill and the FP
 * backstop never touch them). With the flag OFF — or in fractional mode, where
 * it is ignored — the engine behaves bit-for-bit as without it.
 *
 * **The flag never deploys less capital than the flag-off plan (#1778).**
 * Granting a single share shrinks every other slice, and a shrunk slice can
 * drop a position a whole share — sometimes more money than the granted share
 * puts to work, up to and including zeroing the basket's dominant leg
 * (B = 1000 €, A 90 % @ 900 €, B 10 % @ 150 €: forcing B left A at qty 0, 150 €
 * invested and 850 € of the budget out of the market). Spec-literal, but the
 * inverse of §6.7's own "larger target weight first" priority. So the engine
 * plans the flag-off allocation **first** and uses its `Σ cost` as a floor: a
 * forced plan is accepted only when it deploys at least as much. When it does
 * not, the **smallest-weight** granted single is dropped (largest weight keeps
 * its priority) and the plan re-runs, retreating one single at a time down to
 * the flag-off plan itself. Positions left unreached by that retreat are
 * flagged with a reachable minimum budget (below), never silently mis-weighted.
 *
 * **Fractional mode.** `qtyᵢ = (B·wᵢ)/pᵢ` rounded **down** to the step
 * ({@link DEFAULT_FRACTIONAL_STEP} when omitted) ⇒ spend ≈ B minus dust. There
 * is no greedy pass — rounding down already lands each position within one
 * `step·price` of its target.
 *
 * **Precision (§5.4).** No rounding mid-computation: every returned figure is
 * full `number` precision and display rounding lives in the display layer. The
 * only rounded values are the € figures embedded in human-readable notes.
 * Quantity floors are taken with a *relative* epsilon ({@link epsilonFloor}) so
 * a quantity that mathematically reaches an integer/step boundary is not
 * dropped a whole share by FP division noise, while a ratio genuinely below the
 * boundary still floors down (§6.7 is an unconditional `floor`); the budget
 * checks stay exact regardless. `Σ positions[].costEur === totalCostEur`
 * exactly, and `totalCostEur + leftoverEur` equals `budgetEur` up to one FP
 * subtraction (≪ 1e-9 relative).
 *
 * **Unreachable weights are surfaced, never silently mis-weighted** (§6.7): a
 * positive-weight position that ends at qty 0 carries a note naming its price,
 * its slice, and the ≈ minimum budget that would reach it — e.g. "GOOGL share
 * price (140 €) exceeds its 100 € slice; raise the budget to ≥ ~1400 € or use
 * fractional mode." That figure is a budget at which re-running **this same
 * call** actually buys the position, not a bare `pᵢ/wᵢ`: with `atLeastOneShare`
 * on, `pᵢ/wᵢ` can be a budget the force pass still refuses (#1778), so the
 * engine walks a small ladder of derived figures — "grant my share without
 * taking a floor anyone else earned" (`pᵢ + Σⱼ≠ᵢ floorⱼ`), the rebalanced-slice
 * threshold (`pᵢ·Σ_rest w/wᵢ + Σ forced`), and `pᵢ/wᵢ` — smallest first, each
 * **verified by an actual re-plan**, and falls back to `pᵢ/wᵢ + Σⱼ pⱼ`, which
 * is reachable by construction (every forced single plus the position's own
 * full slice fit inside it). Figures are rounded **up** to cents, so the
 * printed number is itself sufficient. The same notes are aggregated in
 * `warnings`.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default fractional-mode quantity step (§6.7 "e.g. 0.0001") when `step` is omitted. */
export const DEFAULT_FRACTIONAL_STEP = 0.0001;

/**
 * How far the position weights may deviate from summing to 1: §6.5's
 * "status `active` requires Σ weights = 100 ± 0.01" expressed as a fraction —
 * the same contract `conglomerateService` enforces on write (`SUM_TOLERANCE =
 * 0.01` percent). Weights are stored at `numeric(6,3)` percent precision
 * (§5.5), so a three-way 33.333 % split sums to 0.99999 — legitimate inputs are
 * only ever off by rounding at the third percent decimal, an order of magnitude
 * inside this bound.
 */
export const WEIGHT_SUM_TOLERANCE = 1e-4;

/**
 * Granularity for comparing deviation reductions in the greedy fill:
 * differences within this are FP noise from weight normalisation and count as
 * equal, and a "reduction" this small counts as zero (no fill). Far below any
 * real € deviation, far above accumulated double noise.
 */
const REDUCTION_EPS = 1e-9;

/**
 * Relative tolerance of the quantity floor — see {@link epsilonFloor}. Purely
 * relative: an absolute tolerance on a *ratio* would floor `1.9999999995`
 * (a 250.0000000625 € share against a 500 € slice) up to 2 and buy a share the
 * slice cannot pay for (#1778).
 */
const FLOOR_EPS_REL = 1e-12;

/**
 * How many granted singles the at-least-one-share retreat may drop before it
 * gives up and keeps the flag-off plan. Bounds one allocation at `1 + this`
 * plans, and — just as important — keeps a plan a pure function of its budget:
 * the note probes below re-plan through the same path, so their verdict must
 * not depend on how much planning earlier notes already did.
 */
const MAX_FORCE_RETREATS = 8;

/**
 * Note figures are verified by re-planning at the candidate budget (module
 * header). Bound that extra work: at most this many probes per call, and none
 * at all for a basket near the 250-position flatten cap, where a re-plan is
 * expensive. Unprobed notes take the provably-reachable fallback figure, which
 * needs no probe — correctness never depends on the bound.
 */
const MAX_NOTE_PROBES = 12;
const MAX_PROBED_POSITIONS = 40;

/** Shared empty force set — the flag-off plan. */
const NO_FORCED: ReadonlySet<string> = new Set<string>();

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
  /**
   * Opt-in "at least one share" mode (default OFF; whole mode only, ignored in
   * fractional mode). When true, a positive-weight position whose slice `B·wᵢ`
   * cannot afford one whole share — but whose price fits the budget — gets
   * exactly one share (largest target weight first, never overshooting B), and
   * the remainder rebalances across the rest by their weights. A share price
   * above the whole budget stays flagged unbuyable, never forced, and granting
   * singles never deploys less capital than the flag-off plan (module header).
   */
  atLeastOneShare?: boolean;
  /**
   * ISO code of the currency `budgetEur` and every `priceEur` are denominated
   * in — the caller's base (§5.4), EUR when omitted. **Display only**: the
   * engine does no FX, it only needs the label so a note it renders names the
   * money the run is actually made of (#1831). Carried onto every
   * {@link UnreachableWeight} so a caller restating a note gets the same
   * spelling.
   */
  currency?: string;
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
   * Exactly `unreachableWeightNote(line.unreachable)`.
   */
  note?: string;
  /**
   * The structured facts behind {@link AllocationLine.note}, present whenever it
   * is. Everything here is denominated in the `budgetEur` THIS call was given —
   * so a caller that scaled the budget down before calling (the Invest
   * Calculator withholds an unresolved nested share, #1811) must restate the
   * note in its own denomination via {@link unreachableWeightNote}, or it hands
   * the user a budget that reproduces the identical note.
   */
  unreachable?: UnreachableWeight;
}

/**
 * A positive-weight position the budget could not reach, and the figures its
 * note names: the price of one increment, the slice that fell short of it, and
 * the ≈ minimum budget that does reach it.
 */
export interface UnreachableWeight {
  symbol: string;
  mode: AllocationMode;
  /** The buyable increment: 1 share in whole mode, the fractional step otherwise. */
  step: number;
  /**
   * ISO code of the currency every figure below is denominated in — the run's
   * base ({@link AllocationInput.currency}), so the note is rendered in the
   * money the caller asked about rather than assuming euros (#1831).
   */
  currency: string;
  /** Price of one share, in the budget's currency. */
  priceEur: number;
  /** This position's slice of the budget (`wᵢ · B`). */
  targetEur: number;
  /** The ≈ minimum budget that buys at least one increment of this position. */
  suggestedBudgetEur: number;
}

/**
 * Restate an unreachable weight in the denomination of a budget the caller
 * scaled by `resolvedFraction` before calling (`allocatable = total ·
 * resolvedFraction`, the Invest Calculator's withheld nested share — #1811).
 *
 * Only the suggested budget moves: `wᵢ` is normalised over what reached the
 * engine, so `wᵢ · allocatable` already IS the position's slice of the caller's
 * whole budget, and the price is a price. The figure is ceiled to cents like
 * every other suggestion — rounded down it would name a budget that still
 * misses the share it promises. A fraction of 1 (nothing withheld) is the
 * identity.
 */
export function rescaleUnreachableWeight(
  u: UnreachableWeight,
  resolvedFraction: number,
): UnreachableWeight {
  if (!(resolvedFraction > 0) || resolvedFraction >= 1) return u;
  return { ...u, suggestedBudgetEur: ceilCents(u.suggestedBudgetEur / resolvedFraction) };
}

/**
 * Render an unreachable weight as the §6.7 note — the one place the sentence is
 * built, so a caller restating the figure in its own denomination produces the
 * same sentence the engine would have.
 *
 * Every figure is spelled in {@link UnreachableWeight.currency}: the response
 * this note travels in is denominated in the caller's base (§5.4), so a hard
 * `€` told a CHF user to raise a CHF budget to "≥ ~2250 €" — one `warnings`
 * array carrying two currencies for one run (#1831). EUR still prints the `€`
 * sign of §6.7's worked example; any other base prints its ISO code, exactly
 * like the withheld-slice warning built beside it.
 */
export function unreachableWeightNote(u: UnreachableWeight): string {
  const amount = (value: number): string => money(value, u.currency);
  return u.mode === 'whole'
    ? `${u.symbol} share price (${amount(u.priceEur)}) exceeds its ${amount(
        u.targetEur,
      )} slice; raise the budget to ≥ ~${amount(u.suggestedBudgetEur)} or use fractional mode.`
    : `${u.symbol}: one ${u.step}-share step (${amount(u.step * u.priceEur)}) exceeds its ${amount(
        u.targetEur,
      )} slice; raise the budget to ≥ ~${amount(u.suggestedBudgetEur)}.`;
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
 * `Math.floor` with a **relative** tolerance for floating-point division noise:
 * a value within {@link FLOOR_EPS_REL} *below* an integer counts as that
 * integer, so a mathematically exact quantity like `5 / 0.0001` is not dropped
 * a whole step when FP division lands at 49 999.999999999996. The tolerance is
 * relative on purpose (#1778): an absolute 1e-9 on a *ratio* would floor
 * `500 / 250.0000000625 = 1.9999999995` up to 2 — a share the 500 € slice
 * cannot pay for — while §6.7 specifies an unconditional `floor(targetᵢ/pᵢ)`.
 * The budget invariant never relies on this: every candidate sum still passes
 * an exact `≤ budget` comparison afterwards.
 */
function epsilonFloor(x: number): number {
  const nearest = Math.round(x);
  if (nearest > x && nearest - x <= Math.abs(x) * FLOOR_EPS_REL) return nearest;
  return Math.floor(x);
}

/** Money figure for a human-readable note: rounded to cents, trailing zeros trimmed. Display-only. */
function fmtAmount(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * A note's money figure with its denomination: `140 €` for a EUR run — §6.7's
 * own spelling, kept byte-identical — and `140 CHF` for any other base, the
 * `<amount> <ISO>` form the withheld-slice warning already uses.
 */
function money(value: number, currency: string): string {
  const code = currency.toUpperCase();
  return `${fmtAmount(value)} ${code === 'EUR' ? '€' : code}`;
}

/**
 * A suggested minimum budget, rounded **up** to cents (with a hair of slack for
 * FP noise so an exact 1400 does not print as 1400.01). Rounding a suggestion
 * *down* would print a budget that still misses the share it promises.
 */
function ceilCents(value: number): number {
  return Math.ceil(value * 100 - 1e-6) / 100;
}

/** One position as the planner sees it: identity, price, normalised weight. */
interface BasePosition {
  assetId: string;
  symbol: string;
  priceEur: number;
  /** Normalised weight (the basket sums to exactly 1). Reporting always uses this. */
  weight: number;
}

/** Mutable working state for one position. `k` counts bought increments (shares, or steps). */
interface PositionState extends BasePosition {
  /**
   * Fill target in EUR: `B · wᵢ`, or — for non-forced positions in
   * at-least-one-share mode — the rebalanced remainder slice `B′·wᵢ/Σ_rest w`.
   */
  targetEur: number;
  /**
   * Granted its single share by the at-least-one-share force pass. Exactly one
   * share, structurally: the floor step, FP backstop, and greedy fill all skip
   * forced positions.
   */
  forced: boolean;
  /** Bought increments; `qty = k · step` (step = 1 in whole mode). */
  k: number;
  /** `(k · step) · priceEur` — always the exact FP product for the current `k`. */
  costEur: number;
  /**
   * Cost after the floor step, before the greedy fill — the slice this position
   * earned from its own target. What the note ladder reserves for everyone else.
   */
  floorCostEur: number;
}

/** One complete allocation: the per-position states plus their exact total. */
interface Plan {
  states: PositionState[];
  /** Exact `Σ states[].costEur`, summed in input order. */
  totalCostEur: number;
  /** The granted singles, largest target weight first — the retreat order. */
  forced: PositionState[];
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

/**
 * Which position the FP backstop shaves. Mathematically every floored cost is
 * ≤ its own target, so a sum over budget means one of them over-floored: shave
 * the position furthest **past its own target** (#1778 — shaving the cheapest
 * position instead punished a position that was exactly on target for another's
 * rounding). With nobody over target the overshoot is pure summation noise;
 * then the cheapest increment is the least disruptive shave. Forced singles are
 * exempt — each was admitted by an exact `Σ ≤ budget` check.
 */
function backstopVictim(states: readonly PositionState[]): PositionState | null {
  let over: PositionState | null = null;
  let worst = 0;
  let cheapest: PositionState | null = null;
  for (const s of states) {
    if (s.forced || s.k <= 0) continue;
    const excess = s.costEur - s.targetEur;
    if (excess > worst) {
      worst = excess;
      over = s;
    }
    if (cheapest === null || s.priceEur < cheapest.priceEur) cheapest = s;
  }
  return over ?? cheapest;
}

/**
 * §6.7 force-pass candidates at `budgetEur`: positive weight, a price the whole
 * budget covers (a share dearer than B stays unbuyable, never forced), and an
 * own slice `B·wᵢ` that cannot afford one whole share. Largest target weight
 * first; ties keep input order (the sort is stable).
 *
 * Candidacy only ever *shrinks* as the budget grows (`B·wᵢ` grows while `pᵢ`
 * does not), which is what makes an empty candidate set at B an empty candidate
 * set at every larger budget — the note ladder relies on it.
 */
function forceCandidates(base: readonly BasePosition[], budgetEur: number): BasePosition[] {
  return base
    .filter(
      (b) =>
        b.weight > 0 &&
        b.priceEur <= budgetEur &&
        epsilonFloor((budgetEur * b.weight) / b.priceEur) === 0,
    )
    .sort((a, b) => b.weight - a.weight);
}

/**
 * One complete allocation over `base` at `budgetEur`, granting a single share to
 * every id in `forceIds` that fits: targets, floors, the FP backstop and (whole
 * mode) the greedy fill. Pure — the planner may run it as often as it likes.
 */
function planAllocation(
  base: readonly BasePosition[],
  budgetEur: number,
  mode: AllocationMode,
  step: number,
  forceIds: ReadonlySet<string>,
): Plan {
  const states: PositionState[] = base.map((b) => ({
    ...b,
    // Deferred floors: the force pass must see the whole budget — not the
    // floors' leftover — so an under-slice position's single share is budgeted
    // first and the *remainder* rebalances across the rest.
    targetEur: budgetEur * b.weight,
    forced: false,
    k: 0,
    costEur: 0,
    floorCostEur: 0,
  }));

  // --- At-least-one-share force pass (opt-in, whole mode only).
  const forced: PositionState[] = [];
  if (forceIds.size > 0) {
    const candidates = states
      .filter((s) => forceIds.has(s.assetId))
      .sort((a, b) => b.weight - a.weight); // stable sort ⇒ ties keep input order
    for (const s of candidates) {
      // Exact admission — never overshoot. A candidate that no longer fits is
      // skipped (dropped, never forced); a cheaper lower-weight one may still fit.
      if (totalCostOf(states, s, s.priceEur) > budgetEur) continue;
      s.forced = true;
      s.k = 1;
      s.costEur = s.priceEur;
      forced.push(s);
    }
    if (forced.length > 0) {
      // The remainder rebalances across the non-forced positions by their weights.
      const remainder = budgetEur - totalCostOf(states);
      let restWeight = 0;
      for (const s of states) {
        if (!s.forced) restWeight += s.weight;
      }
      for (const s of states) {
        if (!s.forced) s.targetEur = restWeight > 0 ? (remainder * s.weight) / restWeight : 0;
      }
    }
  }

  // --- Floored quantities (never above target) for non-forced positions.
  for (const s of states) {
    if (s.forced) {
      s.floorCostEur = s.costEur;
      continue;
    }
    const ratio = s.targetEur / s.priceEur / step;
    // A price small enough to overflow the ratio would "afford" an unbounded
    // number of shares; treat it as unreachable rather than iterate on Infinity.
    s.k = Number.isFinite(ratio) ? epsilonFloor(ratio) : 0;
    s.costEur = s.k * step * s.priceEur;
    s.floorCostEur = s.costEur;
  }

  // FP backstop: mathematically Σ qtyᵢ·pᵢ ≤ Σ targetᵢ ≤ B, but the epsilon
  // floor / normalisation can nudge the FP sum a hair over B. Shave the
  // over-floored increment until the exact check passes (in practice: never
  // runs). Forced singles are exempt — each was admitted by an exact
  // `Σ ≤ budget` check, so shaving the floors alone always suffices.
  let total = totalCostOf(states);
  while (total > budgetEur) {
    const victim = backstopVictim(states);
    if (victim === null) break; // unreachable: forced-only totals passed the exact admission check
    victim.k -= 1;
    victim.costEur = victim.k * step * victim.priceEur;
    victim.floorCostEur = victim.costEur;
    total = totalCostOf(states);
  }

  // --- Step 4 (whole mode only): greedy leftover fill. Under maximal floors a
  // position can win at most one fill — its next share then sits at or past
  // target, and every further one only widens the deviation — so the pass is
  // bounded by the basket size (+1 for the rare backstop shave, which reopens
  // one position). The bound is a termination guard, not a policy: the loop
  // always ends earlier, when no purchase strictly reduces the deviation.
  if (mode === 'whole') {
    for (let fills = 0; fills <= states.length; fills += 1) {
      let best: PositionState | null = null;
      let bestReduction = 0;
      let bestCost = 0;
      for (const s of states) {
        // A forced position gets exactly its one share — never topped up. (It
        // could never win anyway: its cost p already exceeds its B·wᵢ target.)
        if (s.forced) continue;
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

  return { states, totalCostEur: total, forced };
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

  // Display-only label for the notes; the engine itself never converts (§5.4).
  const currency = input.currency && input.currency.trim() !== '' ? input.currency : 'EUR';

  // In whole mode the increment is exactly 1 share, so `qty = k · step` is exact.
  const step = mode === 'fractional' ? (input.step ?? DEFAULT_FRACTIONAL_STEP) : 1;
  const forceSingles = mode === 'whole' && input.atLeastOneShare === true;

  // Weights normalised to sum to exactly 1; targets follow from them.
  const base: BasePosition[] = positions.map((pos) => ({
    assetId: pos.assetId,
    symbol: pos.symbol,
    priceEur: pos.priceEur,
    weight: pos.weight / weightSum,
  }));

  /**
   * The plan this engine returns at `budget`: the flag-off allocation, or — with
   * the flag on — the largest set of granted singles that still deploys at
   * least as much capital as the flag-off plan (module header, #1778). A pure
   * function of `budget`, so a note's probe sees exactly what a fresh call at
   * that budget would.
   */
  function solve(budget: number): { plan: Plan; baseline: Plan } {
    const baseline = planAllocation(base, budget, mode, step, NO_FORCED);
    if (!forceSingles) return { plan: baseline, baseline };

    const forceIds = new Set(forceCandidates(base, budget).map((c) => c.assetId));
    for (let retreats = 0; forceIds.size > 0 && retreats <= MAX_FORCE_RETREATS; retreats += 1) {
      const attempt = planAllocation(base, budget, mode, step, forceIds);
      // Exact comparison: two plans with identical per-position costs sum
      // bit-identically (always input order), so this retreats only on a real loss.
      if (attempt.totalCostEur >= baseline.totalCostEur) return { plan: attempt, baseline };
      const dropped = attempt.forced[attempt.forced.length - 1];
      if (dropped === undefined) break; // nothing fit ⇒ the attempt is the baseline
      forceIds.delete(dropped.assetId);
    }
    return { plan: baseline, baseline };
  }

  const { plan, baseline } = solve(budgetEur);
  const total = plan.totalCostEur;

  let probesLeft = base.length <= MAX_PROBED_POSITIONS ? MAX_NOTE_PROBES : 0;

  /** Does re-running this same call at `budget` buy `assetId` at least one increment? */
  function buysAtLeastOne(budget: number, assetId: string): boolean {
    if (probesLeft <= 0) return false;
    probesLeft -= 1;
    const probe = solve(budget).plan;
    return (probe.states.find((s) => s.assetId === assetId)?.k ?? 0) >= 1;
  }

  /**
   * The "≈ minimum budget" a qty-0 position's note names — a figure that
   * actually reaches it (module header). Off the force path `pᵢ/wᵢ` is exact:
   * nothing can take the slice away, so `B·wᵢ ≥ pᵢ` buys the share. On the
   * force path a larger budget can start granting singles that shrink this
   * slice again — even to a position too dear to be a candidate at today's
   * budget — so every rung of the ladder is verified by a re-plan.
   */
  function suggestedMinBudget(s: PositionState): number {
    const ownSlice = ceilCents(s.priceEur / s.weight);
    if (!forceSingles) return ownSlice;

    // "Grant my share without taking a floor anyone else earned from their own
    // slice" — the figure the defect this fixes made unreachable (#1778).
    let othersFloor = 0;
    for (const other of baseline.states) {
      if (other.assetId !== s.assetId) othersFloor += other.floorCostEur;
    }
    const ladder = [ceilCents(s.priceEur + othersFloor)];

    // The rebalanced-slice threshold, when singles were actually granted:
    // pᵢ·Σ_rest w/wᵢ + Σ forced re-floats this position's shrunken slice to pᵢ.
    if (plan.forced.length > 0) {
      let forcedCost = 0;
      let restWeight = 0;
      for (const other of plan.states) {
        if (other.forced) forcedCost += other.priceEur;
        else restWeight += other.weight;
      }
      ladder.push(ceilCents((s.priceEur * restWeight) / s.weight + forcedCost));
    }
    ladder.push(ownSlice);

    const tried = new Set<number>();
    for (const candidate of ladder.sort((a, b) => a - b)) {
      if (candidate <= budgetEur || tried.has(candidate)) continue;
      tried.add(candidate);
      if (buysAtLeastOne(candidate, s.assetId)) return candidate;
    }

    // Fallback, reachable by construction: this position is either granted its
    // own single, or Σ forced ≤ Σⱼ≠ᵢ pⱼ leaves its rebalanced slice at
    // pᵢ + pᵢ·wᵢ — over its price with room to spare, whatever else is forced.
    let allPrices = 0;
    for (const other of base) allPrices += other.priceEur;
    return ceilCents(s.priceEur / s.weight + allPrices);
  }

  // --- Step 5: emit lines, totals, and unreachable-weight notes.
  const warnings: string[] = [];
  const lines: AllocationLine[] = plan.states.map((s) => {
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

    // qty 0 with a positive weight ⇔ the slice B·wᵢ is below one increment, or
    // the force pass shrank it below one — surfaced explicitly with a budget
    // that reaches it, never silently mis-weighted (§6.7).
    if (s.k === 0 && s.weight > 0) {
      const unreachable: UnreachableWeight = {
        symbol: s.symbol,
        mode,
        step,
        currency,
        priceEur: s.priceEur,
        targetEur: s.targetEur,
        suggestedBudgetEur:
          mode === 'whole' ? suggestedMinBudget(s) : ceilCents((step * s.priceEur) / s.weight),
      };
      line.unreachable = unreachable;
      line.note = unreachableWeightNote(unreachable);
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
