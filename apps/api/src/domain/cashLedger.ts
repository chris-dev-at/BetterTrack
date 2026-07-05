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
 * later service issue: (1) the value series fed to `timeWeightedReturn` must
 * *include* the cash balance (deposit day: value +1000 with a +1000 flow →
 * flat; buy day: value unchanged, no flow → flat); (2) a cash-funded buy/sell
 * transaction must **not** additionally enter `netFlowsOverTime` — its
 * external flow was already booked when the cash was deposited, and counting
 * it again would double the flow.
 */

import type { FlowPoint } from './holdings';

// ---------------------------------------------------------------------------
// Movement kinds & constants
// ---------------------------------------------------------------------------

/** Every cash-movement kind, external and internal. */
export const CASH_MOVEMENT_KINDS = ['deposit', 'withdrawal', 'buy', 'sell_proceeds'] as const;

export type CashMovementKind = (typeof CASH_MOVEMENT_KINDS)[number];

/**
 * Required sign of `amountEur` per kind: inflows (`deposit`, `sell_proceeds`)
 * are strictly positive, outflows (`withdrawal`, `buy`) strictly negative.
 */
export const CASH_MOVEMENT_SIGN: Readonly<Record<CashMovementKind, 1 | -1>> = {
  deposit: 1,
  sell_proceeds: 1,
  withdrawal: -1,
  buy: -1,
};

/**
 * The kinds that are **external** flows for TWR purposes: money crossing the
 * portfolio boundary. `buy` / `sell_proceeds` are internal (cash ↔ shares form
 * change) and deliberately absent.
 */
export const EXTERNAL_CASH_MOVEMENT_KINDS: readonly CashMovementKind[] = ['deposit', 'withdrawal'];

/**
 * EUR comparison tolerance for the non-negativity gate (mirrors `holdings`'
 * `VALUE_EPSILON`): a balance within this of zero is FP dust from decimal EUR
 * arithmetic, not a real overdraft. Used only for the *comparison* — balances
 * themselves are never rounded or clamped (§5.4).
 */
export const CASH_EPSILON = 1e-9;

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
