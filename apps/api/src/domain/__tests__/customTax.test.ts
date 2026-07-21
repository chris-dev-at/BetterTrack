import { describe, expect, it } from 'vitest';

import {
  AT_AS_CUSTOM_PARAMS,
  customCarryForYears,
  customYearOutcome,
  initialCustomCarry,
  realizedSellsEur,
  settleAtYear,
  settleCustomYear,
  TaxComputationError,
  type AtYearSettlementInput,
  type CustomTaxableEvent,
  type CustomTaxParams,
} from '../tax';

/**
 * The custom rule-built tax engine (V5-P4c, #584): the parameterized
 * generalization of the AT settlement. The load-bearing suite here is the
 * AT-parity block — a custom parameter set configured like Austria MUST
 * reproduce the AT fixtures exactly, fixture-for-fixture (the issue's required
 * test) — plus one dedicated block per parameter proving it changes
 * settlement: offset off (loss ignored), refund off (no refund movement),
 * reset off + carry (a loss crosses Jan 1), carry-forward pots, and the
 * FIFO / moving-average divergence through the cost-basis seam.
 */

const params = (overrides: Partial<CustomTaxParams> = {}): CustomTaxParams => ({
  ...AT_AS_CUSTOM_PARAMS,
  ...overrides,
});

/** Run one AT fixture through BOTH engines and assert identical outputs. */
function expectAtParity(input: AtYearSettlementInput): void {
  const at = settleAtYear(input);
  const custom = settleCustomYear({
    params: AT_AS_CUSTOM_PARAMS,
    carry: initialCustomCarry(),
    existingEvents: [
      ...input.existingGainsEur.map(
        (amountEur): CustomTaxableEvent => ({ kind: 'sell_gain', amountEur }),
      ),
      ...input.existingDividendsEur.map(
        (amountEur): CustomTaxableEvent => ({ kind: 'dividend', amountEur }),
      ),
    ],
    heldEur: input.heldEur,
    newEvents: input.newEvents,
  });
  expect(custom.correctionDeltaEur).toBe(at.correctionDeltaEur);
  expect(custom.newEventDeltasEur).toEqual(at.newEventDeltasEur);
  expect(custom.heldAfterEur).toBe(at.heldAfterEur);
}

describe('custom-as-AT parity (the required expressibility test)', () => {
  it('AT_AS_CUSTOM_PARAMS is exactly the documented AT parameter set', () => {
    expect(AT_AS_CUSTOM_PARAMS).toEqual({
      ratePct: 27.5,
      lossOffset: true,
      refund: true,
      yearReset: true,
      carryForward: false,
      costBasis: 'moving-average',
    });
  });

  it('owner example: +450 gain then −100 loss ⇒ held is exactly 27.5 % × 350', () => {
    expectAtParity({
      existingGainsEur: [],
      existingDividendsEur: [],
      heldEur: 0,
      newEvents: [{ kind: 'sell_gain', amountEur: 450 }],
    });
    expectAtParity({
      existingGainsEur: [450],
      existingDividendsEur: [],
      heldEur: 123.75,
      newEvents: [{ kind: 'sell_gain', amountEur: -100 }],
    });
  });

  it('loss first: nothing to refund, later gains taxed on the net only', () => {
    expectAtParity({
      existingGainsEur: [],
      existingDividendsEur: [],
      heldEur: 0,
      newEvents: [{ kind: 'sell_gain', amountEur: -100 }],
    });
    expectAtParity({
      existingGainsEur: [-100],
      existingDividendsEur: [],
      heldEur: 0,
      newEvents: [{ kind: 'sell_gain', amountEur: 450 }],
    });
  });

  it('a refund never exceeds what the year holds', () => {
    expectAtParity({
      existingGainsEur: [100],
      existingDividendsEur: [],
      heldEur: 27.5,
      newEvents: [{ kind: 'sell_gain', amountEur: -500 }],
    });
  });

  it('taxes dividends at the flat rate inside the same pool', () => {
    expectAtParity({
      existingGainsEur: [],
      existingDividendsEur: [],
      heldEur: 0,
      newEvents: [{ kind: 'dividend', amountEur: 100 }],
    });
    expectAtParity({
      existingGainsEur: [-100],
      existingDividendsEur: [],
      heldEur: 0,
      newEvents: [{ kind: 'dividend', amountEur: 60 }],
    });
  });

  it('attributes per-event marginal deltas within one batch', () => {
    expectAtParity({
      existingGainsEur: [],
      existingDividendsEur: [],
      heldEur: 0,
      newEvents: [
        { kind: 'sell_gain', amountEur: 450 },
        { kind: 'sell_gain', amountEur: -100 },
      ],
    });
  });

  it('posts a correction when re-shaped history no longer matches the held tax', () => {
    expectAtParity({
      existingGainsEur: [300],
      existingDividendsEur: [],
      heldEur: 123.75,
      newEvents: [],
    });
  });

  it('lands on exact cents even for awkward pools (floors, never rounds up)', () => {
    expectAtParity({
      existingGainsEur: [],
      existingDividendsEur: [],
      heldEur: 0,
      newEvents: [{ kind: 'sell_gain', amountEur: 33.33 }],
    });
  });

  it('hard Jan-1 reset with carry off: a fresh year starts from a clean carry', () => {
    // Year 1 nets a loss; with AT params nothing survives the boundary.
    const y1 = customYearOutcome(AT_AS_CUSTOM_PARAMS, initialCustomCarry(), [
      { kind: 'sell_gain', amountEur: -400 },
    ]);
    expect(y1.targetEur).toBe(0);
    expect(y1.carryOut).toEqual(initialCustomCarry());
    // Year 2's gain is taxed in full — no cross-year offset, exactly AT.
    const y2 = settleCustomYear({
      params: AT_AS_CUSTOM_PARAMS,
      carry: y1.carryOut,
      existingEvents: [],
      heldEur: 0,
      newEvents: [{ kind: 'sell_gain', amountEur: 200 }],
    });
    expect(y2.newEventDeltasEur).toEqual([55]);
  });
});

describe('lossOffset off: losses are ignored entirely', () => {
  it('a loss neither refunds nor shrinks the pool; gains tax in full', () => {
    const result = settleCustomYear({
      params: params({ ratePct: 10, lossOffset: false }),
      carry: initialCustomCarry(),
      existingEvents: [],
      heldEur: 0,
      newEvents: [
        { kind: 'sell_gain', amountEur: 100 },
        { kind: 'sell_gain', amountEur: -80 },
        { kind: 'sell_gain', amountEur: 50 },
      ],
    });
    // 10 % of 100, nothing for the loss, then 10 % of the further 50.
    expect(result.newEventDeltasEur).toEqual([10, 0, 5]);
    expect(result.heldAfterEur).toBe(15);
    // With offset ON the same events land on 10 % × (100 − 80 + 50) = 7.
    const withOffset = settleCustomYear({
      params: params({ ratePct: 10 }),
      carry: initialCustomCarry(),
      existingEvents: [],
      heldEur: 0,
      newEvents: [
        { kind: 'sell_gain', amountEur: 100 },
        { kind: 'sell_gain', amountEur: -80 },
        { kind: 'sell_gain', amountEur: 50 },
      ],
    });
    expect(withOffset.heldAfterEur).toBe(7);
  });

  it('a loss-only year accrues no carry even with carryForward on', () => {
    const outcome = customYearOutcome(
      params({ lossOffset: false, carryForward: true }),
      initialCustomCarry(),
      [{ kind: 'sell_gain', amountEur: -500 }],
    );
    expect(outcome.targetEur).toBe(0);
    expect(outcome.carryOut.potEur).toBe(0);
  });
});

describe('refund off: tax held only ever ratchets up', () => {
  it('a loss after a taxed gain posts no refund movement', () => {
    const result = settleCustomYear({
      params: params({ refund: false }),
      carry: initialCustomCarry(),
      existingEvents: [],
      heldEur: 0,
      newEvents: [
        { kind: 'sell_gain', amountEur: 450 },
        { kind: 'sell_gain', amountEur: -100 },
      ],
    });
    // The AT engine would refund 27.50 here; the ratchet posts 0 instead.
    expect(result.newEventDeltasEur).toEqual([123.75, 0]);
    expect(result.heldAfterEur).toBe(123.75);
  });

  it('later gains withhold again only past the ratchet', () => {
    // Pool 450 → −100 → +200: target 96.25 then 151.25; held sits at 123.75
    // after the ignored refund, so the next delta is 151.25 − 123.75.
    const result = settleCustomYear({
      params: params({ refund: false }),
      carry: initialCustomCarry(),
      existingEvents: [],
      heldEur: 0,
      newEvents: [
        { kind: 'sell_gain', amountEur: 450 },
        { kind: 'sell_gain', amountEur: -100 },
        { kind: 'sell_gain', amountEur: 200 },
      ],
    });
    expect(result.newEventDeltasEur).toEqual([123.75, 0, 27.5]);
    expect(result.heldAfterEur).toBe(151.25);
  });

  it('a history-reshape correction never claws tax back', () => {
    // Recomputed history demands less than is held — with refund off the
    // correction clamps to zero instead of refunding (append-only ratchet).
    const result = settleCustomYear({
      params: params({ refund: false }),
      carry: initialCustomCarry(),
      existingEvents: [{ kind: 'sell_gain', amountEur: 300 }],
      heldEur: 123.75,
      newEvents: [],
    });
    expect(result.correctionDeltaEur).toBe(0);
    expect(result.heldAfterEur).toBe(123.75);
  });
});

describe('yearReset off: one cumulative pool across years (loss crosses Jan 1)', () => {
  it('a year-1 loss offsets a year-2 gain through the carry state', () => {
    const p = params({ yearReset: false, carryForward: true });
    const carry = customCarryForYears(p, [[{ kind: 'sell_gain', amountEur: -100 }]]);
    expect(carry.cumulativePoolEur).toBe(-100);
    expect(carry.cumulativeHeldEur).toBe(0);
    const y2 = settleCustomYear({
      params: p,
      carry,
      existingEvents: [],
      heldEur: 0,
      newEvents: [{ kind: 'sell_gain', amountEur: 450 }],
    });
    // 27.5 % × (450 − 100) — the Jan-1 boundary did not eat the loss.
    expect(y2.newEventDeltasEur).toEqual([96.25]);
    expect(y2.heldAfterEur).toBe(96.25);
  });

  it('a later-year loss refunds prior years’ tax (negative year component)', () => {
    const p = params({ yearReset: false });
    // Year 1: +400 taxed 110.00; its component is attributed to year 1.
    const carry = customCarryForYears(p, [[{ kind: 'sell_gain', amountEur: 400 }]]);
    expect(carry.cumulativeHeldEur).toBe(110);
    // Year 2's loss shrinks the ONE cumulative pool → a refund in year 2.
    const y2 = settleCustomYear({
      params: p,
      carry,
      existingEvents: [],
      heldEur: 0,
      newEvents: [{ kind: 'sell_gain', amountEur: -200 }],
    });
    expect(y2.newEventDeltasEur).toEqual([-55]);
    expect(y2.heldAfterEur).toBe(-55);
    expect(y2.carryOut.cumulativePoolEur).toBe(200);
    expect(y2.carryOut.cumulativeHeldEur).toBe(55);
  });

  it('with refund also off, the cumulative regime still never refunds', () => {
    const p = params({ yearReset: false, refund: false });
    const carry = customCarryForYears(p, [[{ kind: 'sell_gain', amountEur: 400 }]]);
    expect(carry.cumulativeHeldEur).toBe(110);
    const y2 = settleCustomYear({
      params: p,
      carry,
      existingEvents: [],
      heldEur: 0,
      newEvents: [
        { kind: 'sell_gain', amountEur: -200 },
        { kind: 'sell_gain', amountEur: 300 },
      ],
    });
    // Loss: clamped to 0. Gain: cumulative pool 500 → target 137.50, of which
    // 110 already sits in prior years — this year's component is 27.50.
    expect(y2.newEventDeltasEur).toEqual([0, 27.5]);
    expect(y2.carryOut.cumulativeHeldEur).toBe(137.5);
  });
});

describe('yearReset on + carryForward on: a loss pot survives the boundary', () => {
  it('chains a net-loss remainder into later years like the DE pot', () => {
    const p = params({ carryForward: true });
    const carry = customCarryForYears(p, [
      [{ kind: 'sell_gain', amountEur: -300 }],
      [{ kind: 'sell_gain', amountEur: 100 }],
    ]);
    // Year 1 parks 300 in the pot; year 2's +100 consumes part of it.
    expect(carry.potEur).toBe(200);
    const y3 = settleCustomYear({
      params: p,
      carry,
      existingEvents: [],
      heldEur: 0,
      newEvents: [{ kind: 'dividend', amountEur: 500 }],
    });
    // 27.5 % × (500 − 200) — the pot offsets before the rate applies.
    expect(y3.newEventDeltasEur).toEqual([82.5]);
    expect(y3.carryOut.potEur).toBe(0);
  });

  it('an empty year passes the pot through unchanged', () => {
    const p = params({ carryForward: true });
    const carry = customCarryForYears(p, [[{ kind: 'sell_gain', amountEur: -150 }], []]);
    expect(carry.potEur).toBe(150);
  });
});

describe('cost-basis seam: FIFO vs moving-average diverge under custom', () => {
  it('the same log realizes different gains per strategy, so different tax', () => {
    const log = [
      {
        id: 'b1',
        assetId: 'A',
        side: 'buy' as const,
        quantity: 1,
        priceEur: 100,
        feeEur: 0,
        executedAt: '2026-01-05T10:00:00Z',
      },
      {
        id: 'b2',
        assetId: 'A',
        side: 'buy' as const,
        quantity: 1,
        priceEur: 200,
        feeEur: 0,
        executedAt: '2026-02-05T10:00:00Z',
      },
      {
        id: 's1',
        assetId: 'A',
        side: 'sell' as const,
        quantity: 1,
        priceEur: 300,
        feeEur: 0,
        executedAt: '2026-03-05T10:00:00Z',
      },
    ];
    const fifoGain = realizedSellsEur(log, 'fifo')[0]!.realizedPnlEur;
    const avgGain = realizedSellsEur(log, 'moving-average')[0]!.realizedPnlEur;
    expect(fifoGain).toBe(200); // oldest lot (100) consumed
    expect(avgGain).toBe(150); // average basis 150

    const settle = (amountEur: number) =>
      settleCustomYear({
        params: params({ ratePct: 10 }),
        carry: initialCustomCarry(),
        existingEvents: [],
        heldEur: 0,
        newEvents: [{ kind: 'sell_gain', amountEur }],
      }).heldAfterEur;
    expect(settle(fifoGain)).toBe(20);
    expect(settle(avgGain)).toBe(15);
  });
});

describe('validation fails loud', () => {
  it('rejects an out-of-range rate, bad flags, and malformed events', () => {
    const base = {
      carry: initialCustomCarry(),
      existingEvents: [],
      heldEur: 0,
      newEvents: [],
    };
    expect(() => settleCustomYear({ ...base, params: params({ ratePct: 101 }) })).toThrow(
      TaxComputationError,
    );
    expect(() => settleCustomYear({ ...base, params: params({ ratePct: Number.NaN }) })).toThrow(
      TaxComputationError,
    );
    expect(() =>
      settleCustomYear({
        ...base,
        params: params({ costBasis: 'lifo' as unknown as 'fifo' }),
      }),
    ).toThrow(TaxComputationError);
    expect(() =>
      settleCustomYear({
        ...base,
        params: params(),
        newEvents: [{ kind: 'dividend', amountEur: 0 }],
      }),
    ).toThrow(TaxComputationError);
    expect(() =>
      settleCustomYear({
        ...base,
        params: params(),
        newEvents: [{ kind: 'bogus' as 'dividend', amountEur: 1 }],
      }),
    ).toThrow(TaxComputationError);
    expect(() => settleCustomYear({ ...base, params: params(), heldEur: Infinity })).toThrow(
      TaxComputationError,
    );
  });
});
