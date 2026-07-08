/**
 * Portfolio cash ledger ("Bargeld") — pure domain core (V2-P6, issues #220/#274).
 *
 * A **pure** money-math engine for the per-portfolio cash balance. Like the
 * rest of `domain/**` this is T1 code with **no imports of DB, HTTP, contracts,
 * providers, or the clock** — the only import is the {@link FlowPoint} *type*
 * from `./holdings`, so the external-flow series composes directly with
 * {@link timeWeightedReturn}. The `portfolio_cash_movements` table, repository,
 * service wiring, and overview UI land in a later V2-P6 issue; this module is
 * the authoritative rulebook they will call into.
 *
 * **V3-P3 — cash sources.** The single ledger became **Main** plus named
 * sibling sources: every movement belongs to one source, the portfolio ledger
 * is the union of all sources' movements (so every roll-up here keeps working
 * on the union), solvency is checked **per source**
 * ({@link projectCashLedgerBySource}), transfers between sources are paired
 * `transfer_out`/`transfer_in` legs that cancel to zero in every sum and are
 * never TWR flows ({@link pairedTransferMovements}), and "set balance to X"
 * reduces to a normal deposit/withdrawal carrying the computed delta
 * ({@link setBalanceMovement}).
 *
 * **Data model.** A movement is `kind + signed EUR amount + ISO-8601 timestamp`.
 * The sign is part of the data (not derived): inflow kinds (`deposit`,
 * `sell_proceeds`) carry a strictly positive `amountEur`, outflow kinds
 * (`withdrawal`, `buy`) a strictly negative one, and a sign/kind mismatch or a
 * zero amount fails loud with {@link CashLedgerError} — the ledger never
 * guesses a direction. With that invariant, **current cash = sum of signed
 * movements**, the #220 reconciliation invariant, and {@link cashBalance} is
 * literally that sum (in input order, full FP precision, §5.4 — display
 * rounding lives in the display layer).
 *
 * **No silent negative balances** (#220). {@link applyCashMovement} is the
 * single admission gate: it returns the balance after a movement or throws the
 * typed {@link InsufficientCashError} (carrying the available balance and the
 * exact shortfall — everything a "available → after" preview or a 4xx needs).
 * {@link projectCashLedger} replays a whole history chronologically
 * (`occurredAt`, ties broken by input order, mirroring `holdings`' transaction
 * ordering) through that same gate and returns the running balance after every
 * movement — which doubles as the balance-over-time series for the later
 * overview wiring ({@link cashBalanceOverTime} condenses it to end-of-day
 * points). Balances within {@link CASH_EPSILON} of zero count as zero, so FP
 * dust from decimal EUR amounts (0.1 + 0.2 − 0.3) never fabricates an
 * insufficient-cash rejection; the check is a tolerance only — amounts are
 * never rounded or clamped mid-computation.
 *
 * **TWR integrity — the hard requirement.** Buying from cash is **not** a new
 * external cash flow: money already inside the portfolio merely changed form
 * (cash → shares), so it must not register as a deposit in the performance-%
 * curve. This module is the authoritative classifier:
 * {@link externalCashFlowsForTwr} returns **only** `deposit` / `withdrawal`
 * movements — aggregated per day, sparse, ascending, in the exact
 * {@link FlowPoint} shape `timeWeightedReturn` consumes — while `buy` /
 * `sell_proceeds` are internal and excluded. Two wiring rules follow for the
 * service (#311): (1) the value series fed to `timeWeightedReturn` must
 * *include* the cash balance (deposit day: value +1000 with a +1000 flow →
 * flat; buy day: value unchanged, no flow → flat) — {@link netWorthSeries}
 * builds exactly that series; (2) a cash-funded buy/sell transaction must
 * **not** additionally enter `netFlowsOverTime` — its external flow was
 * already booked when the cash was deposited, and counting it again would
 * double the flow.
 */

import type { FlowPoint, ValuePoint } from './holdings';

// ---------------------------------------------------------------------------
// Movement kinds & constants
// ---------------------------------------------------------------------------

/**
 * Every cash-movement kind, external and internal. `transfer_out` /
 * `transfer_in` (V3-P3) are the paired legs of an internal transfer between two
 * cash sources of the same portfolio — see {@link pairedTransferMovements}.
 * `dividend` / `tax_withholding` / `tax_refund` (V3-P4, §13.3) are the tax
 * engine's postings: a dividend's gross amount landing in a source, and the
 * KESt/manual tax settlements against it — all internal for TWR purposes (see
 * {@link EXTERNAL_CASH_MOVEMENT_KINDS}).
 */
export const CASH_MOVEMENT_KINDS = [
  'deposit',
  'withdrawal',
  'buy',
  'sell_proceeds',
  'transfer_out',
  'transfer_in',
  'dividend',
  'tax_withholding',
  'tax_refund',
] as const;

export type CashMovementKind = (typeof CASH_MOVEMENT_KINDS)[number];

/**
 * Required sign of `amountEur` per kind: inflows (`deposit`, `sell_proceeds`,
 * `transfer_in`) are strictly positive, outflows (`withdrawal`, `buy`,
 * `transfer_out`) strictly negative.
 */
export const CASH_MOVEMENT_SIGN: Readonly<Record<CashMovementKind, 1 | -1>> = {
  deposit: 1,
  sell_proceeds: 1,
  transfer_in: 1,
  dividend: 1,
  tax_refund: 1,
  withdrawal: -1,
  buy: -1,
  transfer_out: -1,
  tax_withholding: -1,
};

/**
 * The kinds that are **external** flows for TWR purposes: money crossing the
 * portfolio boundary. `buy` / `sell_proceeds` are internal (cash ↔ shares form
 * change) and deliberately absent — as are `transfer_out` / `transfer_in`
 * (V3-P3): a transfer moves money between two sources *inside* the portfolio,
 * so it is NEVER an external flow (its paired legs also cancel to zero in every
 * roll-up, keeping net worth unchanged). The V3-P4 tax kinds are internal too
 * (§16 2026-07-08): a `dividend` is income the portfolio's assets *generated*
 * — counting it as a deposit would neutralize it out of the performance curve
 * and understate the true return — and `tax_withholding` / `tax_refund` are
 * costs of holding the portfolio, kept inside the curve so performance reads
 * net of taxes, exactly as it already reads net of fees.
 */
export const EXTERNAL_CASH_MOVEMENT_KINDS: readonly CashMovementKind[] = ['deposit', 'withdrawal'];

/**
 * EUR comparison tolerance for the non-negativity gate (mirrors `holdings`'
 * `VALUE_EPSILON`): a balance within this of zero is FP dust from decimal EUR
 * arithmetic, not a real overdraft. Used only for the *comparison* — balances
 * themselves are never rounded or clamped (§5.4).
 */
export const CASH_EPSILON = 1e-9;

/** The number of decimal places real money is denominated in (cents). */
export const CASH_DECIMALS = 2;

/**
 * Quantize a EUR amount to whole cents (V3-P0 withdraw-all fix, issue #322).
 *
 * Cash is **real money** — it exists only in whole cents. The pure engine above
 * sums at full FP precision (§5.4), but sub-cent residue must never survive to a
 * *stored* movement or a *reported* balance: a balance of `100.006 €` displays as
 * `100,01 €` yet can never be fully withdrawn (a `100,01 €` withdrawal overdraws
 * the true `100.006`), stranding the reported cent — exactly the reported bug.
 * The boundary fix is to round every amount that enters the ledger, and every
 * balance that leaves it, to cents here, so a withdraw-all lands at exactly
 * `0,00 €` with no float residue.
 *
 * Rounds half away from zero (`0.005 → 0.01`, `−0.005 → −0.01`), nudging by one
 * ULP first so a value the decimal literal can't represent exactly (`1.005`,
 * stored as `1.00499999…`) still rounds the way a person reading cents expects.
 * This is a **boundary quantizer** for the service layer — the domain replay
 * functions themselves stay unrounded (§5.4).
 */
export function roundCents(amountEur: number): number {
  if (!Number.isFinite(amountEur)) {
    throw new CashLedgerError(`Cannot round a non-finite EUR amount, got ${amountEur}.`);
  }
  const scaled = amountEur * 100;
  const nudged = scaled + Math.sign(scaled) * Number.EPSILON * Math.abs(scaled);
  return Math.round(nudged) / 100;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One cash movement: kind + signed EUR amount + when it happened. */
export interface CashMovement {
  kind: CashMovementKind;
  /**
   * Signed EUR amount, full precision: strictly positive for `deposit` /
   * `sell_proceeds`, strictly negative for `withdrawal` / `buy` (see
   * {@link CASH_MOVEMENT_SIGN}). Never zero.
   */
  amountEur: number;
  /** ISO-8601 timestamp of the movement; unparseable input fails loud. */
  occurredAt: string;
}

/** One step of a {@link projectCashLedger} replay. */
export interface CashLedgerEntry {
  movement: CashMovement;
  /** Running balance in EUR **after** applying `movement`. */
  balanceEur: number;
}

/** End-of-day cash balance, for composing with daily value series later. */
export interface CashBalancePoint {
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** Balance after the day's last movement, EUR. */
  balanceEur: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Invalid ledger input — unknown kind, non-finite or zero amount, a sign that
 * contradicts the kind, an unparseable timestamp, a bogus starting balance. A
 * typed error so the API can map caller mistakes to a 4xx instead of a 500.
 */
export class CashLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CashLedgerError';
  }
}

/**
 * A movement was rejected because it would drive the cash balance negative
 * (#220: no silent negative balances). Distinct from {@link CashLedgerError}
 * — the input is well-formed, there just isn't enough cash — so the service
 * layer can map it to its own user-facing response. Carries everything a
 * "available → after" preview needs.
 */
export class InsufficientCashError extends Error {
  /** Balance available before the rejected movement, EUR. */
  readonly balanceEur: number;
  /** The rejected movement. */
  readonly movement: CashMovement;
  /** How much cash is missing, EUR (> 0): `−(balanceEur + amountEur)`. */
  readonly shortfallEur: number;

  constructor(balanceEur: number, movement: CashMovement) {
    const shortfallEur = -(balanceEur + movement.amountEur);
    super(
      `Insufficient cash: ${movement.kind} of ${movement.amountEur} € at ${movement.occurredAt} ` +
        `exceeds the available balance of ${balanceEur} € by ${shortfallEur} €.`,
    );
    this.name = 'InsufficientCashError';
    this.balanceEur = balanceEur;
    this.movement = movement;
    this.shortfallEur = shortfallEur;
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** ISO `YYYY-MM-DD` of a movement's `occurredAt`; malformed input fails loud. */
function dayOf(occurredAt: string): string {
  const day = occurredAt.slice(0, 10);
  if (!ISO_DAY_RE.test(day)) {
    throw new CashLedgerError(
      `Movement occurredAt must be an ISO-8601 date/time, got ${occurredAt}`,
    );
  }
  return day;
}

/** Epoch-ms of a movement's `occurredAt`; unparseable input fails loud. */
function occurredAtToMs(occurredAt: string): number {
  const ms = Date.parse(occurredAt);
  if (Number.isNaN(ms)) {
    throw new CashLedgerError(
      `Movement occurredAt must be an ISO-8601 date/time, got ${occurredAt}`,
    );
  }
  return ms;
}

/** Fail-loud shape check for one movement; `at` names its position in errors. */
function assertValidMovement(movement: CashMovement, at?: number): void {
  const where = at === undefined ? '' : ` (movement ${at})`;
  if (!CASH_MOVEMENT_KINDS.includes(movement.kind)) {
    throw new CashLedgerError(
      `Unknown movement kind ${String(movement.kind)}${where}; ` +
        `expected one of ${CASH_MOVEMENT_KINDS.join(', ')}.`,
    );
  }
  if (!Number.isFinite(movement.amountEur) || movement.amountEur === 0) {
    throw new CashLedgerError(
      `Movement amountEur must be a finite non-zero number, got ${movement.amountEur}${where}.`,
    );
  }
  const requiredSign = CASH_MOVEMENT_SIGN[movement.kind];
  if (Math.sign(movement.amountEur) !== requiredSign) {
    throw new CashLedgerError(
      `A ${movement.kind} must carry a strictly ${
        requiredSign === 1 ? 'positive' : 'negative'
      } amountEur, got ${movement.amountEur}${where}.`,
    );
  }
  occurredAtToMs(movement.occurredAt);
}

// ---------------------------------------------------------------------------
// Balance & projection
// ---------------------------------------------------------------------------

/**
 * Current cash balance = **sum of signed movements** (#220's reconciliation
 * invariant, literally). Summed in input order at full FP precision; the sum
 * is what it is — non-negativity is {@link projectCashLedger}'s job, not this
 * function's. Throws {@link CashLedgerError} on any malformed movement.
 */
export function cashBalance(movements: readonly CashMovement[]): number {
  let sum = 0;
  for (const [i, movement] of movements.entries()) {
    assertValidMovement(movement, i);
    sum += movement.amountEur;
  }
  return sum;
}

/**
 * Apply one movement to a balance: the single admission gate behind every
 * mutation and the primitive for a live "available → after" preview. Returns
 * `balanceEur + amountEur`, or throws {@link InsufficientCashError} when the
 * result would be negative beyond {@link CASH_EPSILON} — no silent negative
 * balances. Throws {@link CashLedgerError} on a malformed movement or a
 * non-finite / already-negative starting balance.
 */
export function applyCashMovement(balanceEur: number, movement: CashMovement): number {
  if (!Number.isFinite(balanceEur) || balanceEur < -CASH_EPSILON) {
    throw new CashLedgerError(
      `Starting balance must be a finite non-negative number of EUR, got ${balanceEur}.`,
    );
  }
  assertValidMovement(movement);
  const next = balanceEur + movement.amountEur;
  if (next < -CASH_EPSILON) {
    throw new InsufficientCashError(balanceEur, movement);
  }
  return next;
}

/**
 * Replay a movement history chronologically (`occurredAt` ascending, ties
 * broken by input order — mirroring `holdings`' transaction ordering) through
 * {@link applyCashMovement}, so a history that would ever dip negative is
 * rejected with {@link InsufficientCashError} at the offending movement. The
 * input array is not mutated.
 *
 * Returns one {@link CashLedgerEntry} per movement in replay order — the
 * running balance after every step, i.e. the balance-over-time series. The
 * last entry's `balanceEur` equals {@link cashBalance} up to FP summation
 * order (identical when the input is already chronological).
 */
export function projectCashLedger(movements: readonly CashMovement[]): CashLedgerEntry[] {
  movements.forEach((movement, i) => assertValidMovement(movement, i));
  const ordered = movements
    .map((movement, index) => ({ movement, index, ms: occurredAtToMs(movement.occurredAt) }))
    .sort((a, b) => a.ms - b.ms || a.index - b.index);

  const entries: CashLedgerEntry[] = [];
  let balanceEur = 0;
  for (const { movement } of ordered) {
    balanceEur = applyCashMovement(balanceEur, movement);
    entries.push({ movement, balanceEur });
  }
  return entries;
}

/**
 * End-of-day balance series: {@link projectCashLedger} condensed to the last
 * balance of each day with a movement (sparse, ascending) — the shape the
 * later overview wiring needs to add cash to a daily value curve. Validates
 * and rejects negative-dipping histories exactly like the projection.
 */
export function cashBalanceOverTime(movements: readonly CashMovement[]): CashBalancePoint[] {
  const points: CashBalancePoint[] = [];
  for (const entry of projectCashLedger(movements)) {
    const date = dayOf(entry.movement.occurredAt);
    const last = points[points.length - 1];
    if (last !== undefined && last.date === date) last.balanceEur = entry.balanceEur;
    else points.push({ date, balanceEur: entry.balanceEur });
  }
  return points;
}

// ---------------------------------------------------------------------------
// Cash sources (V3-P3, §13.3)
// ---------------------------------------------------------------------------
//
// The V2 single ledger becomes **Main** plus named sibling sources. Every
// movement now belongs to exactly one source; the *portfolio* ledger is simply
// the union of all sources' movements, so every roll-up above (cashBalance,
// projectCashLedger, cashBalanceOverTime, netWorthSeries,
// externalCashFlowsForTwr) keeps working unchanged when fed the union — a
// transfer's paired legs cancel to zero inside every sum. The *solvency* gate,
// however, is per source: each source is a real account, and money in "Bank"
// cannot cover an overdraft of "Main". The per-source projection below is the
// authoritative admission check; per-source validity implies portfolio-level
// validity (each source's running balance is ≥ 0, so their sum is too).

/** A cash movement attributed to the source it belongs to (V3-P3). */
export interface SourcedCashMovement extends CashMovement {
  /** The owning cash source's id. Never empty. */
  sourceId: string;
}

/** Fail-loud check that a movement carries a usable source id. */
function assertSourced(movement: SourcedCashMovement, at?: number): void {
  const where = at === undefined ? '' : ` (movement ${at})`;
  if (typeof movement.sourceId !== 'string' || movement.sourceId.length === 0) {
    throw new CashLedgerError(`Movement sourceId must be a non-empty string${where}.`);
  }
}

/**
 * Current balance of **each** source: `Map` of `sourceId` → sum of its signed
 * movements (the §14 reconciliation invariant, per source). Sources with no
 * movements are absent — the caller supplies zeroes for freshly created ones.
 * Full FP precision (§5.4); quantize with {@link roundCents} at the boundary.
 * Throws {@link CashLedgerError} on any malformed movement.
 */
export function cashBalancesBySource(
  movements: readonly SourcedCashMovement[],
): Map<string, number> {
  const balances = new Map<string, number>();
  for (const [i, movement] of movements.entries()) {
    assertValidMovement(movement, i);
    assertSourced(movement, i);
    balances.set(movement.sourceId, (balances.get(movement.sourceId) ?? 0) + movement.amountEur);
  }
  return balances;
}

/**
 * Replay every source's own history chronologically through the
 * {@link applyCashMovement} admission gate — the V3-P3 solvency check. A
 * history in which **any single source** ever dips negative is rejected with
 * {@link InsufficientCashError} at the offending movement (its `movement`
 * retains the `sourceId`), even when the other sources hold plenty. Returns the
 * per-source projections (`sourceId` → running-balance entries), each the exact
 * shape {@link projectCashLedger} produces for a single ledger.
 */
export function projectCashLedgerBySource(
  movements: readonly SourcedCashMovement[],
): Map<string, CashLedgerEntry[]> {
  movements.forEach((movement, i) => assertSourced(movement, i));
  const bySource = new Map<string, SourcedCashMovement[]>();
  for (const movement of movements) {
    const list = bySource.get(movement.sourceId);
    if (list) list.push(movement);
    else bySource.set(movement.sourceId, [movement]);
  }
  const projections = new Map<string, CashLedgerEntry[]>();
  for (const [sourceId, sourceMovements] of bySource) {
    projections.set(sourceId, projectCashLedger(sourceMovements));
  }
  return projections;
}

/** Input for {@link pairedTransferMovements}. */
export interface CashTransferInput {
  /** Source the money leaves. Must differ from `toSourceId`. */
  fromSourceId: string;
  /** Source the money enters. */
  toSourceId: string;
  /** Positive EUR magnitude to move; quantized to whole cents here (#322). */
  amountEur: number;
  /** ISO-8601 timestamp shared by both legs (same day ⇒ roll-ups never wobble). */
  occurredAt: string;
}

/** The two legs of one transfer, double-entry style. */
export interface CashTransferLegs {
  /** `transfer_out` on the from-source: strictly negative amount. */
  outgoing: SourcedCashMovement;
  /** `transfer_in` on the to-source: the exact mirror amount, positive. */
  incoming: SourcedCashMovement;
}

/**
 * Build the paired movements of an internal transfer (V3-P3): `transfer_out`
 * of `−X` on the from-source and `transfer_in` of `+X` on the to-source,
 * sharing one timestamp — double-entry style, so both histories carry the
 * transfer while every roll-up sums the pair to exactly zero (net worth
 * unchanged, and never a TWR flow — see
 * {@link EXTERNAL_CASH_MOVEMENT_KINDS}). The magnitude is quantized to whole
 * cents (#322: cash exists only in cents); an amount that rounds to zero, a
 * non-finite/negative amount, a same-source transfer, or an empty source id
 * fails loud with {@link CashLedgerError}. Solvency of the from-source is the
 * per-source projection's job, not this builder's.
 */
export function pairedTransferMovements(input: CashTransferInput): CashTransferLegs {
  const { fromSourceId, toSourceId, occurredAt } = input;
  if (typeof fromSourceId !== 'string' || fromSourceId.length === 0) {
    throw new CashLedgerError('Transfer fromSourceId must be a non-empty string.');
  }
  if (typeof toSourceId !== 'string' || toSourceId.length === 0) {
    throw new CashLedgerError('Transfer toSourceId must be a non-empty string.');
  }
  if (fromSourceId === toSourceId) {
    throw new CashLedgerError('A transfer needs two different cash sources.');
  }
  if (!Number.isFinite(input.amountEur) || input.amountEur <= 0) {
    throw new CashLedgerError(
      `Transfer amountEur must be a strictly positive number, got ${input.amountEur}.`,
    );
  }
  const amountEur = roundCents(input.amountEur);
  if (amountEur === 0) {
    throw new CashLedgerError(
      `Transfer amountEur rounds to €0.00 (got ${input.amountEur}); nothing to move.`,
    );
  }
  const outgoing: SourcedCashMovement = {
    kind: 'transfer_out',
    amountEur: -amountEur,
    occurredAt,
    sourceId: fromSourceId,
  };
  const incoming: SourcedCashMovement = {
    kind: 'transfer_in',
    amountEur,
    occurredAt,
    sourceId: toSourceId,
  };
  // Reuse the single admission gate's shape checks (kind/sign/timestamp).
  assertValidMovement(outgoing);
  assertValidMovement(incoming);
  return { outgoing, incoming };
}

/**
 * The signed cent delta of a "set balance to X" operation (V3-P3, §16
 * 2026-07-07): the movement amount that takes `currentBalanceEur` to
 * `targetBalanceEur`. Both inputs are quantized to whole cents first — pass the
 * *reported* (cent-exact, #322) balance as `current` — so the returned delta is
 * itself cent-exact and the post-movement balance reads exactly the target.
 * Positive ⇒ record a deposit, negative ⇒ a withdrawal, `0` ⇒ record nothing
 * (see {@link setBalanceMovement}). The target must be a finite, non-negative
 * EUR amount (no silent negative balances); malformed input fails loud.
 */
export function setBalanceDelta(currentBalanceEur: number, targetBalanceEur: number): number {
  if (!Number.isFinite(currentBalanceEur)) {
    throw new CashLedgerError(
      `Set-balance current balance must be a finite number of EUR, got ${currentBalanceEur}.`,
    );
  }
  if (!Number.isFinite(targetBalanceEur) || targetBalanceEur < 0) {
    throw new CashLedgerError(
      `Set-balance target must be a finite non-negative number of EUR, got ${targetBalanceEur}.`,
    );
  }
  // Quantize each operand, then the difference: 200.00 − 123.45 carries FP
  // noise (76.55000000000001) that must not survive into a stored amount.
  return roundCents(roundCents(targetBalanceEur) - roundCents(currentBalanceEur));
}

/**
 * The **normal movement** a set-balance records (§16: the app computes the
 * signed difference itself and books it like any other movement, keeping the
 * audit trail intact): a `deposit` carrying a positive delta, a `withdrawal`
 * carrying a negative one, or `null` when the target already equals the
 * current balance — a no-op writes nothing. Set-balance deltas are external
 * flows exactly like hand-entered deposits/withdrawals: money appeared in (or
 * left) the real-world account, crossing the portfolio boundary.
 */
export function setBalanceMovement(input: {
  sourceId: string;
  currentBalanceEur: number;
  targetBalanceEur: number;
  occurredAt: string;
}): SourcedCashMovement | null {
  if (typeof input.sourceId !== 'string' || input.sourceId.length === 0) {
    throw new CashLedgerError('Set-balance sourceId must be a non-empty string.');
  }
  const deltaEur = setBalanceDelta(input.currentBalanceEur, input.targetBalanceEur);
  if (deltaEur === 0) return null;
  const movement: SourcedCashMovement = {
    kind: deltaEur > 0 ? 'deposit' : 'withdrawal',
    amountEur: deltaEur,
    occurredAt: input.occurredAt,
    sourceId: input.sourceId,
  };
  assertValidMovement(movement);
  return movement;
}

// ---------------------------------------------------------------------------
// Net-worth series (#311)
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/** UTC midnight epoch-ms of an ISO `YYYY-MM-DD` (deterministic, no clock). */
function isoDayToMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/** Input for {@link netWorthSeries}. */
export interface NetWorthSeriesInput {
  /**
   * The holdings-only daily value curve in EUR (`holdings.valueOverTime`
   * output): **dense** — one point per calendar day — ascending, ending at the
   * reporting day. May be empty (a portfolio that holds only cash). A date
   * absent from the curve is a day with no holdings and counts as 0.
   */
  holdingsValues: readonly ValuePoint[];
  /** The portfolio's full cash ledger, any order. */
  movements: readonly CashMovement[];
  /**
   * The reporting day (ISO `YYYY-MM-DD`): the last day of the series when the
   * holdings curve is empty. With a non-empty curve the curve's own last day
   * is the end (it was built through the same reporting day).
   */
  today: string;
}

/**
 * The portfolio's daily **net worth** curve (#311): for every calendar day,
 * `holdings value + end-of-day cash balance`. This is the owner-feedback rule
 * made series-shaped — cash is a component of what the portfolio is worth, so
 * the absolute value graph carries it too. Two properties follow directly and
 * are the correctness anchors:
 *
 *  - a **deposit / withdrawal** moves the curve by exactly its amount on its
 *    day (cash changes, holdings don't);
 *  - a **cash-funded buy** leaves the curve unchanged at the trade moment —
 *    holdings rise by what cash falls by; money merely changed form. (The
 *    close of the traded asset may still move the value later that day —
 *    genuine market movement, not the trade.)
 *
 * The grid spans from the earlier of (first holdings day, first movement day)
 * to the holdings curve's last day (or `today` when it is empty), one point
 * per calendar day: cash deposited before the first transaction is part of the
 * portfolio's worth from its deposit day, with holdings contributing 0 until
 * they exist. The cash balance carries forward between movement days (EOD
 * balance, ties by input order); movements dated after the grid end never
 * enter. Full FP precision throughout (§5.4) — no rounding, no clamping.
 *
 * **Deliberately no solvency gate.** {@link projectCashLedger} rejects
 * negative-dipping histories at the *write* boundary; this is a *display*
 * derivation, and a ledger reshaped after the fact (e.g. a cascade-deleted
 * `sell_proceeds` that funded a later withdrawal) must still render what the
 * rows say rather than 500 the whole graph. Malformed movements, dates or
 * values still fail loud ({@link CashLedgerError}).
 */
export function netWorthSeries(input: NetWorthSeriesInput): ValuePoint[] {
  const { holdingsValues, movements, today } = input;
  if (!ISO_DAY_RE.test(today)) {
    throw new CashLedgerError(`today must be ISO YYYY-MM-DD, got ${today}`);
  }
  for (const point of holdingsValues) {
    if (!ISO_DAY_RE.test(point.date)) {
      throw new CashLedgerError(`Holdings value date must be ISO YYYY-MM-DD, got ${point.date}`);
    }
    if (!Number.isFinite(point.valueEur)) {
      throw new CashLedgerError(
        `Holdings value on ${point.date} must be a finite number, got ${point.valueEur}`,
      );
    }
  }
  movements.forEach((movement, i) => assertValidMovement(movement, i));

  // Sparse end-of-day balances: chronological replay (ties by input order,
  // mirroring projectCashLedger), plain running sum — see docstring for why
  // the insufficient-cash gate deliberately does not apply here.
  const ordered = movements
    .map((movement, index) => ({ movement, index, ms: occurredAtToMs(movement.occurredAt) }))
    .sort((a, b) => a.ms - b.ms || a.index - b.index);
  const eodBalances: Array<{ dayMs: number; balanceEur: number }> = [];
  let balanceEur = 0;
  for (const { movement } of ordered) {
    balanceEur += movement.amountEur;
    const dayMs = isoDayToMs(dayOf(movement.occurredAt));
    const last = eodBalances[eodBalances.length - 1];
    if (last !== undefined && last.dayMs === dayMs) last.balanceEur = balanceEur;
    else eodBalances.push({ dayMs, balanceEur });
  }

  const firstHoldings = holdingsValues[0];
  const lastHoldings = holdingsValues[holdingsValues.length - 1];
  const firstCash = eodBalances[0];
  if (firstHoldings === undefined && firstCash === undefined) return [];

  const endMs = lastHoldings !== undefined ? isoDayToMs(lastHoldings.date) : isoDayToMs(today);
  const startMs = Math.min(
    firstHoldings !== undefined ? isoDayToMs(firstHoldings.date) : Infinity,
    firstCash?.dayMs ?? Infinity,
  );
  // Nothing on or before the grid end (e.g. only future-dated movements).
  if (startMs > endMs) return [];

  const holdingsByDate = new Map(holdingsValues.map((p) => [p.date, p.valueEur]));
  const series: ValuePoint[] = [];
  let cashIdx = 0;
  let carriedCashEur = 0;
  for (let ms = startMs; ms <= endMs; ms += MS_PER_DAY) {
    const date = new Date(ms).toISOString().slice(0, 10);
    while (cashIdx < eodBalances.length) {
      const entry = eodBalances[cashIdx];
      if (entry === undefined || entry.dayMs > ms) break;
      carriedCashEur = entry.balanceEur;
      cashIdx += 1;
    }
    series.push({ date, valueEur: (holdingsByDate.get(date) ?? 0) + carriedCashEur });
  }
  return series;
}

// ---------------------------------------------------------------------------
// TWR classification
// ---------------------------------------------------------------------------

/** Whether a movement kind is an **external** flow for TWR (deposit/withdrawal). */
export function isExternalCashMovement(kind: CashMovementKind): boolean {
  return EXTERNAL_CASH_MOVEMENT_KINDS.includes(kind);
}

/**
 * The movements that count as **external** cash flows for the time-weighted
 * return: **only** `deposit` / `withdrawal`. `buy` and `sell_proceeds` are
 * internal — money already inside the portfolio changing form — and excluded,
 * which is precisely what keeps a cash-funded buy TWR-neutral (V2-P6's core
 * correctness requirement; see the module header for the two wiring rules).
 *
 * Output is `holdings`' {@link FlowPoint} shape and convention — net EUR flow
 * per day, money *into* the portfolio positive (a deposit's `amountEur` is
 * already signed that way), sparse (only days with an external flow), sorted
 * ascending — ready to feed `timeWeightedReturn` directly. Pure
 * classification: solvency is {@link projectCashLedger}'s job.
 */
export function externalCashFlowsForTwr(movements: readonly CashMovement[]): FlowPoint[] {
  const flowByDay = new Map<string, number>();
  for (const [i, movement] of movements.entries()) {
    assertValidMovement(movement, i);
    if (!isExternalCashMovement(movement.kind)) continue;
    const day = dayOf(movement.occurredAt);
    flowByDay.set(day, (flowByDay.get(day) ?? 0) + movement.amountEur);
  }
  return [...flowByDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, flowEur]) => ({ date, flowEur }));
}
