import { describe, expect, it } from 'vitest';

import { floorCents as ledgerFloorCents } from '../cashLedger';
import {
  AT_KEST_RATE,
  atYearTargetEur,
  costBasisStrategyForCountry,
  FI_CAPITAL_INCOME_HIGH_RATE,
  FI_CAPITAL_INCOME_RATE,
  FI_HIGH_RATE_THRESHOLD_EUR,
  fiYearTargetEur,
  manualTaxEur,
  realizedSellsEur,
  floorCents,
  settleAtYear,
  settleFiYear,
  TaxComputationError,
  taxMovementForDelta,
  viennaYearOf,
  type TaxableTransaction,
} from '../tax';

/**
 * V3-P4 domain core (issue #331): EUR moving-average cost basis, per-sell
 * realizations, Vienna-year bucketing, AT flat-KESt settlement with same-year
 * offset, manual per-trade tax. Exact-decimal assertions throughout — a cent
 * of float residue here is a real-money bug (#322).
 */

const T = (
  id: string,
  side: 'buy' | 'sell',
  quantity: number,
  priceEur: number,
  executedAt: string,
  feeEur = 0,
  assetId = 'asset-1',
): TaxableTransaction => ({ id, assetId, side, quantity, priceEur, feeEur, executedAt });

describe('floorCents (local mirror)', () => {
  it('matches cashLedger.floorCents on the boundary cases exactly', () => {
    const cases = [
      0,
      0.005,
      -0.005,
      1.005,
      -1.005,
      2.675,
      100.004999,
      100.006,
      8.61,
      0.1 + 0.2,
      123.456,
      -76.545,
    ];
    for (const value of cases) {
      expect(floorCents(value)).toBe(ledgerFloorCents(value));
    }
  });

  it('floors down (never rounds up) despite float representation', () => {
    expect(floorCents(1.005)).toBe(1.0);
    expect(floorCents(-1.005)).toBe(-1.0);
    expect(floorCents(100.006)).toBe(100.0);
    expect(floorCents(0.1 + 0.2)).toBe(0.3);
  });

  it('rejects non-finite amounts', () => {
    expect(() => floorCents(Number.NaN)).toThrow(TaxComputationError);
    expect(() => floorCents(Infinity)).toThrow(TaxComputationError);
  });
});

describe('viennaYearOf', () => {
  it('buckets by the Europe/Vienna calendar, not UTC', () => {
    // 23:30 UTC on Dec 31 is 00:30 Jan 1 in Vienna (CET, UTC+1).
    expect(viennaYearOf('2025-12-31T23:30:00.000Z')).toBe(2026);
    expect(viennaYearOf('2025-12-31T22:59:59.000Z')).toBe(2025);
    expect(viennaYearOf('2026-07-15T12:00:00.000Z')).toBe(2026);
  });

  it('fails loud on unparseable timestamps', () => {
    expect(() => viennaYearOf('not-a-date')).toThrow(TaxComputationError);
  });
});

describe('realizedSellsEur', () => {
  it('realizes a simple round trip against the average cost', () => {
    const [r] = realizedSellsEur([
      T('b1', 'buy', 10, 100, '2026-01-01T10:00:00Z'),
      T('s1', 'sell', 10, 110, '2026-02-01T10:00:00Z'),
    ]);
    expect(r).toMatchObject({
      id: 's1',
      quantity: 10,
      proceedsEur: 1100,
      costBasisEur: 1000,
      realizedPnlEur: 100,
    });
  });

  it('capitalises buy fees into the basis and deducts sell fees from the gain', () => {
    // avg = (10·100 + 10) / 10 = 101; pnl = 5·(110 − 101) − 5 = 40.
    const [r] = realizedSellsEur([
      T('b1', 'buy', 10, 100, '2026-01-01T10:00:00Z', 10),
      T('s1', 'sell', 5, 110, '2026-02-01T10:00:00Z', 5),
    ]);
    expect(r!.proceedsEur).toBe(545);
    expect(r!.costBasisEur).toBe(505);
    expect(r!.realizedPnlEur).toBe(40);
  });

  it('re-averages on buys and leaves the average unchanged across sells', () => {
    const sells = realizedSellsEur([
      T('b1', 'buy', 1, 100, '2026-01-01T10:00:00Z'),
      T('b2', 'buy', 1, 200, '2026-01-02T10:00:00Z'),
      T('s1', 'sell', 1, 180, '2026-01-03T10:00:00Z'),
      T('s2', 'sell', 1, 120, '2026-01-04T10:00:00Z'),
    ]);
    // avg 150 for both sells: +30 then −30.
    expect(sells.map((s) => s.realizedPnlEur)).toEqual([30, -30]);
  });

  it('replays chronologically regardless of input order, ties by input order', () => {
    const shuffled = realizedSellsEur([
      T('s1', 'sell', 1, 180, '2026-01-03T10:00:00Z'),
      T('b2', 'buy', 1, 200, '2026-01-02T10:00:00Z'),
      T('b1', 'buy', 1, 100, '2026-01-01T10:00:00Z'),
    ]);
    expect(shuffled.map((s) => s.realizedPnlEur)).toEqual([30]);
    // Mixed sub-second precision must sort as time, not as strings ('.' < 'Z').
    const subSecond = realizedSellsEur([
      T('b1', 'buy', 1, 100, '2026-01-01T10:00:00Z'),
      T('s1', 'sell', 1, 150, '2026-01-01T10:00:00.500Z'),
    ]);
    expect(subSecond).toHaveLength(1);
  });

  it('handles fractional quantities and closes positions to exactly zero', () => {
    // 0.1 + 0.2 hold 0.30000000000000004; selling 0.3 must clear it (ε-clamp),
    // so a follow-up buy starts from a clean average.
    const sells = realizedSellsEur([
      T('b1', 'buy', 0.1, 10, '2026-01-01T10:00:00Z'),
      T('b2', 'buy', 0.2, 10, '2026-01-02T10:00:00Z'),
      T('s1', 'sell', 0.3, 20, '2026-01-03T10:00:00Z'),
      T('b3', 'buy', 1, 50, '2026-02-01T10:00:00Z'),
      T('s2', 'sell', 1, 60, '2026-03-01T10:00:00Z'),
    ]);
    expect(sells[0]!.realizedPnlEur).toBeCloseTo(3, 12);
    // The second round trip sees avg 50, untouched by the closed position.
    expect(sells[1]!.realizedPnlEur).toBe(10);
  });

  it('tracks assets independently', () => {
    const sells = realizedSellsEur([
      T('b1', 'buy', 1, 100, '2026-01-01T10:00:00Z', 0, 'A'),
      T('b2', 'buy', 1, 500, '2026-01-01T11:00:00Z', 0, 'B'),
      T('s1', 'sell', 1, 110, '2026-01-02T10:00:00Z', 0, 'A'),
      T('s2', 'sell', 1, 400, '2026-01-02T11:00:00Z', 0, 'B'),
    ]);
    expect(sells.map((s) => [s.assetId, s.realizedPnlEur])).toEqual([
      ['A', 10],
      ['B', -100],
    ]);
  });

  it('rejects an oversell — an inconsistent log must never price a basis', () => {
    expect(() =>
      realizedSellsEur([
        T('b1', 'buy', 1, 100, '2026-01-01T10:00:00Z'),
        T('s1', 'sell', 2, 100, '2026-01-02T10:00:00Z'),
      ]),
    ).toThrow(TaxComputationError);
  });

  it('rejects malformed input loudly', () => {
    expect(() => realizedSellsEur([T('b1', 'buy', 0, 100, '2026-01-01T10:00:00Z')])).toThrow(
      TaxComputationError,
    );
    expect(() => realizedSellsEur([T('b1', 'buy', 1, -1, '2026-01-01T10:00:00Z')])).toThrow(
      TaxComputationError,
    );
    expect(() => realizedSellsEur([T('b1', 'buy', 1, 100, 'garbage')])).toThrow(
      TaxComputationError,
    );
  });

  describe('uncovered sell — allowUncovered (issue #369)', () => {
    it('basises the uncovered shares at the sale price → 0 gain, no phantom tax', () => {
      // Sell 10 with nothing held: basis = proceeds, so realized is exactly 0 —
      // the AT ledger must never see a fabricated gain here.
      const [r] = realizedSellsEur([
        { ...T('s1', 'sell', 10, 100, '2026-02-01T10:00:00Z'), allowUncovered: true },
      ]);
      expect(r!.proceedsEur).toBe(1000);
      expect(r!.costBasisEur).toBe(1000);
      expect(r!.realizedPnlEur).toBe(0);
      expect(r!.uncoveredQuantity).toBe(10);
    });

    it('splits a partial-cover sell: covered at avg, uncovered at the sale price', () => {
      // Hold 2 @ 40; sell 10 @ 100 uncovered. covered 2·(100−40)=120, uncovered 0.
      const [r] = realizedSellsEur([
        T('b1', 'buy', 2, 40, '2026-01-01T10:00:00Z'),
        { ...T('s1', 'sell', 10, 100, '2026-02-01T10:00:00Z'), allowUncovered: true },
      ]);
      expect(r!.costBasisEur).toBe(2 * 40 + 8 * 100); // 880
      expect(r!.realizedPnlEur).toBe(120);
      expect(r!.uncoveredQuantity).toBe(8);
    });

    it('uses a supplied EUR entry price for the uncovered portion (option B)', () => {
      const [r] = realizedSellsEur([
        T('b1', 'buy', 2, 40, '2026-01-01T10:00:00Z'),
        {
          ...T('s1', 'sell', 10, 100, '2026-02-01T10:00:00Z'),
          allowUncovered: true,
          uncoveredEntryPriceEur: 60,
        },
      ]);
      // covered 2·(100−40)=120; uncovered 8·(100−60)=320.
      expect(r!.costBasisEur).toBe(2 * 40 + 8 * 60); // 560
      expect(r!.realizedPnlEur).toBe(440);
      expect(r!.uncoveredQuantity).toBe(8);
    });

    it('marks a covered sell with uncoveredQuantity 0', () => {
      const [r] = realizedSellsEur([
        T('b1', 'buy', 10, 100, '2026-01-01T10:00:00Z'),
        T('s1', 'sell', 4, 110, '2026-02-01T10:00:00Z'),
      ]);
      expect(r!.uncoveredQuantity).toBe(0);
    });

    it('closes at 0 and lets a later buy rebuild a clean average (no shorts)', () => {
      const sells = realizedSellsEur([
        { ...T('s1', 'sell', 5, 100, '2026-01-01T10:00:00Z'), allowUncovered: true },
        T('b1', 'buy', 2, 50, '2026-02-01T10:00:00Z'),
        T('s2', 'sell', 2, 70, '2026-03-01T10:00:00Z'),
      ]);
      // Second round trip sees avg 50 (rebuilt from 0), not a −3 debt: 2·(70−50)=40.
      expect(sells[1]!.realizedPnlEur).toBe(40);
    });

    it('still rejects an oversell when the flag is absent', () => {
      expect(() =>
        realizedSellsEur([
          T('b1', 'buy', 1, 100, '2026-01-01T10:00:00Z'),
          T('s1', 'sell', 2, 100, '2026-01-02T10:00:00Z'),
        ]),
      ).toThrow(TaxComputationError);
    });
  });
});

describe('atYearTargetEur', () => {
  it('is the flat rate on the pool, cent-quantized', () => {
    expect(AT_KEST_RATE).toBe(0.275);
    expect(atYearTargetEur(450)).toBe(123.75);
    expect(atYearTargetEur(350)).toBe(96.25);
  });

  it('clamps a net-loss year to exactly zero (no negative tax, no carry)', () => {
    expect(atYearTargetEur(-100)).toBe(0);
    expect(atYearTargetEur(0)).toBe(0);
  });

  it('floors the tax due to whole cents (#370 — never rounds up)', () => {
    // 0.275 · 0.02 = 0.0055 → floors down to 0.00, not up to 0.01.
    expect(atYearTargetEur(0.02)).toBe(0);
    expect(atYearTargetEur(0.01)).toBe(0);
    // 0.275 · 0.5 = 0.1375 → floors to 0.13.
    expect(atYearTargetEur(0.5)).toBe(0.13);
  });
});

describe('settleAtYear', () => {
  it('owner example: +450 gain then −100 loss ⇒ held is exactly 27.5 % × 350', () => {
    const first = settleAtYear({
      existingGainsEur: [],
      existingDividendsEur: [],
      heldEur: 0,
      newEvents: [{ kind: 'sell_gain', amountEur: 450 }],
    });
    expect(first.correctionDeltaEur).toBe(0);
    expect(first.newEventDeltasEur).toEqual([123.75]);
    expect(first.heldAfterEur).toBe(123.75);

    const second = settleAtYear({
      existingGainsEur: [450],
      existingDividendsEur: [],
      heldEur: 123.75,
      newEvents: [{ kind: 'sell_gain', amountEur: -100 }],
    });
    expect(second.correctionDeltaEur).toBe(0);
    // The loss refunds tax down to the year's net position: 96.25 − 123.75.
    expect(second.newEventDeltasEur).toEqual([-27.5]);
    expect(second.heldAfterEur).toBe(96.25);
  });

  it('loss first: nothing to refund, later gains taxed on the net only', () => {
    const loss = settleAtYear({
      existingGainsEur: [],
      existingDividendsEur: [],
      heldEur: 0,
      newEvents: [{ kind: 'sell_gain', amountEur: -100 }],
    });
    expect(loss.newEventDeltasEur).toEqual([0]);
    expect(loss.heldAfterEur).toBe(0);

    const gain = settleAtYear({
      existingGainsEur: [-100],
      existingDividendsEur: [],
      heldEur: 0,
      newEvents: [{ kind: 'sell_gain', amountEur: 450 }],
    });
    expect(gain.newEventDeltasEur).toEqual([96.25]);
  });

  it('a refund never exceeds what the year holds', () => {
    const result = settleAtYear({
      existingGainsEur: [100],
      existingDividendsEur: [],
      heldEur: 27.5,
      newEvents: [{ kind: 'sell_gain', amountEur: -500 }],
    });
    expect(result.newEventDeltasEur).toEqual([-27.5]);
    expect(result.heldAfterEur).toBe(0);
  });

  it('taxes dividends at the flat rate inside the same pool', () => {
    const result = settleAtYear({
      existingGainsEur: [],
      existingDividendsEur: [],
      heldEur: 0,
      newEvents: [{ kind: 'dividend', amountEur: 100 }],
    });
    expect(result.newEventDeltasEur).toEqual([27.5]);

    // A prior same-year loss offsets dividend tax too (one pool).
    const offset = settleAtYear({
      existingGainsEur: [-100],
      existingDividendsEur: [],
      heldEur: 0,
      newEvents: [{ kind: 'dividend', amountEur: 60 }],
    });
    expect(offset.newEventDeltasEur).toEqual([0]);
  });

  it('attributes per-event marginal deltas within one batch', () => {
    const result = settleAtYear({
      existingGainsEur: [],
      existingDividendsEur: [],
      heldEur: 0,
      newEvents: [
        { kind: 'sell_gain', amountEur: 450 },
        { kind: 'sell_gain', amountEur: -100 },
      ],
    });
    expect(result.newEventDeltasEur).toEqual([123.75, -27.5]);
    expect(result.heldAfterEur).toBe(96.25);
  });

  it('posts a correction when re-shaped history no longer matches the held tax', () => {
    // A backdated buy lifted the average: the +450 gain is now only +300.
    const result = settleAtYear({
      existingGainsEur: [300],
      existingDividendsEur: [],
      heldEur: 123.75,
      newEvents: [],
    });
    expect(result.correctionDeltaEur).toBe(-41.25);
    expect(result.heldAfterEur).toBe(82.5);
  });

  it('lands on exact cents even for awkward pools', () => {
    // 0.275 · 33.33 = 9.16575 → floors down to 9.16 (never up to 9.17, #370).
    const result = settleAtYear({
      existingGainsEur: [],
      existingDividendsEur: [],
      heldEur: 0,
      newEvents: [{ kind: 'sell_gain', amountEur: 33.33 }],
    });
    expect(result.newEventDeltasEur).toEqual([9.16]);
    expect(result.heldAfterEur).toBe(9.16);
  });

  it('rejects malformed events', () => {
    const base = { existingGainsEur: [], existingDividendsEur: [], heldEur: 0 };
    expect(() =>
      settleAtYear({ ...base, newEvents: [{ kind: 'dividend', amountEur: 0 }] }),
    ).toThrow(TaxComputationError);
    expect(() =>
      settleAtYear({ ...base, newEvents: [{ kind: 'sell_gain', amountEur: Number.NaN }] }),
    ).toThrow(TaxComputationError);
    expect(() =>
      settleAtYear({
        ...base,
        newEvents: [{ kind: 'bogus' as 'dividend', amountEur: 1 }],
      }),
    ).toThrow(TaxComputationError);
    expect(() => settleAtYear({ ...base, heldEur: Infinity, newEvents: [] })).toThrow(
      TaxComputationError,
    );
  });
});

describe('taxMovementForDelta', () => {
  it('maps positive deltas to withholdings (negative amount)', () => {
    expect(taxMovementForDelta(123.75)).toEqual({ kind: 'tax_withholding', amountEur: -123.75 });
  });

  it('maps negative deltas to refunds (positive amount)', () => {
    expect(taxMovementForDelta(-27.5)).toEqual({ kind: 'tax_refund', amountEur: 27.5 });
  });

  it('posts nothing for a zero delta', () => {
    expect(taxMovementForDelta(0)).toBeNull();
  });
});

describe('manualTaxEur', () => {
  it('records the entered amount as-is, floored to whole cents (#370)', () => {
    expect(manualTaxEur({ taxAmountEur: 12.34, baseEur: 999 })).toBe(12.34);
    // 12.345 floors down to 12.34 (never up to 12.35).
    expect(manualTaxEur({ taxAmountEur: 12.345, baseEur: 999 })).toBe(12.34);
  });

  it('applies a rate to the positive base only — a loss records €0.00', () => {
    expect(manualTaxEur({ taxRatePct: 27.5, baseEur: 100 })).toBe(27.5);
    expect(manualTaxEur({ taxRatePct: 27.5, baseEur: -100 })).toBe(0);
  });

  it('returns null when nothing was entered (no tax recorded)', () => {
    expect(manualTaxEur({ baseEur: 100 })).toBeNull();
    expect(manualTaxEur({ taxAmountEur: null, taxRatePct: null, baseEur: 100 })).toBeNull();
  });

  it('rejects contradictory or out-of-range input', () => {
    expect(() => manualTaxEur({ taxAmountEur: 1, taxRatePct: 1, baseEur: 100 })).toThrow(
      TaxComputationError,
    );
    expect(() => manualTaxEur({ taxAmountEur: -1, baseEur: 100 })).toThrow(TaxComputationError);
    expect(() => manualTaxEur({ taxRatePct: 101, baseEur: 100 })).toThrow(TaxComputationError);
    expect(() => manualTaxEur({ taxRatePct: 10, baseEur: Number.NaN })).toThrow(
      TaxComputationError,
    );
  });
});

// ─── FI (#635): progressive pääomatulovero over the shared pool settlement ────

describe('fiYearTargetEur', () => {
  it('worked example: 30 % to €30,000, 34 % above (TVL 124 §)', () => {
    expect(FI_CAPITAL_INCOME_RATE).toBe(0.3);
    expect(FI_CAPITAL_INCOME_HIGH_RATE).toBe(0.34);
    expect(FI_HIGH_RATE_THRESHOLD_EUR).toBe(30_000);
    // 40,000 pool → 30 % × 30,000 + 34 % × 10,000 = 9,000 + 3,400 = 12,400.
    expect(fiYearTargetEur(40_000)).toBe(12_400);
    // Exactly at the threshold: base rate only.
    expect(fiYearTargetEur(30_000)).toBe(9_000);
    // Below: flat 30 %.
    expect(fiYearTargetEur(1_000)).toBe(300);
  });

  it('clamps a net-loss year to exactly zero (no negative tax, no carry v1)', () => {
    expect(fiYearTargetEur(-500)).toBe(0);
    expect(fiYearTargetEur(0)).toBe(0);
  });

  it('floors to whole cents (#370 — never rounds up)', () => {
    // 30 % × 0.03 = 0.009 → floors to 0.00.
    expect(fiYearTargetEur(0.03)).toBe(0);
    // 30 % × 0.5 = 0.15 exactly.
    expect(fiYearTargetEur(0.5)).toBe(0.15);
  });
});

describe('settleFiYear', () => {
  it('a marginal gain crossing the threshold is taxed at 34 % on the excess', () => {
    const settlement = settleFiYear({
      existingGainsEur: [25_000],
      existingDividendsEur: [],
      heldEur: 7_500,
      newEvents: [{ kind: 'sell_gain', amountEur: 10_000 }],
    });
    expect(settlement.correctionDeltaEur).toBe(0);
    // Pool 25,000 → 35,000: target 9,000 + 34 % × 5,000 = 10,700; held was
    // 7,500 → the event's marginal delta is 3,200 (1,500 at 30 % + 1,700 at 34 %).
    expect(settlement.newEventDeltasEur).toEqual([3_200]);
    expect(settlement.heldAfterEur).toBe(10_700);
  });

  it('a same-year loss refunds down to the shrunken progressive target', () => {
    const settlement = settleFiYear({
      existingGainsEur: [35_000],
      existingDividendsEur: [],
      heldEur: 10_700,
      newEvents: [{ kind: 'sell_gain', amountEur: -5_000 }],
    });
    // Pool 30,000 → target 9,000 → refund 1,700.
    expect(settlement.newEventDeltasEur).toEqual([-1_700]);
    expect(settlement.heldAfterEur).toBe(9_000);
  });

  it('a loss-first year parks at €0.00 and later gains tax only the net', () => {
    const settlement = settleFiYear({
      existingGainsEur: [],
      existingDividendsEur: [],
      heldEur: 0,
      newEvents: [
        { kind: 'sell_gain', amountEur: -1_000 },
        { kind: 'sell_gain', amountEur: 1_500 },
        { kind: 'dividend', amountEur: 500 },
      ],
    });
    // −1,000 → 0 held; +1,500 → pool 500 → 150; +500 dividend → pool 1,000 → 300.
    expect(settlement.newEventDeltasEur).toEqual([0, 150, 150]);
    expect(settlement.heldAfterEur).toBe(300);
  });

  it('reconciles reshaped history like the AT settlement (signed correction)', () => {
    const settlement = settleFiYear({
      existingGainsEur: [1_000],
      existingDividendsEur: [],
      heldEur: 500,
      newEvents: [],
    });
    // Recomputed target 300 vs held 500 → −200 correction.
    expect(settlement.correctionDeltaEur).toBe(-200);
    expect(settlement.heldAfterEur).toBe(300);
  });
});

describe('costBasisStrategyForCountry (#635)', () => {
  it('FI mandates FIFO like DE; AT keeps the moving average', () => {
    expect(costBasisStrategyForCountry('FI')).toBe('fifo');
    expect(costBasisStrategyForCountry('DE')).toBe('fifo');
    expect(costBasisStrategyForCountry('AT')).toBe('moving-average');
    expect(costBasisStrategyForCountry(null)).toBe('moving-average');
  });
});
