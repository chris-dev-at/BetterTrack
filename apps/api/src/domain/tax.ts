/**
 * Realized-P/L & tax engine — pure domain core (V3-P4, §13.3, issue #331).
 *
 * The money-math rulebook behind Settings → Taxes: EUR-denominated
 * moving-average cost basis, per-sell realized gain/loss, calendar-year
 * bucketing (Europe/Vienna), the Austrian flat-KESt settlement with same-year
 * loss offset, and the manual per-trade tax entry. Like the rest of
 * `domain/**` this is T1 code with **no imports at all** — no DB, HTTP,
 * contracts, providers, or clock. Everything is a pure function of its inputs;
 * the service layer owns FX conversion (transactions arrive here already in
 * EUR at their trade-date rates), persistence, and movement posting.
 *
 * **Cost basis (Austria-correct method).** Austria taxes realized capital
 * gains against the *moving average* acquisition price (gleitender
 * Durchschnittspreis), not FIFO tax lots. {@link realizedSellsEur} replays a
 * transaction log chronologically: a BUY re-averages
 * `avg = (held·avg + qty·price + fee) / (held + qty)` and a SELL realizes
 * `qty·(price − avg) − fee` without changing the average — exactly the
 * semantics of `holdings.reducePosition`, but denominated in **EUR at each
 * trade's own date** (§16 2026-07-08): acquisition cost enters at the buy-day
 * rate and proceeds at the sell-day rate, so FX moves are part of the taxable
 * gain, as they are for KESt.
 *
 * **Year ledger (the AT settlement rule).** Within one Vienna calendar year,
 * the tax **held** for a portfolio must always equal
 *
 *     target(year) = round( AT_KEST_RATE · max(0, pool(year)) )
 *
 * where `pool(year)` is the sum of realized gains/losses of AT-taxed sells
 * plus gross AT-taxed dividends of that year. Every recorded event settles
 * the *delta* between the new target and what is already held: a positive
 * delta is a withholding, a negative one a refund ("a loss sell refunds tax
 * already paid that year down to the year's net position"). Because the pool
 * is clamped at zero, tax held is never negative — a January loss with no
 * prior gains simply parks in the pool and offsets later same-year gains. The
 * year resets hard on Jan 1: {@link settleAtYear} only ever sees one year's
 * events, and the caller buckets by {@link viennaYearOf} — there is no carry
 * across years by construction.
 *
 * **Rounding.** Averages, pools and gains stay at full FP precision (§5.4 —
 * no mid-computation rounding); only *settlement deltas* — amounts that
 * become stored movements — are quantized to whole cents via a local
 * {@link floorCents} (the V3-P0 lesson, #322). The quantizer mirrors
 * `cashLedger.floorCents` exactly; it is re-declared here because `domain/**`
 * modules import nothing (a value import would breach the purity rule), and
 * its parity is pinned by tests on both sides.
 */

// ---------------------------------------------------------------------------
// Modes & constants
// ---------------------------------------------------------------------------

/**
 * Tax modes (§13.3 V3-P4b). `none` = exact pre-V3-P4 behavior; `manual_per_trade`
 * = optional user-entered tax per sell/dividend, zero automation;
 * `country_specific` = automated computation for `TAX_COUNTRY_AT` (the only
 * shipped country). Mirrored (not imported) by `@bettertrack/contracts`.
 */
export const TAX_MODES = ['none', 'manual_per_trade', 'country_specific'] as const;
export type TaxMode = (typeof TAX_MODES)[number];

/** The single shipped country of `country_specific` mode (§13.3 V3-P4b). */
export const TAX_COUNTRY_AT = 'AT';

/** Austrian flat KESt rate on realized gains and dividends (§13.3 V3-P4b). */
export const AT_KEST_RATE = 0.275;

/**
 * The timezone whose calendar defines a tax year (§16 2026-07-08): trades are
 * bucketed by their trade date's year **in Europe/Vienna**, so a Dec-31 23:30
 * UTC sell belongs to the new Vienna year.
 */
export const TAX_YEAR_TIME_ZONE = 'Europe/Vienna';

/**
 * Quantity comparison tolerance, mirroring `holdings.QTY_EPSILON` (quantities
 * are stored at scale 8; this sits an order of magnitude below the smallest
 * meaningful unit). Re-declared locally — see the module header on imports.
 */
export const QTY_EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Invalid input to the tax engine — malformed timestamps, non-finite amounts,
 * a sell exceeding the held quantity, contradictory manual-tax input. Typed so
 * the service can map caller mistakes to a 4xx instead of a 500.
 */
export class TaxComputationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaxComputationError';
  }
}

// ---------------------------------------------------------------------------
// Cent quantizer (local mirror of cashLedger.floorCents — see module header)
// ---------------------------------------------------------------------------

/**
 * Quantize a EUR amount **down** to whole cents — floor toward zero, never round
 * up (the #370 money policy). Nudges a value a few ULPs below a cent boundary
 * (`8.61 → 860.999…9`) back onto it before truncating, so exact cents survive
 * float error while a genuine sub-cent residue still floors away. Exact mirror
 * of `cashLedger.floorCents` (#322/#370); parity is pinned by tests.
 */
export function floorCents(amountEur: number): number {
  if (!Number.isFinite(amountEur)) {
    throw new TaxComputationError(`Cannot floor a non-finite EUR amount, got ${amountEur}.`);
  }
  const sign = amountEur < 0 ? -1 : 1;
  const cents = Math.floor(Math.abs(amountEur) * 100 * (1 + Number.EPSILON * 8));
  return cents === 0 ? 0 : (sign * cents) / 100;
}

// ---------------------------------------------------------------------------
// Vienna calendar year
// ---------------------------------------------------------------------------

// One shared formatter: constructing Intl.DateTimeFormat per call is costly,
// and the mapping (UTC instant → Vienna year) is deterministic — no clock.
const viennaYearFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TAX_YEAR_TIME_ZONE,
  year: 'numeric',
});

/**
 * The Europe/Vienna calendar year a timestamp falls in (§16 2026-07-08) — the
 * tax-year bucket of a trade/dividend. Deterministic; unparseable input fails
 * loud with {@link TaxComputationError}.
 */
export function viennaYearOf(isoTimestamp: string): number {
  const ms = Date.parse(isoTimestamp);
  if (Number.isNaN(ms)) {
    throw new TaxComputationError(
      `Timestamp must be ISO-8601 date/time, got ${String(isoTimestamp)}`,
    );
  }
  const year = Number(viennaYearFormatter.format(ms));
  if (!Number.isFinite(year)) {
    throw new TaxComputationError(`Could not derive a Vienna year from ${isoTimestamp}`);
  }
  return year;
}

// ---------------------------------------------------------------------------
// EUR moving-average cost basis & per-sell realizations
// ---------------------------------------------------------------------------

/**
 * One transaction pre-converted to EUR at its **own trade-date** FX rate
 * (§5.4 historical rates — the service converts; the domain never sees FX).
 * `priceEur` is per unit, `feeEur` the total fee.
 */
export interface TaxableTransaction {
  /** Row id, so realizations can be joined back to their sells. */
  id: string;
  assetId: string;
  side: 'buy' | 'sell';
  /** Units transacted; strictly positive. */
  quantity: number;
  /** Price per unit in EUR at the trade date; non-negative. */
  priceEur: number;
  /** Total fee in EUR at the trade date; non-negative. */
  feeEur: number;
  /** ISO-8601 timestamp; orders the replay and buckets the tax year. */
  executedAt: string;
  /**
   * Uncovered sell (issue #369). When true, a SELL exceeding the held quantity
   * is permitted instead of throwing: the covered shares realize against the
   * running average, the uncovered remainder against {@link uncoveredEntryPriceEur}
   * (or the sale price when absent → 0 realized on that portion), and the
   * position closes at 0. Absent → the strict behavior (an oversell throws,
   * meaning the log is inconsistent). Ignored on buys / covered sells.
   */
  allowUncovered?: boolean;
  /**
   * EUR per-unit basis for the uncovered portion of an {@link allowUncovered}
   * SELL (issue #369; the service converts the user-supplied native price at the
   * sell's trade date). `null`/absent → the uncovered shares take the sale price
   * as their basis, so they book **no gain** — the AT ledger never taxes a
   * phantom acquisition.
   */
  uncoveredEntryPriceEur?: number | null;
}

/** The EUR outcome of one SELL against the running moving average. */
export interface SellRealizationEur {
  /** The sell transaction's id. */
  id: string;
  assetId: string;
  executedAt: string;
  quantity: number;
  /** `quantity · priceEur − feeEur`: net proceeds, EUR. */
  proceedsEur: number;
  /**
   * The released cost basis, EUR. For a covered sell this is `quantity · avg`;
   * for an uncovered sell (issue #369) it is `covered · avg +
   * uncovered · uncoveredBasis`, so the uncovered shares are basised at their
   * supplied entry price — or the sale price (→ they add exactly their own
   * proceeds, contributing 0 gain), never at the covered lot's average.
   */
  costBasisEur: number;
  /** `proceedsEur − costBasisEur`, EUR (signed). */
  realizedPnlEur: number;
  /**
   * Units of this SELL sold without a real, registered-buy basis (issue #369);
   * 0 for a normal covered sell. Their basis is estimated (the sale price) or
   * user-supplied — **not** a recorded acquisition — so downstream reporting can
   * mark it "basis unknown / user-supplied" rather than trusting it like real
   * cost. The AT settlement never taxes a phantom gain because, for the sale-
   * price default, these shares realize 0.
   */
  uncoveredQuantity: number;
}

function assertFiniteNonNegative(value: number, label: string, id: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TaxComputationError(
      `${label} must be a finite non-negative number, got ${value} (transaction ${id}).`,
    );
  }
}

/** Epoch-ms of `executedAt`; unparseable input fails loud. */
function executedAtToMs(executedAt: string, id: string): number {
  const ms = Date.parse(executedAt);
  if (Number.isNaN(ms)) {
    throw new TaxComputationError(
      `Transaction executedAt must be ISO-8601, got ${String(executedAt)} (transaction ${id}).`,
    );
  }
  return ms;
}

/**
 * Replay a (multi-asset) EUR transaction log through the moving-average cost
 * basis and return one {@link SellRealizationEur} per SELL, in chronological
 * order (`executedAt` ascending as epoch-ms — never a string compare — with
 * ties broken by input order, mirroring `holdings.reducePosition`).
 *
 * Semantics per asset are exactly `reducePosition`'s, in EUR: BUY re-averages
 * with the fee capitalised into the basis; SELL realizes against the running
 * average, leaves the average unchanged, and clamps float dust when the
 * position closes. A sell exceeding the held quantity beyond
 * {@link QTY_EPSILON} throws — the primary oversell gate lives on the write
 * path; here it means the caller fed an inconsistent log, and a silently
 * wrong basis would poison every tax figure downstream.
 *
 * Full FP precision throughout — quantize only the derived settlement deltas
 * ({@link settleAtYear}), never the replay.
 */
export function realizedSellsEur(
  transactions: readonly TaxableTransaction[],
): SellRealizationEur[] {
  const ordered = transactions
    .map((t, index) => ({ t, index, ms: executedAtToMs(t.executedAt, t.id) }))
    .sort((a, b) => a.ms - b.ms || a.index - b.index);

  const positions = new Map<string, { held: number; avg: number }>();
  const realizations: SellRealizationEur[] = [];

  for (const { t } of ordered) {
    if (!Number.isFinite(t.quantity) || t.quantity <= 0) {
      throw new TaxComputationError(
        `Transaction quantity must be a finite positive number, got ${t.quantity} (transaction ${t.id}).`,
      );
    }
    assertFiniteNonNegative(t.priceEur, 'Transaction priceEur', t.id);
    assertFiniteNonNegative(t.feeEur, 'Transaction feeEur', t.id);

    const pos = positions.get(t.assetId) ?? { held: 0, avg: 0 };

    if (t.side === 'buy') {
      const newHeld = pos.held + t.quantity;
      // newHeld > 0 always (held ≥ 0, quantity > 0), so the division is safe.
      pos.avg = (pos.held * pos.avg + t.quantity * t.priceEur + t.feeEur) / newHeld;
      pos.held = newHeld;
    } else if (t.side === 'sell') {
      const oversell = t.quantity > pos.held + QTY_EPSILON;
      if (oversell && !t.allowUncovered) {
        // Not an acknowledged uncovered sell (issue #369): a genuine oversell in
        // the replay means the caller fed an inconsistent log, and a silently
        // wrong basis would poison every tax figure downstream.
        throw new TaxComputationError(
          `Sell of ${t.quantity} exceeds the held ${pos.held} units of ${t.assetId} ` +
            `(transaction ${t.id}); the transaction log is inconsistent.`,
        );
      }
      // Covered shares release the running average; the uncovered remainder is
      // basised at its supplied EUR entry price, or the sale price when none was
      // given (→ 0 gain, no phantom acquisition to tax). No shorts: the position
      // closes at 0 on an uncovered sell.
      const covered = oversell ? pos.held : t.quantity;
      const uncovered = oversell ? t.quantity - pos.held : 0;
      if (uncovered > 0 && t.uncoveredEntryPriceEur != null) {
        assertFiniteNonNegative(
          t.uncoveredEntryPriceEur,
          'Transaction uncoveredEntryPriceEur',
          t.id,
        );
      }
      const uncoveredBasisEur = t.uncoveredEntryPriceEur ?? t.priceEur;
      const proceedsEur = t.quantity * t.priceEur - t.feeEur;
      const costBasisEur = covered * pos.avg + uncovered * uncoveredBasisEur;
      realizations.push({
        id: t.id,
        assetId: t.assetId,
        executedAt: t.executedAt,
        quantity: t.quantity,
        proceedsEur,
        costBasisEur,
        realizedPnlEur: proceedsEur - costBasisEur,
        uncoveredQuantity: uncovered,
      });
      if (oversell) {
        pos.held = 0;
        pos.avg = 0;
      } else {
        pos.held -= t.quantity;
        // Clamp float dust: selling everything leaves ~±1e-15, not 0.
        if (Math.abs(pos.held) <= QTY_EPSILON) {
          pos.held = 0;
          pos.avg = 0;
        }
      }
    } else {
      throw new TaxComputationError(
        `Unknown transaction side ${String(t.side)} (transaction ${t.id}).`,
      );
    }

    positions.set(t.assetId, pos);
  }

  return realizations;
}

// ---------------------------------------------------------------------------
// AT year settlement (flat KESt, same-year offset, hard Jan-1 reset)
// ---------------------------------------------------------------------------

/**
 * The tax a year's AT pool demands: `AT_KEST_RATE · max(0, pool)`, quantized
 * to cents (this *is* a boundary amount — the invariant every settlement
 * steers the held total to). A net-loss year clamps to €0.00: tax held is
 * never negative, and the loss does NOT carry into the next year (hard Jan-1
 * reset, §16).
 */
export function atYearTargetEur(poolEur: number): number {
  if (!Number.isFinite(poolEur)) {
    throw new TaxComputationError(`Year pool must be a finite EUR amount, got ${poolEur}.`);
  }
  return floorCents(AT_KEST_RATE * Math.max(0, poolEur));
}

/** One not-yet-recorded AT event entering a year's pool via {@link settleAtYear}. */
export interface NewAtEvent {
  /**
   * `sell_gain` contributes a **signed** realized gain/loss; `dividend` a
   * strictly positive gross amount. Both in EUR.
   */
  kind: 'sell_gain' | 'dividend';
  amountEur: number;
}

/** Input of {@link settleAtYear} — one Vienna year of one portfolio. */
export interface AtYearSettlementInput {
  /**
   * **Recomputed** realized gains/losses (EUR, signed) of the year's already-
   * persisted AT-taxed sells — recomputed against the *current* transaction
   * log, so a backdated buy that shifted the moving average is reflected and
   * the settlement self-corrects (§16: append-only re-derivation).
   */
  existingGainsEur: readonly number[];
  /** Gross EUR amounts of the year's already-persisted AT-taxed dividends. */
  existingDividendsEur: readonly number[];
  /**
   * Tax currently held for this year, EUR (cent-exact): what the year's
   * withholding movements minus refund movements sum to.
   */
  heldEur: number;
  /** New AT events being recorded now, in recording order (possibly empty). */
  newEvents: readonly NewAtEvent[];
}

/** Output of {@link settleAtYear}: the cent-exact deltas to post as movements. */
export interface AtYearSettlementResult {
  /**
   * Delta (EUR, signed: positive = withhold, negative = refund) that brings
   * the already-persisted events' target in line with `heldEur` *before* any
   * new event applies — non-zero only when history was re-shaped (backdated
   * buy, deletion) and posts as an unattached correction movement.
   */
  correctionDeltaEur: number;
  /** Marginal delta per new event, in input order (same sign convention). */
  newEventDeltasEur: number[];
  /** Held after all deltas — always exactly the year's final target. */
  heldAfterEur: number;
}

function assertFiniteAmount(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new TaxComputationError(`${label} must be a finite EUR amount, got ${value}.`);
  }
}

/**
 * Settle one Vienna year of one portfolio under AT mode: compute the
 * cent-exact withholding/refund deltas that keep the year's held tax equal to
 * {@link atYearTargetEur} of its pool after every event.
 *
 * The pool is `Σ existing gains + Σ existing dividends`, then each new event
 * joins in order and yields its **marginal** delta — so the sequence
 * `+450 gain, −100 loss` produces `+123.75` then `−27.50`, landing on
 * `27.5 % × 350 = 96.25` held (the owner's required example), while a
 * loss-first year parks at €0.00 held (no negative tax) and later gains are
 * only taxed on the net. Since only ONE year's events ever enter, a February
 * loss can never see November-of-last-year gains: no cross-year carry by
 * construction.
 *
 * `correctionDeltaEur` reconciles drift *before* the new events: when a
 * backdated buy re-shaped existing sells' gains (or a deletion removed an
 * event and its movements), the recomputed existing target no longer matches
 * `heldEur`, and the difference posts as its own correction movement rather
 * than polluting a new event's attribution. All deltas are cent-quantized;
 * `heldAfterEur` is exactly the final target.
 */
export function settleAtYear(input: AtYearSettlementInput): AtYearSettlementResult {
  assertFiniteAmount(input.heldEur, 'heldEur');
  let poolEur = 0;
  for (const gain of input.existingGainsEur) {
    assertFiniteAmount(gain, 'Existing realized gain');
    poolEur += gain;
  }
  for (const dividend of input.existingDividendsEur) {
    assertFiniteAmount(dividend, 'Existing dividend');
    if (dividend <= 0) {
      throw new TaxComputationError(
        `Existing dividend gross amounts must be strictly positive, got ${dividend}.`,
      );
    }
    poolEur += dividend;
  }

  const correctionDeltaEur = floorCents(atYearTargetEur(poolEur) - input.heldEur);
  let heldEur = floorCents(input.heldEur + correctionDeltaEur);

  const newEventDeltasEur: number[] = [];
  for (const event of input.newEvents) {
    assertFiniteAmount(event.amountEur, 'New event amount');
    if (event.kind === 'dividend') {
      if (event.amountEur <= 0) {
        throw new TaxComputationError(
          `Dividend gross amounts must be strictly positive, got ${event.amountEur}.`,
        );
      }
    } else if (event.kind !== 'sell_gain') {
      throw new TaxComputationError(`Unknown AT event kind ${String(event.kind)}.`);
    }
    poolEur += event.amountEur;
    const deltaEur = floorCents(atYearTargetEur(poolEur) - heldEur);
    newEventDeltasEur.push(deltaEur);
    heldEur = floorCents(heldEur + deltaEur);
  }

  return { correctionDeltaEur, newEventDeltasEur, heldAfterEur: heldEur };
}

// ---------------------------------------------------------------------------
// Settlement delta → movement mapping
// ---------------------------------------------------------------------------

/** The two cash-movement kinds tax settlements post (§13.3 V3-P4b). */
export type TaxMovementKind = 'tax_withholding' | 'tax_refund';

/** A settlement delta expressed as the signed movement it must post. */
export interface TaxMovementSpec {
  kind: TaxMovementKind;
  /** Signed EUR amount per the ledger convention: withholding < 0, refund > 0. */
  amountEur: number;
}

/**
 * Map a settlement delta to the cash movement that posts it: a positive delta
 * (more tax due) is a `tax_withholding` carrying `−delta`, a negative one a
 * `tax_refund` carrying `+|delta|`, and a zero delta posts nothing (`null`).
 * The delta must already be cent-quantized (it always is — every delta above
 * passes through {@link floorCents}).
 */
export function taxMovementForDelta(deltaEur: number): TaxMovementSpec | null {
  assertFiniteAmount(deltaEur, 'Settlement delta');
  if (deltaEur === 0) return null;
  return deltaEur > 0
    ? { kind: 'tax_withholding', amountEur: -deltaEur }
    : { kind: 'tax_refund', amountEur: -deltaEur };
}

// ---------------------------------------------------------------------------
// Manual per-trade tax (zero automation)
// ---------------------------------------------------------------------------

/** Input of {@link manualTaxEur}: at most one of amount / rate. */
export interface ManualTaxInput {
  /** Absolute tax in EUR (≥ 0), as the user entered it. */
  taxAmountEur?: number | null;
  /** Percentage (0–100) applied to `baseEur`. */
  taxRatePct?: number | null;
  /**
   * The base a percentage applies to: the sell's realized gain (signed) or a
   * dividend's gross amount. Clamped at 0 for the percentage — a loss sell
   * with a rate entry records €0.00 tax, never a negative one (manual mode
   * has no refund concept; refunds are the AT engine's job).
   */
  baseEur: number;
}

/**
 * The manual-mode tax for one sell/dividend (§13.3 V3-P4b: "optional tax
 * amount-or-% entry, recorded + reported, zero automation"): the entered
 * amount as-is, or `pct · max(0, base) / 100`, cent-quantized — or `null`
 * when the user entered nothing (no tax recorded, no movement). Entering both
 * an amount and a rate, a negative amount, or a rate outside 0–100 fails loud.
 */
export function manualTaxEur(input: ManualTaxInput): number | null {
  const hasAmount = input.taxAmountEur !== undefined && input.taxAmountEur !== null;
  const hasRate = input.taxRatePct !== undefined && input.taxRatePct !== null;
  if (hasAmount && hasRate) {
    throw new TaxComputationError('Provide a manual tax amount OR a rate, not both.');
  }
  if (!hasAmount && !hasRate) return null;
  assertFiniteAmount(input.baseEur, 'Manual tax base');
  if (hasAmount) {
    const amount = input.taxAmountEur!;
    if (!Number.isFinite(amount) || amount < 0) {
      throw new TaxComputationError(
        `Manual tax amount must be a finite non-negative EUR amount, got ${amount}.`,
      );
    }
    return floorCents(amount);
  }
  const rate = input.taxRatePct!;
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw new TaxComputationError(`Manual tax rate must be between 0 and 100, got ${rate}.`);
  }
  return floorCents((rate / 100) * Math.max(0, input.baseEur));
}
