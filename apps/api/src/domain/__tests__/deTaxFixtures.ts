/**
 * German (DE) tax fixture set — V5-P4 arc (a), issue #576 (§16 2026-07-17).
 *
 * This module is the mandated **fixtures-BEFORE-implementation** deliverable:
 * the researched German private-investor rules (Abgeltungsteuer regime),
 * encoded as executable scenario data with hand-computed expected outputs. The
 * DE engine does NOT exist yet — a follow-up issue implements it against these
 * fixtures. `domain/tax.ts` is untouched; only `deTaxFixtures.test.ts` (the
 * shape/consistency test) reads this file today. Like `domain/**` itself the
 * module imports nothing: pure data + types, every expected number a literal.
 *
 * ## Researched rules (statute references; full record in PROJECTPLAN §16 2026-07-17)
 *
 * - **Rate:** flat 25 % Abgeltungsteuer on capital income (§32d Abs. 1 EStG)
 *   plus Solidaritätszuschlag of 5.5 % **of the tax** (§3 Abs. 1 Nr. 5, §4
 *   SolzG 1995) — 26.375 % effective. No Soli-Freigrenze at withholding (that
 *   exists only in assessment). Kirchensteuer is explicitly NOT modeled.
 * - **Cost basis:** FIFO per lot for securities in collective custody
 *   (§20 Abs. 4 Satz 7 EStG) — vs AT's moving average; the engine's basis
 *   strategy becomes pluggable. Buy fees capitalize into the lot
 *   (Anschaffungsnebenkosten) and sell fees reduce proceeds
 *   (Veräußerungskosten) per §20 Abs. 4 Satz 1 EStG — the app's existing fee
 *   rule, which for DE is law-conform (for AT it was a documented
 *   simplification vs §27a öEStG).
 * - **Sparer-Pauschbetrag:** €1,000 per year (§20 Abs. 9 EStG, since VZ 2023),
 *   applied AFTER loss offset, floor at zero, unused remainder does NOT carry
 *   into the next year. Modeled per portfolio (= one depot; a
 *   Freistellungsauftrag for that depot, default the full amount).
 * - **Two loss pots** (§20 Abs. 6 EStG; bank mechanics §43a Abs. 3 EStG):
 *   the *Aktien* pot holds losses from selling shares and offsets ONLY gains
 *   from selling shares (§20 Abs. 6 Satz 4). The *Sonstige* (allgemeiner) pot
 *   holds every other loss and offsets ALL positive capital income — including
 *   share-sale gains and dividends. Dividends (§20 Abs. 1 Nr. 1) are always
 *   Sonstige-side income: they are not Veräußerungsgewinne, so the Aktien
 *   ring-fence never reaches them. Offset order per bank practice: same-
 *   category pot first, then the general pot, then the allowance.
 * - **Carry:** pots carry forward across year boundaries indefinitely
 *   (§20 Abs. 6 Sätze 2–3) — vs AT's hard Jan-1 reset. No Verlustbescheinigung
 *   (§43a Abs. 3 Satz 4 opt-out) is modeled.
 * - **Intra-year refund:** the paying agent nets later negative income against
 *   already-taxed income of the same year and refunds withheld tax
 *   (§43a Abs. 3 Satz 2 EStG) — exactly the AT settlement-delta mechanics of
 *   `settleAtYear` (§16 2026-07-08 point (3)), which DE inherits unchanged.
 *
 * ## The DE year-target function (the analog of `atYearTargetEur`)
 *
 * For one portfolio and one calendar year (bucketed like AT in Europe/Vienna —
 * wall-clock identical to Europe/Berlin; one bucketing zone app-wide):
 *
 *     aktienRemainder   = Σ Aktien-sale P/L − aktienPotIn
 *     sonstigeRemainder = Σ dividends + Σ other-sale P/L − sonstigePotIn
 *     // one-directional cross-offset: a NEGATIVE sonstige remainder also
 *     // offsets a positive Aktien remainder; never the other way round.
 *     taxableBeforeAllowance = remaining positives after that offset
 *     allowanceUsed = min(SPARER_PAUSCHBETRAG, taxableBeforeAllowance)
 *     base   = taxableBeforeAllowance − allowanceUsed
 *     KapESt = floorCents(0.25 · base)        // §32d Abs. 1 EStG
 *     Soli   = floorCents(0.055 · KapESt)     // §4 Satz 2 SolzG: "Bruchteile
 *                                             // eines Cents bleiben außer Ansatz"
 *     target = KapESt + Soli
 *     // negative remainders leave the year as potOut (carry-forward).
 *
 * KapESt cent-flooring is the app's #370 floor-toward-zero money policy (the
 * statute fixes no cent rule at withholding); the Soli floor is statutory.
 * KapESt + Soli post as ONE combined movement per settlement delta (the report
 * derives the split). Each {@link DeExpectedStep} is a settlement delta and
 * maps to a movement exactly per `taxMovementForDelta`: positive delta →
 * `tax_withholding` of −delta, negative delta → `tax_refund` of +|delta|.
 *
 * ## Pot classification
 *
 * App asset type `stock` → `aktien`; everything else (ETF/fund/custom/crypto)
 * → `sonstige`. The German §23 EStG crypto regime (tax-free after a 1-year
 * holding period) is NOT modeled — DE mode taxes exactly what the app taxes.
 * Also excluded (documented simplifications): Vorabpauschale (§18 InvStG),
 * Teilfreistellung (§20 InvStG), Günstigerprüfung / assessment options
 * (§32d Abs. 4/6 EStG), foreign-withholding credit (§32d Abs. 5 EStG),
 * pre-2009 Altbestand lots.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Second country of `country_specific` mode (V5-P4; AT shipped in V3-P4). */
export const TAX_COUNTRY_DE = 'DE';

/** German flat Abgeltungsteuer rate on capital income (§32d Abs. 1 EStG). */
export const DE_KAPEST_RATE = 0.25;

/** Solidaritätszuschlag, levied on the KapESt itself (§3 Abs. 1 Nr. 5, §4 SolzG). */
export const DE_SOLI_RATE = 0.055;

/**
 * Sparer-Pauschbetrag per calendar year (§20 Abs. 9 EStG; €1,000 since VZ
 * 2023 — all fixture years are ≥ 2024). Applied after loss offset; never
 * negative; unused remainder does not carry forward.
 */
export const DE_SPARER_PAUSCHBETRAG_EUR = 1000;

// ---------------------------------------------------------------------------
// Fixture input types
// ---------------------------------------------------------------------------

/**
 * Loss-pot category of an asset's sale P/L (§20 Abs. 6 EStG): `aktien` =
 * shares (app asset type `stock`), `sonstige` = everything else. Dividends
 * carry no category — they are always Sonstige-side income.
 */
export type DePotCategory = 'aktien' | 'sonstige';

/**
 * One fixture trade, pre-converted to EUR at its own trade-date FX rate —
 * the same shape as `tax.TaxableTransaction` plus the DE pot {@link category}
 * of the traded asset (the engine will derive it from the asset type).
 */
export interface DeFixtureTransaction {
  id: string;
  assetId: string;
  category: DePotCategory;
  side: 'buy' | 'sell';
  /** Units transacted; strictly positive. */
  quantity: number;
  /** Price per unit in EUR at the trade date; non-negative. */
  priceEur: number;
  /** Total fee in EUR at the trade date; non-negative. */
  feeEur: number;
  /** ISO-8601 timestamp; orders the replay and buckets the tax year. */
  executedAt: string;
}

/** One gross dividend (EUR; cash is EUR-only). Always Sonstige-side income. */
export interface DeFixtureDividend {
  id: string;
  assetId: string;
  /** Gross amount in EUR; strictly positive. */
  grossEur: number;
  executedAt: string;
}

// ---------------------------------------------------------------------------
// Expected-output types (all hand-computed literals)
// ---------------------------------------------------------------------------

/** The expected FIFO outcome of one SELL (full precision, no quantization). */
export interface DeExpectedSell {
  /** Id of the sell transaction this realization belongs to. */
  id: string;
  /** Pot category — must equal the transaction's. */
  category: DePotCategory;
  /** `quantity · priceEur − feeEur`: net proceeds, EUR. */
  proceedsEur: number;
  /**
   * FIFO cost basis, EUR: the consumed lots' per-unit basis (price plus
   * pro-rated buy fee) × consumed units, oldest lot first (§20 Abs. 4 Satz 7).
   */
  fifoCostBasisEur: number;
  /** `proceedsEur − fifoCostBasisEur` (signed) — the taxed DE gain. */
  realizedPnlEur: number;
  /**
   * The moving-average P/L the AT method would have produced, stated only
   * where a scenario proves FIFO ≠ moving average. The engine must NOT
   * produce this number under DE mode.
   */
  movingAveragePnlEur?: number;
}

/**
 * One chronological settlement step: the cent-quantized delta the event posts
 * (per `taxMovementForDelta`: positive = withholding, negative = refund) and
 * the year's held tax after it — always the year-to-date target of all events
 * up to and including this one. Buys settle nothing and never appear.
 */
export interface DeExpectedStep {
  /** Id of the sell / dividend being recorded. */
  eventId: string;
  /** Cent-quantized settlement delta, EUR (signed). */
  deltaEur: number;
  /** Tax held for the year after this event; never negative. */
  heldAfterEur: number;
}

/** The expected year-end settlement state of one calendar year. */
export interface DeExpectedYear {
  year: number;
  /** Aktien loss pot carried IN from the prior year (≥ 0, stored positive). */
  aktienPotInEur: number;
  /** Sonstige loss pot carried IN from the prior year (≥ 0). */
  sonstigePotInEur: number;
  /** Signed Σ of the year's Aktien-sale realized P/L. */
  aktienSalePnlEur: number;
  /** Signed Σ of the year's Sonstige-sale realized P/L. */
  sonstigeSalePnlEur: number;
  /** Σ of the year's gross dividends (Sonstige-side income). */
  dividendsEur: number;
  /** Positive income remaining after both pots + the cross-offset. */
  taxableBeforeAllowanceEur: number;
  /** Sparer-Pauschbetrag consumed (≤ {@link DE_SPARER_PAUSCHBETRAG_EUR}). */
  allowanceUsedEur: number;
  /** Allowance left unused at year end — lost, never carried (§20 Abs. 9). */
  allowanceRemainingEur: number;
  /** `taxableBeforeAllowanceEur − allowanceUsedEur`. */
  taxableBaseEur: number;
  /** `floorCents(DE_KAPEST_RATE · taxableBaseEur)`. */
  kapestEur: number;
  /** `floorCents(DE_SOLI_RATE · kapestEur)` (§4 Satz 2 SolzG). */
  soliEur: number;
  /** `kapestEur + soliEur` — the year-end held target. */
  totalTaxEur: number;
  /** Aktien pot carried OUT to the next year (≥ 0). */
  aktienPotOutEur: number;
  /** Sonstige pot carried OUT to the next year (≥ 0). */
  sonstigePotOutEur: number;
  /** Chronological settlement steps — one per taxable event of the year. */
  steps: DeExpectedStep[];
}

/** One self-contained DE scenario: inputs + hand-computed expected outputs. */
export interface DeTaxFixtureScenario {
  id: string;
  title: string;
  /** Statute references the scenario pins. */
  ruleRefs: string[];
  description: string;
  transactions: DeFixtureTransaction[];
  dividends: DeFixtureDividend[];
  /** One entry per SELL transaction, in chronological order. */
  expectedSells: DeExpectedSell[];
  /** One entry per calendar year touched, ascending. */
  expectedYears: DeExpectedYear[];
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/**
 * S1 — Simple gain: one lot bought and fully sold, fees on both legs.
 *
 * Trades (stock `de-stock-a`, year 2024):
 *   b1 2024-02-05  BUY  10 × €100.00, fee €5.00 → lot 10 @ €100.50 (basis €1,005.00;
 *                  buy fee capitalized, §20 Abs. 4 Satz 1 Anschaffungsnebenkosten)
 *   s1 2024-09-12  SELL 10 × €600.00, fee €5.00 → proceeds 6,000 − 5 = €5,995.00
 *                  (sell fee deducted, Veräußerungskosten)
 *
 * Hand computation, year 2024:
 *   FIFO basis      = 10 × 100.50 = €1,005.00 (single lot — FIFO ≡ average here)
 *   realized P/L    = 5,995.00 − 1,005.00 = **+€4,990.00** (Aktien)
 *   taxableBeforeAllowance = 4,990.00 (no losses, no pots)
 *   allowanceUsed   = 1,000.00 → remaining 0 → base = 3,990.00   (§20 Abs. 9)
 *   KapESt = floor(0.25 · 3,990.00) = €997.50                    (§32d Abs. 1)
 *   Soli   = floor(0.055 · 997.50)  = floor(54.8625) = €54.86    (§4 SolzG)
 *   total  = 997.50 + 54.86 = **€1,052.36**; both pots stay empty.
 * Steps: s1 → delta +1,052.36 (withholding), held 1,052.36.
 */
const simpleGain: DeTaxFixtureScenario = {
  id: 'de-simple-gain',
  title: 'Simple gain — one lot, fees on both legs, allowance then 25 % + Soli',
  ruleRefs: ['§32d Abs. 1 EStG', '§20 Abs. 4 Satz 1 EStG', '§20 Abs. 9 EStG', '§4 SolzG'],
  description:
    'Baseline: a single fully-sold lot; buy fee capitalized, sell fee deducted; ' +
    'the €1,000 allowance comes off first, then 25 % KapESt + 5.5 % Soli-on-tax.',
  transactions: [
    {
      id: 'b1',
      assetId: 'de-stock-a',
      category: 'aktien',
      side: 'buy',
      quantity: 10,
      priceEur: 100,
      feeEur: 5,
      executedAt: '2024-02-05T12:00:00.000Z',
    },
    {
      id: 's1',
      assetId: 'de-stock-a',
      category: 'aktien',
      side: 'sell',
      quantity: 10,
      priceEur: 600,
      feeEur: 5,
      executedAt: '2024-09-12T12:00:00.000Z',
    },
  ],
  dividends: [],
  expectedSells: [
    {
      id: 's1',
      category: 'aktien',
      proceedsEur: 5995,
      fifoCostBasisEur: 1005,
      realizedPnlEur: 4990,
    },
  ],
  expectedYears: [
    {
      year: 2024,
      aktienPotInEur: 0,
      sonstigePotInEur: 0,
      aktienSalePnlEur: 4990,
      sonstigeSalePnlEur: 0,
      dividendsEur: 0,
      taxableBeforeAllowanceEur: 4990,
      allowanceUsedEur: 1000,
      allowanceRemainingEur: 0,
      taxableBaseEur: 3990,
      kapestEur: 997.5,
      soliEur: 54.86,
      totalTaxEur: 1052.36,
      aktienPotOutEur: 0,
      sonstigePotOutEur: 0,
      steps: [{ eventId: 's1', deltaEur: 1052.36, heldAfterEur: 1052.36 }],
    },
  ],
};

/**
 * S2 — Multi-lot FIFO where FIFO and moving average provably differ.
 *
 * Trades (stock `de-stock-a`, year 2024, no fees so the lot math stays bare):
 *   b1 2024-01-10  BUY  100 × €100.00 → lot1 100 @ 100 (basis €10,000)
 *   b2 2024-03-15  BUY  100 × €200.00 → lot2 100 @ 200 (basis €20,000)
 *   s1 2024-06-20  SELL 100 × €180.00 → proceeds €18,000
 *     FIFO (§20 Abs. 4 Satz 7): consumes lot1 entirely → basis 10,000 → P/L **+8,000**
 *     Moving average (the AT method): avg = 30,000 / 200 = 150 → basis 15,000
 *     → P/L +3,000 — the engine must NOT produce this under DE mode.
 *   s2 2024-11-05  SELL 50 × €210.00 → proceeds €10,500
 *     FIFO: 50 units of lot2 → basis 50 × 200 = 10,000 → P/L **+500**
 *     Moving average: basis 50 × 150 = 7,500 → P/L +3,000
 *   FIFO year total +8,500 vs moving-average +6,000 — provably different.
 *
 * Hand computation, year 2024 (FIFO figures):
 *   taxableBeforeAllowance = 8,500.00
 *   allowanceUsed = 1,000.00 → base = 7,500.00
 *   KapESt = floor(0.25 · 7,500.00) = €1,875.00
 *   Soli   = floor(0.055 · 1,875.00) = floor(103.125) = €103.12
 *   total  = **€1,978.12**
 * Steps:
 *   s1 → ytd 8,000 → base 7,000 → KapESt 1,750.00 + Soli floor(96.25) = 96.25
 *        → target 1,846.25 → delta +1,846.25, held 1,846.25
 *   s2 → year target 1,978.12 → delta +131.87, held 1,978.12
 */
const fifoMultiLot: DeTaxFixtureScenario = {
  id: 'de-fifo-multi-lot',
  title: 'Multi-lot sell — FIFO consumption, provably ≠ moving average',
  ruleRefs: ['§20 Abs. 4 Satz 7 EStG', '§32d Abs. 1 EStG', '§4 SolzG'],
  description:
    'Two lots at different prices, partial sells across them: FIFO realizes +8,500 ' +
    'where the AT moving average would realize +6,000. The fixture states both; ' +
    'the DE engine must produce the FIFO numbers.',
  transactions: [
    {
      id: 'b1',
      assetId: 'de-stock-a',
      category: 'aktien',
      side: 'buy',
      quantity: 100,
      priceEur: 100,
      feeEur: 0,
      executedAt: '2024-01-10T12:00:00.000Z',
    },
    {
      id: 'b2',
      assetId: 'de-stock-a',
      category: 'aktien',
      side: 'buy',
      quantity: 100,
      priceEur: 200,
      feeEur: 0,
      executedAt: '2024-03-15T12:00:00.000Z',
    },
    {
      id: 's1',
      assetId: 'de-stock-a',
      category: 'aktien',
      side: 'sell',
      quantity: 100,
      priceEur: 180,
      feeEur: 0,
      executedAt: '2024-06-20T12:00:00.000Z',
    },
    {
      id: 's2',
      assetId: 'de-stock-a',
      category: 'aktien',
      side: 'sell',
      quantity: 50,
      priceEur: 210,
      feeEur: 0,
      executedAt: '2024-11-05T12:00:00.000Z',
    },
  ],
  dividends: [],
  expectedSells: [
    {
      id: 's1',
      category: 'aktien',
      proceedsEur: 18000,
      fifoCostBasisEur: 10000,
      realizedPnlEur: 8000,
      movingAveragePnlEur: 3000,
    },
    {
      id: 's2',
      category: 'aktien',
      proceedsEur: 10500,
      fifoCostBasisEur: 10000,
      realizedPnlEur: 500,
      movingAveragePnlEur: 3000,
    },
  ],
  expectedYears: [
    {
      year: 2024,
      aktienPotInEur: 0,
      sonstigePotInEur: 0,
      aktienSalePnlEur: 8500,
      sonstigeSalePnlEur: 0,
      dividendsEur: 0,
      taxableBeforeAllowanceEur: 8500,
      allowanceUsedEur: 1000,
      allowanceRemainingEur: 0,
      taxableBaseEur: 7500,
      kapestEur: 1875,
      soliEur: 103.12,
      totalTaxEur: 1978.12,
      aktienPotOutEur: 0,
      sonstigePotOutEur: 0,
      steps: [
        { eventId: 's1', deltaEur: 1846.25, heldAfterEur: 1846.25 },
        { eventId: 's2', deltaEur: 131.87, heldAfterEur: 1978.12 },
      ],
    },
  ],
};

/**
 * S3 — Sparer-Pauschbetrag exhausted mid-year by dividends.
 *
 * Dividends (asset `de-stock-b` held long, no trades; year 2025):
 *   d1 2025-03-14  gross €600.00
 *   d2 2025-06-16  gross €700.00
 *   d3 2025-09-15  gross €400.00
 *
 * Hand computation (chronological — the allowance depletes as income arrives):
 *   d1 → ytd 600 ≤ 1,000 → fully inside the allowance → target €0.00, delta 0
 *        (allowance left after d1: 400)
 *   d2 → ytd 1,300 → allowance 1,000 exhausted mid-event → base 300
 *        KapESt = floor(0.25 · 300) = 75.00; Soli = floor(0.055 · 75) =
 *        floor(4.125) = 4.12 → target 79.12 → delta +79.12
 *   d3 → ytd 1,700 → base 700 → KapESt 175.00; Soli = floor(9.625) = 9.62
 *        → target 184.62 → delta +105.50 (184.62 − 79.12)
 * Year end: taxableBeforeAllowance 1,700; allowanceUsed 1,000, remaining 0;
 *   base 700; KapESt €175.00; Soli €9.62; total **€184.62**; pots empty.
 */
const allowanceExhaustion: DeTaxFixtureScenario = {
  id: 'de-allowance-exhaustion',
  title: 'Dividends exhaust the Sparer-Pauschbetrag partially, then fully',
  ruleRefs: ['§20 Abs. 9 EStG', '§20 Abs. 1 Nr. 1 EStG', '§43a Abs. 3 EStG', '§4 SolzG'],
  description:
    'Three dividends walk the €1,000 allowance down: the first is tax-free inside ' +
    'it, the second straddles its exhaustion (only the excess is taxed), the third ' +
    'is taxed in full.',
  transactions: [],
  dividends: [
    {
      id: 'd1',
      assetId: 'de-stock-b',
      grossEur: 600,
      executedAt: '2025-03-14T12:00:00.000Z',
    },
    {
      id: 'd2',
      assetId: 'de-stock-b',
      grossEur: 700,
      executedAt: '2025-06-16T12:00:00.000Z',
    },
    {
      id: 'd3',
      assetId: 'de-stock-b',
      grossEur: 400,
      executedAt: '2025-09-15T12:00:00.000Z',
    },
  ],
  expectedSells: [],
  expectedYears: [
    {
      year: 2025,
      aktienPotInEur: 0,
      sonstigePotInEur: 0,
      aktienSalePnlEur: 0,
      sonstigeSalePnlEur: 0,
      dividendsEur: 1700,
      taxableBeforeAllowanceEur: 1700,
      allowanceUsedEur: 1000,
      allowanceRemainingEur: 0,
      taxableBaseEur: 700,
      kapestEur: 175,
      soliEur: 9.62,
      totalTaxEur: 184.62,
      aktienPotOutEur: 0,
      sonstigePotOutEur: 0,
      steps: [
        { eventId: 'd1', deltaEur: 0, heldAfterEur: 0 },
        { eventId: 'd2', deltaEur: 79.12, heldAfterEur: 79.12 },
        { eventId: 'd3', deltaEur: 105.5, heldAfterEur: 184.62 },
      ],
    },
  ],
};

/**
 * S4 — An Aktien loss must NOT offset a dividend (§20 Abs. 6 Satz 4 ring-fence).
 *
 * Events (year 2024):
 *   b1 2024-01-08  BUY  10 × €300.00 stock `de-stock-a` (lot basis €3,000)
 *   s1 2024-05-20  SELL 10 × €150.00 → proceeds 1,500 − basis 3,000 =
 *                  **−€1,500.00** — an Aktien loss
 *   d1 2024-07-01  DIVIDEND gross €2,000.00 (`de-stock-b`) — Sonstige-side income
 *
 * Hand computation, year 2024:
 *   aktienRemainder   = −1,500 → contributes €0; Aktien pot OUT €1,500
 *   sonstigeRemainder = +2,000 (the Aktien loss may NOT touch it — dividends
 *                       are not Veräußerungsgewinne aus Aktien)
 *   taxableBeforeAllowance = 2,000.00
 *   allowanceUsed = 1,000.00 → base = 1,000.00
 *   KapESt = floor(0.25 · 1,000.00) = €250.00
 *   Soli   = floor(0.055 · 250.00)  = €13.75 (exact)
 *   total  = **€263.75**; pots out: Aktien 1,500 / Sonstige 0.
 *   (If the ring-fence leaked, the base would be 0 and the tax €0.00 — an
 *    engine that lets the Aktien pot offset the dividend fails this fixture.)
 * Steps: s1 → loss parks in the pot, target 0, delta 0;
 *        d1 → target 263.75 → delta +263.75.
 */
const aktienLossRingfenced: DeTaxFixtureScenario = {
  id: 'de-aktien-loss-ringfenced',
  title: 'Aktien loss is ring-fenced — it never offsets a dividend',
  ruleRefs: ['§20 Abs. 6 Satz 4 EStG', '§20 Abs. 1 Nr. 1 EStG', '§20 Abs. 9 EStG'],
  description:
    'A −1,500 share-sale loss and a +2,000 dividend in one year: the dividend is ' +
    'taxed over the allowance while the loss carries out in the Aktien pot.',
  transactions: [
    {
      id: 'b1',
      assetId: 'de-stock-a',
      category: 'aktien',
      side: 'buy',
      quantity: 10,
      priceEur: 300,
      feeEur: 0,
      executedAt: '2024-01-08T12:00:00.000Z',
    },
    {
      id: 's1',
      assetId: 'de-stock-a',
      category: 'aktien',
      side: 'sell',
      quantity: 10,
      priceEur: 150,
      feeEur: 0,
      executedAt: '2024-05-20T12:00:00.000Z',
    },
  ],
  dividends: [
    {
      id: 'd1',
      assetId: 'de-stock-b',
      grossEur: 2000,
      executedAt: '2024-07-01T12:00:00.000Z',
    },
  ],
  expectedSells: [
    {
      id: 's1',
      category: 'aktien',
      proceedsEur: 1500,
      fifoCostBasisEur: 3000,
      realizedPnlEur: -1500,
    },
  ],
  expectedYears: [
    {
      year: 2024,
      aktienPotInEur: 0,
      sonstigePotInEur: 0,
      aktienSalePnlEur: -1500,
      sonstigeSalePnlEur: 0,
      dividendsEur: 2000,
      taxableBeforeAllowanceEur: 2000,
      allowanceUsedEur: 1000,
      allowanceRemainingEur: 0,
      taxableBaseEur: 1000,
      kapestEur: 250,
      soliEur: 13.75,
      totalTaxEur: 263.75,
      aktienPotOutEur: 1500,
      sonstigePotOutEur: 0,
      steps: [
        { eventId: 's1', deltaEur: 0, heldAfterEur: 0 },
        { eventId: 'd1', deltaEur: 263.75, heldAfterEur: 263.75 },
      ],
    },
  ],
};

/**
 * S5 — A Sonstige loss offsets dividends AND Aktien gains (one-directional
 * cross-offset: the general pot reaches everything).
 *
 * Events (year 2024):
 *   b1 2024-01-05  BUY  10 × €100.00 stock `de-stock-a` (basis 1,000)
 *   b2 2024-02-01  BUY  20 × €150.00 ETF `de-etf-a` (basis 3,000; Sonstige —
 *                  fund shares are not Aktien for §20 Abs. 6 Satz 4)
 *   s1 2024-04-10  SELL 10 × €400.00 stock → proceeds 4,000 − 1,000 = **+3,000** (Aktien)
 *   d1 2024-05-15  DIVIDEND gross €500.00 (`de-stock-b`)
 *   s2 2024-08-19  SELL 20 × €90.00 ETF → proceeds 1,800 − 3,000 = **−1,200** (Sonstige)
 *
 * Hand computation, year 2024:
 *   aktienRemainder   = +3,000
 *   sonstigeRemainder = 500 − 1,200 = −700 → offsets the Aktien positive
 *   taxableBeforeAllowance = 3,000 − 700 = 2,300.00
 *   allowanceUsed = 1,000.00 → base = 1,300.00
 *   KapESt = floor(0.25 · 1,300.00) = €325.00
 *   Soli   = floor(0.055 · 325.00)  = floor(17.875) = €17.87
 *   total  = **€342.87**; both pots end empty (the Sonstige loss was consumed).
 * Steps:
 *   s1 → ytd aktien 3,000 → base 2,000 → 500.00 + floor(27.50) = 527.50
 *        → delta +527.50, held 527.50
 *   d1 → ytd + dividend 500 → base 2,500 → 625.00 + floor(34.375) = 659.37
 *        → delta +131.87, held 659.37
 *   s2 → the −1,200 ETF loss lands → year target 342.87
 *        → delta **−316.50** (an intra-year REFUND, §43a Abs. 3 Satz 2), held 342.87
 */
const sonstigeLossCrossOffset: DeTaxFixtureScenario = {
  id: 'de-sonstige-loss-cross-offset',
  title: 'Sonstige loss offsets dividends and Aktien gains (cross-offset)',
  ruleRefs: ['§20 Abs. 6 EStG', '§20 Abs. 6 Satz 4 EStG', '§43a Abs. 3 Satz 2 EStG', '§4 SolzG'],
  description:
    'An ETF sale loss (general pot) offsets both a dividend and a share-sale gain ' +
    '— the direction §20 Abs. 6 Satz 4 permits — and, arriving after tax was ' +
    'already withheld, triggers an intra-year refund delta.',
  transactions: [
    {
      id: 'b1',
      assetId: 'de-stock-a',
      category: 'aktien',
      side: 'buy',
      quantity: 10,
      priceEur: 100,
      feeEur: 0,
      executedAt: '2024-01-05T12:00:00.000Z',
    },
    {
      id: 'b2',
      assetId: 'de-etf-a',
      category: 'sonstige',
      side: 'buy',
      quantity: 20,
      priceEur: 150,
      feeEur: 0,
      executedAt: '2024-02-01T12:00:00.000Z',
    },
    {
      id: 's1',
      assetId: 'de-stock-a',
      category: 'aktien',
      side: 'sell',
      quantity: 10,
      priceEur: 400,
      feeEur: 0,
      executedAt: '2024-04-10T12:00:00.000Z',
    },
    {
      id: 's2',
      assetId: 'de-etf-a',
      category: 'sonstige',
      side: 'sell',
      quantity: 20,
      priceEur: 90,
      feeEur: 0,
      executedAt: '2024-08-19T12:00:00.000Z',
    },
  ],
  dividends: [
    {
      id: 'd1',
      assetId: 'de-stock-b',
      grossEur: 500,
      executedAt: '2024-05-15T12:00:00.000Z',
    },
  ],
  expectedSells: [
    {
      id: 's1',
      category: 'aktien',
      proceedsEur: 4000,
      fifoCostBasisEur: 1000,
      realizedPnlEur: 3000,
    },
    {
      id: 's2',
      category: 'sonstige',
      proceedsEur: 1800,
      fifoCostBasisEur: 3000,
      realizedPnlEur: -1200,
    },
  ],
  expectedYears: [
    {
      year: 2024,
      aktienPotInEur: 0,
      sonstigePotInEur: 0,
      aktienSalePnlEur: 3000,
      sonstigeSalePnlEur: -1200,
      dividendsEur: 500,
      taxableBeforeAllowanceEur: 2300,
      allowanceUsedEur: 1000,
      allowanceRemainingEur: 0,
      taxableBaseEur: 1300,
      kapestEur: 325,
      soliEur: 17.87,
      totalTaxEur: 342.87,
      aktienPotOutEur: 0,
      sonstigePotOutEur: 0,
      steps: [
        { eventId: 's1', deltaEur: 527.5, heldAfterEur: 527.5 },
        { eventId: 'd1', deltaEur: 131.87, heldAfterEur: 659.37 },
        { eventId: 's2', deltaEur: -316.5, heldAfterEur: 342.87 },
      ],
    },
  ],
};

/**
 * S6 — Quantization: both KapESt and Soli land on fractional cents and floor.
 *
 * Trades (stock `de-stock-a`, year 2025):
 *   b1 2025-01-09  BUY  2 × €1,000.00 (basis 2,000)
 *   s1 2025-07-21  SELL 2 × €2,172.21 → proceeds €4,344.42 → P/L **+€2,344.42**
 *
 * Hand computation, year 2025:
 *   taxableBeforeAllowance = 2,344.42 → allowanceUsed 1,000 → base = 1,344.42
 *   KapESt = 0.25 · 1,344.42 = 336.1050 → floor → **€336.10**
 *     (kaufmännisch gerundet it would be 336.11 — the app's #370 floor-toward-
 *      zero policy pins the floor; the statute fixes no cent rule at withholding)
 *   Soli   = 0.055 · 336.10 = 18.4855 → floor → **€18.48**
 *     (statutory: §4 Satz 2 SolzG, "Bruchteile eines Cents bleiben außer
 *      Ansatz" — commercial rounding would say 18.49)
 *   total  = 336.10 + 18.48 = **€354.58**
 * Steps: s1 → delta +354.58, held 354.58.
 */
const roundingTruncation: DeTaxFixtureScenario = {
  id: 'de-rounding-truncation',
  title: 'KapESt and Soli cent-floor — fractional cents are dropped, never rounded up',
  ruleRefs: ['§32d Abs. 1 EStG', '§4 Satz 2 SolzG'],
  description:
    'A base of €1,344.42 makes 25 % land on 336.105 (→ 336.10) and the Soli on ' +
    '18.4855 (→ 18.48): both quantizations floor, per the statutory Soli rule and ' +
    'the app-wide #370 floor-toward-zero money policy.',
  transactions: [
    {
      id: 'b1',
      assetId: 'de-stock-a',
      category: 'aktien',
      side: 'buy',
      quantity: 2,
      priceEur: 1000,
      feeEur: 0,
      executedAt: '2025-01-09T12:00:00.000Z',
    },
    {
      id: 's1',
      assetId: 'de-stock-a',
      category: 'aktien',
      side: 'sell',
      quantity: 2,
      priceEur: 2172.21,
      feeEur: 0,
      executedAt: '2025-07-21T12:00:00.000Z',
    },
  ],
  dividends: [],
  expectedSells: [
    {
      id: 's1',
      category: 'aktien',
      proceedsEur: 4344.42,
      fifoCostBasisEur: 2000,
      realizedPnlEur: 2344.42,
    },
  ],
  expectedYears: [
    {
      year: 2025,
      aktienPotInEur: 0,
      sonstigePotInEur: 0,
      aktienSalePnlEur: 2344.42,
      sonstigeSalePnlEur: 0,
      dividendsEur: 0,
      taxableBeforeAllowanceEur: 2344.42,
      allowanceUsedEur: 1000,
      allowanceRemainingEur: 0,
      taxableBaseEur: 1344.42,
      kapestEur: 336.1,
      soliEur: 18.48,
      totalTaxEur: 354.58,
      aktienPotOutEur: 0,
      sonstigePotOutEur: 0,
      steps: [{ eventId: 's1', deltaEur: 354.58, heldAfterEur: 354.58 }],
    },
  ],
};

/**
 * S7 — Year boundary: loss pots carry forward, the allowance does not.
 *
 * Year 2024 — losses only:
 *   b1 2024-02-12  BUY  10 × €200.00 stock `de-stock-a` (basis 2,000)
 *   s1 2024-06-10  SELL 10 × €120.00 → 1,200 − 2,000 = **−€800.00** (Aktien)
 *   b2 2024-03-05  BUY  10 × €100.00 ETF `de-etf-a` (basis 1,000)
 *   s2 2024-10-14  SELL 10 × €70.00 → 700 − 1,000 = **−€300.00** (Sonstige)
 *   Year end: taxableBeforeAllowance 0; allowanceUsed 0 — the full €1,000
 *   stays unused and is LOST (§20 Abs. 9: no allowance carry); tax €0.00;
 *   pots OUT: Aktien 800 / Sonstige 300 (§20 Abs. 6 Sätze 2–3: pots carry).
 *   Steps: s1 delta 0, s2 delta 0 (losses only ever park).
 *
 * Year 2025 — gains against the carried pots + a FRESH allowance:
 *   b3 2025-01-20  BUY  5 × €100.00 stock `de-stock-a` (basis 500)
 *   s3 2025-05-11  SELL 5 × €500.00 → 2,500 − 500 = **+€2,000.00** (Aktien)
 *   d1 2025-06-15  DIVIDEND gross €400.00 (`de-stock-b`)
 *   aktienRemainder   = 2,000 − 800 (pot in) = +1,200
 *   sonstigeRemainder = 400 − 300 (pot in)   = +100
 *   taxableBeforeAllowance = 1,300.00
 *   allowanceUsed = 1,000 (the fresh 2025 allowance — NOT 2,000: 2024's unused
 *   allowance did not carry) → base = 300.00
 *   KapESt = €75.00; Soli = floor(4.125) = €4.12; total = **€79.12**
 *   Pots out: 0 / 0 (both consumed). Had 2024's allowance carried, the base
 *   would have been €0 — this fixture pins the asymmetry: pots carry,
 *   allowance resets.
 * Steps (chronological year-to-date targets):
 *   s3 → aktien 2,000 − pot 800 = 1,200; no Sonstige income yet, so the
 *        carried Sonstige pot (−300) cross-offsets → 900 → inside the fresh
 *        allowance → target 0 → delta 0, held 0. (A bank reaches the same
 *        state: pot, then general pot, then Freistellungsauftrag.)
 *   d1 → the dividend absorbs the Sonstige pot instead (400 − 300 = +100) →
 *        year target 79.12 → delta +79.12, held 79.12.
 */
const yearBoundaryCarry: DeTaxFixtureScenario = {
  id: 'de-year-boundary-carry',
  title: 'Year boundary — pots carry forward, the Sparer-Pauschbetrag resets',
  ruleRefs: ['§20 Abs. 6 Sätze 2–3 EStG', '§20 Abs. 9 EStG', '§4 SolzG'],
  description:
    'A pure-loss 2024 carries both pots into 2025 while its unused allowance is ' +
    'lost; 2025 nets gains against the carried pots and a fresh €1,000 allowance.',
  transactions: [
    {
      id: 'b1',
      assetId: 'de-stock-a',
      category: 'aktien',
      side: 'buy',
      quantity: 10,
      priceEur: 200,
      feeEur: 0,
      executedAt: '2024-02-12T12:00:00.000Z',
    },
    {
      id: 'b2',
      assetId: 'de-etf-a',
      category: 'sonstige',
      side: 'buy',
      quantity: 10,
      priceEur: 100,
      feeEur: 0,
      executedAt: '2024-03-05T12:00:00.000Z',
    },
    {
      id: 's1',
      assetId: 'de-stock-a',
      category: 'aktien',
      side: 'sell',
      quantity: 10,
      priceEur: 120,
      feeEur: 0,
      executedAt: '2024-06-10T12:00:00.000Z',
    },
    {
      id: 's2',
      assetId: 'de-etf-a',
      category: 'sonstige',
      side: 'sell',
      quantity: 10,
      priceEur: 70,
      feeEur: 0,
      executedAt: '2024-10-14T12:00:00.000Z',
    },
    {
      id: 'b3',
      assetId: 'de-stock-a',
      category: 'aktien',
      side: 'buy',
      quantity: 5,
      priceEur: 100,
      feeEur: 0,
      executedAt: '2025-01-20T12:00:00.000Z',
    },
    {
      id: 's3',
      assetId: 'de-stock-a',
      category: 'aktien',
      side: 'sell',
      quantity: 5,
      priceEur: 500,
      feeEur: 0,
      executedAt: '2025-05-11T12:00:00.000Z',
    },
  ],
  dividends: [
    {
      id: 'd1',
      assetId: 'de-stock-b',
      grossEur: 400,
      executedAt: '2025-06-15T12:00:00.000Z',
    },
  ],
  expectedSells: [
    {
      id: 's1',
      category: 'aktien',
      proceedsEur: 1200,
      fifoCostBasisEur: 2000,
      realizedPnlEur: -800,
    },
    {
      id: 's2',
      category: 'sonstige',
      proceedsEur: 700,
      fifoCostBasisEur: 1000,
      realizedPnlEur: -300,
    },
    {
      id: 's3',
      category: 'aktien',
      proceedsEur: 2500,
      fifoCostBasisEur: 500,
      realizedPnlEur: 2000,
    },
  ],
  expectedYears: [
    {
      year: 2024,
      aktienPotInEur: 0,
      sonstigePotInEur: 0,
      aktienSalePnlEur: -800,
      sonstigeSalePnlEur: -300,
      dividendsEur: 0,
      taxableBeforeAllowanceEur: 0,
      allowanceUsedEur: 0,
      allowanceRemainingEur: 1000,
      taxableBaseEur: 0,
      kapestEur: 0,
      soliEur: 0,
      totalTaxEur: 0,
      aktienPotOutEur: 800,
      sonstigePotOutEur: 300,
      steps: [
        { eventId: 's1', deltaEur: 0, heldAfterEur: 0 },
        { eventId: 's2', deltaEur: 0, heldAfterEur: 0 },
      ],
    },
    {
      year: 2025,
      aktienPotInEur: 800,
      sonstigePotInEur: 300,
      aktienSalePnlEur: 2000,
      sonstigeSalePnlEur: 0,
      dividendsEur: 400,
      taxableBeforeAllowanceEur: 1300,
      allowanceUsedEur: 1000,
      allowanceRemainingEur: 0,
      taxableBaseEur: 300,
      kapestEur: 75,
      soliEur: 4.12,
      totalTaxEur: 79.12,
      aktienPotOutEur: 0,
      sonstigePotOutEur: 0,
      steps: [
        { eventId: 's3', deltaEur: 0, heldAfterEur: 0 },
        { eventId: 'd1', deltaEur: 79.12, heldAfterEur: 79.12 },
      ],
    },
  ],
};

/**
 * S8 — Refund of already-withheld tax within one year.
 *
 * The researched rules SUPPORT this: §43a Abs. 3 Satz 2 EStG obliges the
 * paying agent to net later negative capital income against the year's
 * already-taxed income and refund the excess withholding — the same
 * delta-steering the AT engine performs (§16 2026-07-08 point (3)).
 *
 * Trades (stock `de-stock-a`, year 2025):
 *   b1 2025-01-15  BUY  20 × €100.00 (lot 20 @ 100, basis 2,000)
 *   s1 2025-03-10  SELL 10 × €300.00 → proceeds 3,000 − basis 1,000 = **+2,000**
 *   s2 2025-09-22  SELL 10 × €25.00  → proceeds 250 − basis 1,000 = **−750**
 *
 * Steps:
 *   s1 → ytd aktien 2,000 → allowance 1,000 → base 1,000
 *        → KapESt 250.00 + Soli 13.75 = target 263.75 → delta +263.75 (withheld)
 *   s2 → ytd aktien 1,250 → base 250 → KapESt = floor(62.50) = 62.50,
 *        Soli = floor(0.055 · 62.50) = floor(3.4375) = 3.43 → target 65.93
 *        → delta **−197.82** → a `tax_refund` movement of €197.82
 * Year end: taxableBeforeAllowance 1,250; allowanceUsed 1,000, remaining 0;
 *   base 250; KapESt €62.50; Soli €3.43; total **€65.93**; pots empty
 *   (the loss was fully absorbed by the year's own gain).
 */
const intraYearRefund: DeTaxFixtureScenario = {
  id: 'de-intra-year-refund',
  title: 'A later same-year loss refunds tax already withheld',
  ruleRefs: ['§43a Abs. 3 Satz 2 EStG', '§20 Abs. 6 EStG', '§4 SolzG'],
  description:
    'A March gain withholds €263.75; a September loss on the same stock nets the ' +
    'year down and the settlement refunds €197.82 of it — the intra-year refund ' +
    'the German paying-agent rules mandate.',
  transactions: [
    {
      id: 'b1',
      assetId: 'de-stock-a',
      category: 'aktien',
      side: 'buy',
      quantity: 20,
      priceEur: 100,
      feeEur: 0,
      executedAt: '2025-01-15T12:00:00.000Z',
    },
    {
      id: 's1',
      assetId: 'de-stock-a',
      category: 'aktien',
      side: 'sell',
      quantity: 10,
      priceEur: 300,
      feeEur: 0,
      executedAt: '2025-03-10T12:00:00.000Z',
    },
    {
      id: 's2',
      assetId: 'de-stock-a',
      category: 'aktien',
      side: 'sell',
      quantity: 10,
      priceEur: 25,
      feeEur: 0,
      executedAt: '2025-09-22T12:00:00.000Z',
    },
  ],
  dividends: [],
  expectedSells: [
    {
      id: 's1',
      category: 'aktien',
      proceedsEur: 3000,
      fifoCostBasisEur: 1000,
      realizedPnlEur: 2000,
    },
    {
      id: 's2',
      category: 'aktien',
      proceedsEur: 250,
      fifoCostBasisEur: 1000,
      realizedPnlEur: -750,
    },
  ],
  expectedYears: [
    {
      year: 2025,
      aktienPotInEur: 0,
      sonstigePotInEur: 0,
      aktienSalePnlEur: 1250,
      sonstigeSalePnlEur: 0,
      dividendsEur: 0,
      taxableBeforeAllowanceEur: 1250,
      allowanceUsedEur: 1000,
      allowanceRemainingEur: 0,
      taxableBaseEur: 250,
      kapestEur: 62.5,
      soliEur: 3.43,
      totalTaxEur: 65.93,
      aktienPotOutEur: 0,
      sonstigePotOutEur: 0,
      steps: [
        { eventId: 's1', deltaEur: 263.75, heldAfterEur: 263.75 },
        { eventId: 's2', deltaEur: -197.82, heldAfterEur: 65.93 },
      ],
    },
  ],
};

/** The complete DE fixture set the engine follow-up must satisfy. */
export const DE_TAX_FIXTURES: readonly DeTaxFixtureScenario[] = [
  simpleGain,
  fifoMultiLot,
  allowanceExhaustion,
  aktienLossRingfenced,
  sonstigeLossCrossOffset,
  roundingTruncation,
  yearBoundaryCarry,
  intraYearRefund,
];
