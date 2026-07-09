import { describe, expect, it } from 'vitest';

import { floorCents as ledgerFloorCents } from '../cashLedger';
import {
  AT_KEST_RATE,
  atYearTargetEur,
  manualTaxEur,
  realizedSellsEur,
  floorCents,
  settleAtYear,
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
      0, 0.005, -0.005, 1.005, -1.005, 2.675, 100.004999, 100.006, 8.61, 0.1 + 0.2, 123.456,
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
