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
 * Tax modes (§13.3 V3-P4b; §13.5 V5-P4c). `none` = exact pre-V3-P4 behavior;
 * `manual_per_trade` = optional user-entered tax per sell/dividend, zero
 * automation; `country_specific` = automated computation for AT/DE; `custom` =
 * the user-parameterized rule-built engine ({@link settleCustomYear}).
 * Mirrored (not imported) by `@bettertrack/contracts`.
 */
export const TAX_MODES = ['none', 'manual_per_trade', 'country_specific', 'custom'] as const;
export type TaxMode = (typeof TAX_MODES)[number];

/** The first shipped country of `country_specific` mode (§13.3 V3-P4b). */
export const TAX_COUNTRY_AT = 'AT';

/** The second shipped country of `country_specific` mode (§13.5 V5-P4, #580). */
export const TAX_COUNTRY_DE = 'DE';

/** Austrian flat KESt rate on realized gains and dividends (§13.3 V3-P4b). */
export const AT_KEST_RATE = 0.275;

/** German flat Abgeltungsteuer rate on capital income (§32d Abs. 1 EStG). */
export const DE_KAPEST_RATE = 0.25;

/** Solidaritätszuschlag, levied on the KapESt itself (§3 Abs. 1 Nr. 5, §4 SolzG). */
export const DE_SOLI_RATE = 0.055;

/**
 * Sparer-Pauschbetrag per calendar year (§20 Abs. 9 EStG; €1,000 since VZ
 * 2023). Applied after loss offset, floored at zero; the unused remainder does
 * NOT carry into the next year — unlike the loss pots, which do.
 */
export const DE_SPARER_PAUSCHBETRAG_EUR = 1000;

/**
 * Cost-basis strategies of the EUR tax replay (V5-P4, #580): `moving-average`
 * is the AT method (gleitender Durchschnittspreis — the pre-V5-P4 behavior,
 * byte-identical), `fifo` the German per-lot consumption (§20 Abs. 4 Satz 7
 * EStG). The strategy is selected by the active tax country via
 * {@link costBasisStrategyForCountry}; the P4 custom tax mode will later pick
 * one directly through the same seam.
 */
export const COST_BASIS_STRATEGIES = ['moving-average', 'fifo'] as const;
export type CostBasisStrategy = (typeof COST_BASIS_STRATEGIES)[number];

/** The cost-basis strategy a tax country mandates (DE = FIFO, AT = average). */
export function costBasisStrategyForCountry(country: string | null | undefined): CostBasisStrategy {
  return country === TAX_COUNTRY_DE ? 'fifo' : 'moving-average';
}

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
 * One FIFO tax lot (§20 Abs. 4 Satz 7 EStG): units still held from one BUY,
 * basised at the buy's per-unit price plus its pro-rated fee
 * (Anschaffungsnebenkosten capitalise into the lot, mirroring how the buy fee
 * enters the moving average).
 */
interface FifoLot {
  units: number;
  perUnitEur: number;
}

/** Per-asset replay state — one variant per {@link CostBasisStrategy}. */
type PositionState =
  | { strategy: 'moving-average'; held: number; avg: number }
  | { strategy: 'fifo'; lots: FifoLot[] };

const fifoHeld = (lots: readonly FifoLot[]): number =>
  lots.reduce((sum, lot) => sum + lot.units, 0);

/**
 * Consume `quantity` units from the front of the lot queue (oldest first,
 * §20 Abs. 4 Satz 7) and return the released cost basis, EUR. The caller has
 * already verified coverage; a shortfall beyond {@link QTY_EPSILON} would mean
 * the queue and the covered quantity disagree — fail loud, never fabricate.
 */
function consumeFifoLots(lots: FifoLot[], quantity: number, id: string): number {
  let remaining = quantity;
  let releasedEur = 0;
  while (remaining > QTY_EPSILON) {
    const lot = lots[0];
    if (!lot) {
      throw new TaxComputationError(
        `FIFO lot queue exhausted with ${remaining} units unconsumed (transaction ${id}).`,
      );
    }
    const take = Math.min(lot.units, remaining);
    releasedEur += take * lot.perUnitEur;
    lot.units -= take;
    remaining -= take;
    // Drop the lot once fully consumed (float dust included).
    if (lot.units <= QTY_EPSILON) lots.shift();
  }
  return releasedEur;
}

/**
 * Replay a (multi-asset) EUR transaction log through the chosen cost-basis
 * strategy and return one {@link SellRealizationEur} per SELL, in
 * chronological order (`executedAt` ascending as epoch-ms — never a string
 * compare — with ties broken by input order, mirroring
 * `holdings.reducePosition`).
 *
 * The default `moving-average` strategy is the AT method with exactly the
 * pre-V5-P4 semantics (byte-identical — same operations in the same order):
 * BUY re-averages with the fee capitalised into the basis; SELL realizes
 * against the running average, leaves the average unchanged, and clamps float
 * dust when the position closes. The `fifo` strategy (DE, §20 Abs. 4 Satz 7
 * EStG) keeps per-buy lots instead: BUY enqueues a lot basised at price plus
 * pro-rated fee; SELL consumes lots oldest-first and realizes against the
 * consumed lots' basis. Sell fees reduce proceeds identically under both.
 *
 * A sell exceeding the held quantity beyond {@link QTY_EPSILON} throws unless
 * acknowledged as uncovered (#369) — the primary oversell gate lives on the
 * write path; here it means the caller fed an inconsistent log, and a silently
 * wrong basis would poison every tax figure downstream. An uncovered sell
 * behaves the same under both strategies: the covered shares release their
 * strategy basis, the uncovered remainder is basised at the supplied entry
 * price (or the sale price → 0 gain), and the position closes at 0.
 *
 * Full FP precision throughout — quantize only the derived settlement deltas
 * ({@link settleAtYear} / {@link settleDeYear}), never the replay.
 */
export function realizedSellsEur(
  transactions: readonly TaxableTransaction[],
  strategy: CostBasisStrategy = 'moving-average',
): SellRealizationEur[] {
  const ordered = transactions
    .map((t, index) => ({ t, index, ms: executedAtToMs(t.executedAt, t.id) }))
    .sort((a, b) => a.ms - b.ms || a.index - b.index);

  const positions = new Map<string, PositionState>();
  const realizations: SellRealizationEur[] = [];
  const emptyPosition = (): PositionState =>
    strategy === 'fifo'
      ? { strategy: 'fifo', lots: [] }
      : { strategy: 'moving-average', held: 0, avg: 0 };

  for (const { t } of ordered) {
    if (!Number.isFinite(t.quantity) || t.quantity <= 0) {
      throw new TaxComputationError(
        `Transaction quantity must be a finite positive number, got ${t.quantity} (transaction ${t.id}).`,
      );
    }
    assertFiniteNonNegative(t.priceEur, 'Transaction priceEur', t.id);
    assertFiniteNonNegative(t.feeEur, 'Transaction feeEur', t.id);

    const pos = positions.get(t.assetId) ?? emptyPosition();

    if (t.side === 'buy') {
      if (pos.strategy === 'moving-average') {
        const newHeld = pos.held + t.quantity;
        // newHeld > 0 always (held ≥ 0, quantity > 0), so the division is safe.
        pos.avg = (pos.held * pos.avg + t.quantity * t.priceEur + t.feeEur) / newHeld;
        pos.held = newHeld;
      } else {
        // The lot's per-unit basis is price plus pro-rated buy fee — total lot
        // cost / units, so a fully consumed lot releases exactly qty·price + fee.
        pos.lots.push({
          units: t.quantity,
          perUnitEur: (t.quantity * t.priceEur + t.feeEur) / t.quantity,
        });
      }
    } else if (t.side === 'sell') {
      const heldUnits = pos.strategy === 'moving-average' ? pos.held : fifoHeld(pos.lots);
      const oversell = t.quantity > heldUnits + QTY_EPSILON;
      if (oversell && !t.allowUncovered) {
        // Not an acknowledged uncovered sell (issue #369): a genuine oversell in
        // the replay means the caller fed an inconsistent log, and a silently
        // wrong basis would poison every tax figure downstream.
        throw new TaxComputationError(
          `Sell of ${t.quantity} exceeds the held ${heldUnits} units of ${t.assetId} ` +
            `(transaction ${t.id}); the transaction log is inconsistent.`,
        );
      }
      // Covered shares release the strategy basis; the uncovered remainder is
      // basised at its supplied EUR entry price, or the sale price when none was
      // given (→ 0 gain, no phantom acquisition to tax). No shorts: the position
      // closes at 0 on an uncovered sell.
      const covered = oversell ? heldUnits : t.quantity;
      const uncovered = oversell ? t.quantity - heldUnits : 0;
      if (uncovered > 0 && t.uncoveredEntryPriceEur != null) {
        assertFiniteNonNegative(
          t.uncoveredEntryPriceEur,
          'Transaction uncoveredEntryPriceEur',
          t.id,
        );
      }
      const uncoveredBasisEur = t.uncoveredEntryPriceEur ?? t.priceEur;
      const proceedsEur = t.quantity * t.priceEur - t.feeEur;
      const coveredBasisEur =
        pos.strategy === 'moving-average'
          ? covered * pos.avg
          : oversell
            ? // Full close: release every lot exactly (no dust left behind).
              pos.lots.reduce((sum, lot) => sum + lot.units * lot.perUnitEur, 0)
            : consumeFifoLots(pos.lots, covered, t.id);
      const costBasisEur = coveredBasisEur + uncovered * uncoveredBasisEur;
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
      if (pos.strategy === 'moving-average') {
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
      } else if (oversell || fifoHeld(pos.lots) <= QTY_EPSILON) {
        pos.lots.length = 0;
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
// DE year settlement (Abgeltungsteuer + Soli, dual loss pots, allowance)
// ---------------------------------------------------------------------------

/**
 * Loss-pot category of a sale under §20 Abs. 6 EStG: `aktien` = shares (app
 * asset type `stock`), `sonstige` = everything else. Dividends carry no
 * category — they are always Sonstige-side income (§20 Abs. 1 Nr. 1: not
 * Veräußerungsgewinne, so the Aktien ring-fence never reaches them).
 */
export type DePotCategory = 'aktien' | 'sonstige';

/** The DE loss pot an app asset type's sale P/L belongs to (#576: `stock` → aktien). */
export function dePotCategoryForAssetType(assetType: string): DePotCategory {
  return assetType === 'stock' ? 'aktien' : 'sonstige';
}

/**
 * One taxable DE event entering a year: a sell's **signed** FIFO realized
 * gain/loss with its pot {@link DePotCategory}, or a strictly positive gross
 * dividend (always Sonstige-side — no category to pick).
 */
export type DeTaxableEvent =
  | { kind: 'sell_gain'; category: DePotCategory; amountEur: number }
  | { kind: 'dividend'; amountEur: number };

/** Both DE loss pots, stored positive (a pot holds losses; ≥ 0 by construction). */
export interface DePots {
  aktienEur: number;
  sonstigeEur: number;
}

/** The aggregate inputs of one DE calendar year (field names mirror #576's fixtures). */
export interface DeYearAggregates {
  /** Aktien loss pot carried IN from the prior year (≥ 0). */
  aktienPotInEur: number;
  /** Sonstige loss pot carried IN from the prior year (≥ 0). */
  sonstigePotInEur: number;
  /** Signed Σ of the year's Aktien-sale realized P/L. */
  aktienSalePnlEur: number;
  /** Signed Σ of the year's Sonstige-sale realized P/L. */
  sonstigeSalePnlEur: number;
  /** Σ of the year's gross dividends (Sonstige-side income; ≥ 0). */
  dividendsEur: number;
}

/** The DE year-end state {@link deYearOutcome} derives from the aggregates. */
export interface DeYearOutcome {
  /** Positive income remaining after both pots + the cross-offset. */
  taxableBeforeAllowanceEur: number;
  /** Sparer-Pauschbetrag consumed (≤ {@link DE_SPARER_PAUSCHBETRAG_EUR}). */
  allowanceUsedEur: number;
  /** Allowance left unused — lost at year end, never carried (§20 Abs. 9). */
  allowanceRemainingEur: number;
  /** `taxableBeforeAllowanceEur − allowanceUsedEur`. */
  taxableBaseEur: number;
  /** `floorCents(DE_KAPEST_RATE · taxableBaseEur)` (§32d Abs. 1 EStG). */
  kapestEur: number;
  /** `floorCents(DE_SOLI_RATE · kapestEur)` (§4 Satz 2 SolzG — statutory floor). */
  soliEur: number;
  /** `kapestEur + soliEur`, cent-exact — the year's held target. */
  totalTaxEur: number;
  /** Aktien loss pot carried OUT to the next year (≥ 0). */
  aktienPotOutEur: number;
  /** Sonstige loss pot carried OUT to the next year (≥ 0). */
  sonstigePotOutEur: number;
}

function assertDeAggregates(agg: DeYearAggregates): void {
  assertFiniteAmount(agg.aktienSalePnlEur, 'Aktien sale P/L');
  assertFiniteAmount(agg.sonstigeSalePnlEur, 'Sonstige sale P/L');
  assertFiniteAmount(agg.dividendsEur, 'Dividends sum');
  for (const [label, value] of [
    ['Aktien pot in', agg.aktienPotInEur],
    ['Sonstige pot in', agg.sonstigePotInEur],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TaxComputationError(
        `${label} must be a finite non-negative EUR amount, got ${value}.`,
      );
    }
  }
  if (agg.dividendsEur < 0) {
    throw new TaxComputationError(`Dividends sum must be non-negative, got ${agg.dividendsEur}.`);
  }
}

/**
 * The German year-end function (§16 2026-07-17; the analog of
 * {@link atYearTargetEur}, richer because DE state spans pots and allowance):
 *
 *     aktienRemainder   = Σ Aktien-sale P/L − aktienPotIn
 *     sonstigeRemainder = Σ dividends + Σ other-sale P/L − sonstigePotIn
 *     // one-directional cross-offset (§20 Abs. 6 Satz 4): a NEGATIVE
 *     // Sonstige remainder also offsets a positive Aktien remainder;
 *     // an Aktien loss NEVER offsets Sonstige income (the ring-fence).
 *     taxableBeforeAllowance = remaining positives after that offset
 *     allowanceUsed = min(SPARER_PAUSCHBETRAG, taxableBeforeAllowance)
 *     KapESt = floorCents(0.25 · (taxableBeforeAllowance − allowanceUsed))
 *     Soli   = floorCents(0.055 · KapESt)
 *     target = KapESt + Soli; negative remainders leave as potOut (carry).
 *
 * KapESt cent-flooring is the app's #370 floor-toward-zero money policy; the
 * Soli floor is statutory ("Bruchteile eines Cents bleiben außer Ansatz").
 * Aggregates stay at full FP precision (§5.4); only the two tax figures — and
 * their sum, re-floored to kill float dust — are quantized, because they are
 * the boundary amounts settlements steer the held total to.
 */
export function deYearOutcome(agg: DeYearAggregates): DeYearOutcome {
  assertDeAggregates(agg);
  const aktienRemainder = agg.aktienSalePnlEur - agg.aktienPotInEur;
  const sonstigeRemainder = agg.dividendsEur + agg.sonstigeSalePnlEur - agg.sonstigePotInEur;
  let aktienPositive = Math.max(0, aktienRemainder);
  const aktienPotOutEur = Math.max(0, -aktienRemainder);
  let sonstigePotOutEur = 0;
  if (sonstigeRemainder < 0) {
    const crossOffset = Math.min(-sonstigeRemainder, aktienPositive);
    aktienPositive -= crossOffset;
    sonstigePotOutEur = -sonstigeRemainder - crossOffset;
  }
  const taxableBeforeAllowanceEur = aktienPositive + Math.max(0, sonstigeRemainder);
  const allowanceUsedEur = Math.min(DE_SPARER_PAUSCHBETRAG_EUR, taxableBeforeAllowanceEur);
  const taxableBaseEur = taxableBeforeAllowanceEur - allowanceUsedEur;
  const kapestEur = floorCents(DE_KAPEST_RATE * taxableBaseEur);
  const soliEur = floorCents(DE_SOLI_RATE * kapestEur);
  return {
    taxableBeforeAllowanceEur,
    allowanceUsedEur,
    allowanceRemainingEur: DE_SPARER_PAUSCHBETRAG_EUR - allowanceUsedEur,
    taxableBaseEur,
    kapestEur,
    soliEur,
    // Both addends are cent-exact; re-floor to normalize FP addition dust.
    totalTaxEur: floorCents(kapestEur + soliEur),
    aktienPotOutEur,
    sonstigePotOutEur,
  };
}

function assertDeEvent(event: DeTaxableEvent): void {
  assertFiniteAmount(event.amountEur, 'DE event amount');
  if (event.kind === 'dividend') {
    if (event.amountEur <= 0) {
      throw new TaxComputationError(
        `Dividend gross amounts must be strictly positive, got ${event.amountEur}.`,
      );
    }
  } else if (event.kind === 'sell_gain') {
    if (event.category !== 'aktien' && event.category !== 'sonstige') {
      throw new TaxComputationError(`Unknown DE pot category ${String(event.category)}.`);
    }
  } else {
    throw new TaxComputationError(
      `Unknown DE event kind ${String((event as { kind: unknown }).kind)}.`,
    );
  }
}

/** Fold one event into a year's running aggregates (mutates `agg`). */
function applyDeEvent(agg: DeYearAggregates, event: DeTaxableEvent): void {
  assertDeEvent(event);
  if (event.kind === 'dividend') {
    agg.dividendsEur += event.amountEur;
  } else if (event.category === 'aktien') {
    agg.aktienSalePnlEur += event.amountEur;
  } else {
    agg.sonstigeSalePnlEur += event.amountEur;
  }
}

/**
 * Chain the DE loss pots across consecutive prior years (§20 Abs. 6 Sätze 2–3:
 * pots carry indefinitely; the allowance never does): fold each prior year's
 * events — ascending, gap years omitted (an empty year passes pots through
 * unchanged) — and return the pots entering the next year. Pots start at zero
 * before the first DE year by construction.
 */
export function deCarryPots(priorYearEvents: ReadonlyArray<readonly DeTaxableEvent[]>): DePots {
  let aktienEur = 0;
  let sonstigeEur = 0;
  for (const events of priorYearEvents) {
    const agg: DeYearAggregates = {
      aktienPotInEur: aktienEur,
      sonstigePotInEur: sonstigeEur,
      aktienSalePnlEur: 0,
      sonstigeSalePnlEur: 0,
      dividendsEur: 0,
    };
    for (const event of events) applyDeEvent(agg, event);
    const outcome = deYearOutcome(agg);
    aktienEur = outcome.aktienPotOutEur;
    sonstigeEur = outcome.sonstigePotOutEur;
  }
  return { aktienEur, sonstigeEur };
}

/** Input of {@link settleDeYear} — one Vienna year of one portfolio under DE. */
export interface DeYearSettlementInput {
  /** Aktien loss pot carried in from prior years (≥ 0; {@link deCarryPots}). */
  aktienPotInEur: number;
  /** Sonstige loss pot carried in from prior years (≥ 0). */
  sonstigePotInEur: number;
  /**
   * **Recomputed** events of the year's already-persisted DE-taxed rows —
   * sells with their FIFO gains re-derived from the *current* transaction log
   * (so a backdated buy that re-shaped lot consumption is reflected and the
   * settlement self-corrects), plus gross dividends. Order is irrelevant: the
   * year target is a function of the aggregates.
   */
  existingEvents: readonly DeTaxableEvent[];
  /**
   * Tax currently held for this year's **DE component**, EUR (cent-exact):
   * what the year's movements hold minus the AT rows' own target when both
   * countries coexist in the year (§16 cutover — the caller separates the
   * components; each engine only ever steers its own).
   */
  heldEur: number;
  /** New DE events being recorded now, in recording order (possibly empty). */
  newEvents: readonly DeTaxableEvent[];
}

/** Output of {@link settleDeYear} — same movement semantics as the AT engine. */
export interface DeYearSettlementResult {
  /**
   * Delta (EUR, signed: positive = withhold, negative = refund) that brings
   * the already-persisted events' target in line with `heldEur` *before* any
   * new event applies — non-zero only when history was re-shaped.
   */
  correctionDeltaEur: number;
  /** Marginal delta per new event, in input order (same sign convention). */
  newEventDeltasEur: number[];
  /** Held after all deltas — always exactly the year's final DE target. */
  heldAfterEur: number;
  /** The year-end state after every event (existing + new) — feeds the report. */
  yearEnd: DeYearOutcome;
}

/**
 * Settle one Vienna year of one portfolio under DE mode: compute the
 * cent-exact withholding/refund deltas that keep the year's held tax equal to
 * {@link deYearOutcome}'s target after every event — the same delta-steering
 * as {@link settleAtYear} (§43a Abs. 3 Satz 2 EStG obliges exactly this: the
 * paying agent nets later negative income against the year's already-taxed
 * income and refunds the excess), with the pots and the Sparer-Pauschbetrag
 * folded into the target function. Losses park in their pot (held never goes
 * negative); a later same-year loss refunds tax already withheld down to the
 * year's net target; pots carry OUT of a net-loss year instead of resetting
 * (the DE difference to AT's hard Jan-1 reset).
 */
export function settleDeYear(input: DeYearSettlementInput): DeYearSettlementResult {
  assertFiniteAmount(input.heldEur, 'heldEur');
  const agg: DeYearAggregates = {
    aktienPotInEur: input.aktienPotInEur,
    sonstigePotInEur: input.sonstigePotInEur,
    aktienSalePnlEur: 0,
    sonstigeSalePnlEur: 0,
    dividendsEur: 0,
  };
  for (const event of input.existingEvents) applyDeEvent(agg, event);

  const correctionDeltaEur = floorCents(deYearOutcome(agg).totalTaxEur - input.heldEur);
  let heldEur = floorCents(input.heldEur + correctionDeltaEur);

  const newEventDeltasEur: number[] = [];
  for (const event of input.newEvents) {
    applyDeEvent(agg, event);
    const deltaEur = floorCents(deYearOutcome(agg).totalTaxEur - heldEur);
    newEventDeltasEur.push(deltaEur);
    heldEur = floorCents(heldEur + deltaEur);
  }

  return {
    correctionDeltaEur,
    newEventDeltasEur,
    heldAfterEur: heldEur,
    yearEnd: deYearOutcome(agg),
  };
}

// ---------------------------------------------------------------------------
// Custom rule-built engine (V5-P4c, #584): the parameterized generalization
// of the AT settlement — "if we don't support your tax system, you can enter
// how it works".
// ---------------------------------------------------------------------------

/**
 * The custom engine's parameter set (V5-P4c): exactly the spec's list. Two
 * regimes fall out of `yearReset`:
 *
 *  - **reset on** (the AT shape): each Vienna year has its own pool;
 *    `carryForward` decides whether a year-end net LOSS survives Jan 1 as a
 *    pot that offsets later years (DE-pot-style) or is forfeited (AT).
 *  - **reset off**: ONE cumulative pool spans all years — the year boundary
 *    never clears it, so a loss inherently crosses Jan 1; `carryForward` off
 *    additionally forfeits a *negative* cumulative balance at each year end
 *    (gains always carry — they are already-taxed income the target function
 *    must keep seeing).
 *
 * `lossOffset` off drops losses from the pool entirely (they neither refund
 * nor accrue carry); `refund` off turns the held tax into a ratchet (a
 * shrinking pool never posts a refund — later gains only withhold past the
 * high-water mark). Mirrored (not imported) by `@bettertrack/contracts`.
 */
export interface CustomTaxParams {
  /** Flat rate on the positive taxable pool, percent (0–100). */
  ratePct: number;
  lossOffset: boolean;
  refund: boolean;
  yearReset: boolean;
  carryForward: boolean;
  costBasis: CostBasisStrategy;
}

/**
 * Austria expressed as a custom parameter set (§13.5 V5-P4c — the required
 * expressibility example): flat 27.5 % with same-year loss offset and refund,
 * a hard Jan-1 reset, no carry, moving-average basis. Pinned by test to
 * reproduce the AT fixtures exactly. (Germany is NOT fully expressible — the
 * dual loss pots and the Sparer-Pauschbetrag are outside the spec's parameter
 * list; its core rate approximates as 26.375 % = 25 % × 1.055. §16-logged.)
 */
export const AT_AS_CUSTOM_PARAMS: CustomTaxParams = {
  ratePct: 27.5,
  lossOffset: true,
  refund: true,
  yearReset: true,
  carryForward: false,
  costBasis: 'moving-average',
};

/** One taxable event of the custom engine — same shape as {@link NewAtEvent}. */
export interface CustomTaxableEvent {
  /**
   * `sell_gain` contributes a **signed** realized gain/loss (under the
   * parameter set's own {@link CustomTaxParams.costBasis}); `dividend` a
   * strictly positive gross amount. Both in EUR.
   */
  kind: 'sell_gain' | 'dividend';
  amountEur: number;
}

/**
 * The state one custom parameter set hands across a year boundary. Which
 * fields are live depends on the regime: `potEur` (≥ 0) is the reset-on
 * loss pot ({@link CustomTaxParams.carryForward}); the `cumulative*` pair is
 * the reset-off ledger — the signed all-years pool and the tax already
 * attributed to prior years (so a year's own component is the cumulative
 * target minus what earlier years hold). Unused fields stay 0.
 */
export interface CustomCarry {
  potEur: number;
  cumulativePoolEur: number;
  cumulativeHeldEur: number;
}

/** The empty carry — the state before a parameter set's first year. */
export function initialCustomCarry(): CustomCarry {
  return { potEur: 0, cumulativePoolEur: 0, cumulativeHeldEur: 0 };
}

function assertCustomParams(params: CustomTaxParams): void {
  if (!Number.isFinite(params.ratePct) || params.ratePct < 0 || params.ratePct > 100) {
    throw new TaxComputationError(
      `Custom tax rate must be between 0 and 100, got ${params.ratePct}.`,
    );
  }
  for (const flag of ['lossOffset', 'refund', 'yearReset', 'carryForward'] as const) {
    if (typeof params[flag] !== 'boolean') {
      throw new TaxComputationError(`Custom tax flag ${flag} must be a boolean.`);
    }
  }
  if (!COST_BASIS_STRATEGIES.includes(params.costBasis)) {
    throw new TaxComputationError(`Unknown cost-basis strategy ${String(params.costBasis)}.`);
  }
}

function assertCustomCarry(carry: CustomCarry): void {
  for (const [label, value] of [
    ['Carry pot', carry.potEur],
    ['Cumulative pool', carry.cumulativePoolEur],
    ['Cumulative held', carry.cumulativeHeldEur],
  ] as const) {
    assertFiniteAmount(value, label);
  }
  if (carry.potEur < 0) {
    throw new TaxComputationError(`Carry pot must be non-negative, got ${carry.potEur}.`);
  }
}

/**
 * The pool contribution of one event: a dividend's gross (validated strictly
 * positive), a sell's signed gain — or 0 for a loss when `lossOffset` is off
 * (the loss is ignored entirely: no refund, no pot accrual).
 */
function customEventAmount(params: CustomTaxParams, event: CustomTaxableEvent): number {
  assertFiniteAmount(event.amountEur, 'Custom event amount');
  if (event.kind === 'dividend') {
    if (event.amountEur <= 0) {
      throw new TaxComputationError(
        `Dividend gross amounts must be strictly positive, got ${event.amountEur}.`,
      );
    }
    return event.amountEur;
  }
  if (event.kind !== 'sell_gain') {
    throw new TaxComputationError(`Unknown custom event kind ${String(event.kind)}.`);
  }
  return params.lossOffset ? event.amountEur : Math.max(0, event.amountEur);
}

/**
 * One year of one parameter set as a sequential replay. Events fold in
 * CHRONOLOGICAL order because with `refund` off the year's held target is
 * path-dependent (a taxed gain followed by a loss ratchets; the aggregate
 * would not) — with refund on the fold lands on the aggregate target, so the
 * order is then irrelevant, matching {@link settleAtYear} exactly.
 */
interface CustomYearFold {
  /** The year's running pool (reset-on: this year only; reset-off: cumulative). */
  poolEur: number;
  /** What the year should hold after the folded events (its own component, signed). */
  heldTargetEur: number;
}

/** Fold `events` into the year, continuing from `fold` (mutates and returns it). */
function foldCustomEvents(
  params: CustomTaxParams,
  carry: CustomCarry,
  fold: CustomYearFold,
  events: readonly CustomTaxableEvent[],
): CustomYearFold {
  const rate = params.ratePct / 100;
  const potIn = params.yearReset && params.carryForward ? carry.potEur : 0;
  for (const event of events) {
    fold.poolEur += customEventAmount(params, event);
    // The target the year's held steers to after this event: reset-on years
    // tax their own pool net of the pot; reset-off years own the cumulative
    // target minus what prior years already hold (signed — a shrunk cumulative
    // pool can demand a refund of prior years' tax).
    const targetEur = params.yearReset
      ? floorCents(rate * Math.max(0, fold.poolEur - potIn))
      : floorCents(floorCents(rate * Math.max(0, fold.poolEur)) - carry.cumulativeHeldEur);
    let deltaEur = floorCents(targetEur - fold.heldTargetEur);
    // Refund off: held only ever ratchets up — a negative delta posts nothing.
    if (!params.refund && deltaEur < 0) deltaEur = 0;
    fold.heldTargetEur = floorCents(fold.heldTargetEur + deltaEur);
  }
  return fold;
}

/** The fold at a year's start: the carried-in pool, nothing held yet. */
function startCustomFold(params: CustomTaxParams, carry: CustomCarry): CustomYearFold {
  return { poolEur: params.yearReset ? 0 : carry.cumulativePoolEur, heldTargetEur: 0 };
}

/** The carry a finished year hands to the next (from its final fold state). */
function customCarryOut(
  params: CustomTaxParams,
  carry: CustomCarry,
  fold: CustomYearFold,
): CustomCarry {
  if (params.yearReset) {
    const potIn = params.carryForward ? carry.potEur : 0;
    // A net-negative remainder becomes (or passes through as) the pot.
    const potOut = params.carryForward ? Math.max(0, potIn - fold.poolEur) : 0;
    return { potEur: potOut, cumulativePoolEur: 0, cumulativeHeldEur: 0 };
  }
  return {
    potEur: 0,
    // Carry-forward off forfeits a NEGATIVE cumulative balance at the year
    // boundary; a positive pool always carries (it is already-taxed income).
    cumulativePoolEur: params.carryForward ? fold.poolEur : Math.max(0, fold.poolEur),
    cumulativeHeldEur: floorCents(carry.cumulativeHeldEur + fold.heldTargetEur),
  };
}

/** The outcome of one closed year of one parameter set. */
export interface CustomYearOutcome {
  /**
   * What the year should hold after all its events (signed: a reset-off year
   * whose loss shrank the cumulative pool holds a NET REFUND of prior years'
   * tax). This is the year's component of a portfolio-year's held target.
   */
  targetEur: number;
  /** The state handed to the next year. */
  carryOut: CustomCarry;
}

/**
 * Derive one year's outcome (held target + carry-out) from its chronological
 * events under one parameter set — the custom analog of {@link atYearTargetEur}
 * / {@link deYearOutcome}, path-dependent when `refund` is off.
 */
export function customYearOutcome(
  params: CustomTaxParams,
  carry: CustomCarry,
  events: readonly CustomTaxableEvent[],
): CustomYearOutcome {
  assertCustomParams(params);
  assertCustomCarry(carry);
  const fold = foldCustomEvents(params, carry, startCustomFold(params, carry), events);
  return { targetEur: fold.heldTargetEur, carryOut: customCarryOut(params, carry, fold) };
}

/**
 * Chain the carry state across consecutive prior years (ascending; gap years
 * may be omitted — an event-less year passes the pot/pool through unchanged).
 * The custom analog of {@link deCarryPots}.
 */
export function customCarryForYears(
  params: CustomTaxParams,
  priorYearEvents: ReadonlyArray<readonly CustomTaxableEvent[]>,
): CustomCarry {
  let carry = initialCustomCarry();
  for (const events of priorYearEvents) {
    carry = customYearOutcome(params, carry, events).carryOut;
  }
  return carry;
}

/** Input of {@link settleCustomYear} — one Vienna year of one parameter set. */
export interface CustomYearSettlementInput {
  params: CustomTaxParams;
  /** The state entering this year ({@link customCarryForYears} over prior years). */
  carry: CustomCarry;
  /**
   * The year's already-persisted events of THIS parameter set, chronological,
   * gains recomputed against the *current* transaction log under the set's own
   * cost basis (§16: append-only re-derivation).
   */
  existingEvents: readonly CustomTaxableEvent[];
  /**
   * Tax currently held for this year's component of THIS parameter set, EUR
   * (cent-exact): the caller separates coexisting regimes — the year's total
   * held minus every other regime's target (§16 cutover, as for AT/DE).
   */
  heldEur: number;
  /** New events being recorded now, in recording order (possibly empty). */
  newEvents: readonly CustomTaxableEvent[];
}

/** Output of {@link settleCustomYear} — same movement semantics as AT/DE. */
export interface CustomYearSettlementResult {
  /**
   * Delta (EUR, signed: positive = withhold, negative = refund) that brings
   * the already-persisted events' target in line with `heldEur` *before* any
   * new event applies. With `refund` off it never claws back (clamped ≥ 0).
   */
  correctionDeltaEur: number;
  /** Marginal delta per new event, in input order (same sign convention). */
  newEventDeltasEur: number[];
  /** Held after all deltas — the year's final component target. */
  heldAfterEur: number;
  /** The state handed to the next year after every event (existing + new). */
  carryOut: CustomCarry;
}

/**
 * Settle one Vienna year of one parameter set: the cent-exact deltas that
 * keep the year's held component equal to the parameter set's target after
 * every event — {@link settleAtYear}'s delta-steering generalized to the
 * custom rulebook. With {@link AT_AS_CUSTOM_PARAMS} this reproduces the AT
 * engine output for output (pinned by test — the issue's required
 * expressibility proof).
 */
export function settleCustomYear(input: CustomYearSettlementInput): CustomYearSettlementResult {
  assertCustomParams(input.params);
  assertCustomCarry(input.carry);
  assertFiniteAmount(input.heldEur, 'heldEur');

  // Replay the persisted events to the year's pre-batch target, then
  // reconcile drift (history reshaped by a backdated buy / a deletion)
  // against what is actually held — the ratchet also gates this correction.
  const fold = foldCustomEvents(
    input.params,
    input.carry,
    startCustomFold(input.params, input.carry),
    input.existingEvents,
  );
  let correctionDeltaEur = floorCents(fold.heldTargetEur - input.heldEur);
  if (!input.params.refund && correctionDeltaEur < 0) correctionDeltaEur = 0;
  let heldEur = floorCents(input.heldEur + correctionDeltaEur);

  // New events continue the same fold, but the deltas steer the ACTUAL held
  // (which after the clamp above may sit beyond the replay target).
  const rate = input.params.ratePct / 100;
  const potIn = input.params.yearReset && input.params.carryForward ? input.carry.potEur : 0;
  const newEventDeltasEur: number[] = [];
  for (const event of input.newEvents) {
    fold.poolEur += customEventAmount(input.params, event);
    const targetEur = input.params.yearReset
      ? floorCents(rate * Math.max(0, fold.poolEur - potIn))
      : floorCents(floorCents(rate * Math.max(0, fold.poolEur)) - input.carry.cumulativeHeldEur);
    let deltaEur = floorCents(targetEur - heldEur);
    if (!input.params.refund && deltaEur < 0) deltaEur = 0;
    newEventDeltasEur.push(deltaEur);
    heldEur = floorCents(heldEur + deltaEur);
  }

  // The carry-out derives from the full fold with the year's FINAL held as its
  // component (the ratchet-aware value, so a reset-off chain attributes what
  // this year actually holds).
  fold.heldTargetEur = heldEur;
  return {
    correctionDeltaEur,
    newEventDeltasEur,
    heldAfterEur: heldEur,
    carryOut: customCarryOut(input.params, input.carry, fold),
  };
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
