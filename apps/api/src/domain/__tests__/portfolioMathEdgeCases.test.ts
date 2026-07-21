import { describe, expect, it, vi } from 'vitest';

import { allocateBudget } from '../allocation';
import {
  costBasisOverTime,
  deriveHoldings,
  reducePosition,
  timeWeightedReturn,
  valueOverTime,
  type CurrencyConverter,
  type FlowPoint,
  type HoldingAssetInput,
  type Transaction,
  type ValueOverTimeAsset,
  type ValuePoint,
} from '../holdings';

/**
 * Deepened edge-case coverage for the portfolio domain math (issue #629):
 * holdings cost-basis + P/L across buys/sells/fees, moving-average correctness,
 * the incoming-cash-accumulates linking base (#218), allocation/deviation math,
 * and the daily-snapshot invalidation contract (dirty-from earliest-affected
 * day, rows-before-fromDay untouched — {@link costBasisOverTime}/
 * {@link valueOverTime} are prefix-deterministic, which is what makes
 * `PortfolioSnapshotService.invalidate` correct). Every assertion is an exact
 * number; nothing here reads a clock or the network.
 */

// --- Helpers ---------------------------------------------------------------

/** Build a transaction with sensible defaults; override only what a case needs. */
function tx(
  over: Partial<Transaction> & Pick<Transaction, 'side' | 'quantity' | 'price'>,
): Transaction {
  return {
    assetId: over.assetId ?? 'A',
    side: over.side,
    quantity: over.quantity,
    price: over.price,
    fee: over.fee ?? 0,
    executedAt: over.executedAt ?? '2024-01-01T10:00:00Z',
    allowUncovered: over.allowUncovered,
    uncoveredEntryPrice: over.uncoveredEntryPrice,
  };
}

/** `amount → amount · rate(currency)`; constant across spot and historical days. */
function fxConverter(rates: Record<string, number> = { EUR: 1, USD: 0.9 }): CurrencyConverter {
  return {
    toBase: vi.fn((amount: number, currency: string) => {
      const rate = rates[currency];
      if (rate === undefined) return Promise.reject(new Error(`no rate for ${currency}`));
      return Promise.resolve(amount * rate);
    }),
  };
}

// ---------------------------------------------------------------------------
// reducePosition — moving-average basis & realized P/L across buys/sells/fees
// ---------------------------------------------------------------------------

describe('reducePosition — moving-average basis edge cases', () => {
  it('re-averages across three buys with a capitalised fee; a covered sell leaves the average untouched', () => {
    const state = reducePosition([
      tx({ side: 'buy', quantity: 10, price: 100 }), // avg 100, held 10
      tx({ side: 'buy', quantity: 10, price: 200 }), // avg (1000+2000)/20 = 150, held 20
      tx({ side: 'buy', quantity: 5, price: 300, fee: 50 }), // avg (3000+1500+50)/25 = 182, held 25
      tx({ side: 'sell', quantity: 5, price: 250, fee: 10 }), // realized 5·(250−182)−10 = 330
    ]);

    expect(state.quantity).toBe(20);
    expect(state.avgCost).toBe(182); // fees capitalised into basis; sell does NOT move it
    expect(state.realizedPnl).toBe(330);
    expect(state.realizations).toEqual([{ index: 3, realizedPnl: 330 }]);
  });

  it('a full close resets the average, and a re-entry re-averages from scratch (not from a stale basis)', () => {
    const state = reducePosition([
      tx({ side: 'buy', quantity: 10, price: 100 }), // avg 100
      tx({ side: 'sell', quantity: 10, price: 120 }), // realized 200, flat → avg resets to 0
      tx({ side: 'buy', quantity: 5, price: 50, fee: 5 }), // avg (250+5)/5 = 51 — fresh, not blended with the old 100
    ]);

    expect(state.quantity).toBe(5);
    expect(state.avgCost).toBe(51);
    expect(state.realizedPnl).toBe(200);
  });

  it('accumulates realized P/L across multiple sells with fees, each tagged to its input row', () => {
    const state = reducePosition([
      tx({ side: 'buy', quantity: 20, price: 100 }), // avg 100
      tx({ side: 'sell', quantity: 5, price: 110, fee: 2 }), // +48
      tx({ side: 'sell', quantity: 5, price: 90, fee: 3 }), // −53
    ]);

    expect(state.quantity).toBe(10);
    expect(state.avgCost).toBe(100); // sells never move the average
    expect(state.realizedPnl).toBe(-5); // 48 − 53
    expect(state.realizations).toEqual([
      { index: 1, realizedPnl: 48 },
      { index: 2, realizedPnl: -53 },
    ]);
  });

  it('a zero-price buy (a transfer-in / gift) averages the basis down correctly', () => {
    const state = reducePosition([
      tx({ side: 'buy', quantity: 10, price: 100 }), // avg 100, held 10
      tx({ side: 'buy', quantity: 10, price: 0 }), // avg (1000+0)/20 = 50, held 20
    ]);

    expect(state.quantity).toBe(20);
    expect(state.avgCost).toBe(50);
    expect(state.realizedPnl).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// deriveHoldings — FX & quote edge cases
// ---------------------------------------------------------------------------

describe('deriveHoldings — FX and quote edge cases', () => {
  it('keeps the unrealized % FX-independent while the EUR figures scale with the spot rate', async () => {
    const txns: Transaction[] = [tx({ side: 'buy', quantity: 10, price: 100 })]; // avg 100
    const assets: HoldingAssetInput[] = [
      { assetId: 'A', currency: 'USD', quote: { price: 120, prevClose: 100 } },
    ];

    const [h] = await deriveHoldings(txns, assets, fxConverter());

    expect(h?.marketValueEur).toBe(1080); // 10·120·0.9
    expect(h?.costBasisEur).toBe(900); // 10·100·0.9
    expect(h?.unrealizedPnlEur).toBe(180); // (market − cost) — one FX conversion of native P/L
    expect(h?.unrealizedPnlPct).toBe(20); // (120 − 100)/100 — no FX in the ratio
    expect(h?.dayChangeEur).toBe(180); // 10·(120 − 100)·0.9
    expect(h?.dayChangePct).toBe(20); // (120 − 100)/100
  });

  it('a zero previous close yields a null day-change % but still a real EUR day change', async () => {
    const txns: Transaction[] = [tx({ side: 'buy', quantity: 10, price: 40 })];
    const assets: HoldingAssetInput[] = [
      { assetId: 'A', currency: 'USD', quote: { price: 50, prevClose: 0 } },
    ];

    const [h] = await deriveHoldings(txns, assets, fxConverter());

    expect(h?.dayChangeEur).toBe(450); // 10·(50 − 0)·0.9
    expect(h?.dayChangePct).toBeNull(); // division by a zero prev close is refused, not Infinity
    expect(h?.unrealizedPnlPct).toBe(25); // (50 − 40)/40
  });
});

// ---------------------------------------------------------------------------
// timeWeightedReturn — incoming-cash-accumulates linking base (issue #218)
// ---------------------------------------------------------------------------

describe('timeWeightedReturn — pre-price basis accumulation (issue #218)', () => {
  it('books a partial sell before the first value point against the full seeded basis (documented residual)', () => {
    // Cash comes in before the asset has any price (value unmeasurable), then a
    // partial sell lands still pre-price, then the first real value arrives. Per
    // the docstring, the partial sell books against the WHOLE seeded basis as if
    // the remainder were worth 0 — the domain has no price to know otherwise.
    const values: ValuePoint[] = [
      { date: '2024-03-01', valueEur: 0 }, // no price yet
      { date: '2024-03-02', valueEur: 0 }, // still no price
      { date: '2024-03-03', valueEur: 900 }, // first real value
    ];
    const flows: FlowPoint[] = [
      { date: '2024-03-01', flowEur: 1000 }, // inflow accumulates into the basis
      { date: '2024-03-02', flowEur: -400 }, // partial sell, still pre-price
    ];

    const perf = timeWeightedReturn(values, flows);

    expect(perf).toEqual([
      { date: '2024-03-01', pct: 0 }, // pre-price inflow: flat, basis seeded to 1000
      { date: '2024-03-02', pct: -60 }, // 400/1000 → 0.4 index; sell booked vs the full 1000
      { date: '2024-03-03', pct: -60 }, // base reset by the outflow → the later real value can't recover it
    ]);
  });
});

// ---------------------------------------------------------------------------
// Daily-snapshot invalidation invariants (V5-P1, issue #553)
//
// PortfolioSnapshotService.invalidate marks the series dirty FROM the earliest
// affected day and deletes only those rows; everything before is left untouched
// and recomputed rows must reproduce a full recompute. Both rest on these two
// domain guarantees.
// ---------------------------------------------------------------------------

describe('valueOverTime / costBasisOverTime — snapshot invalidation invariants', () => {
  const asset: ValueOverTimeAsset = {
    assetId: 'A',
    currency: 'USD',
    prices: [{ date: '2024-01-01', close: 100 }], // one close, carried forward daily
  };

  it('a later transaction changes only points from its day onward (earliest-affected-day)', async () => {
    const base: Transaction[] = [
      tx({ side: 'buy', quantity: 10, price: 100, executedAt: '2024-01-01T10:00:00Z' }),
    ];
    const withLater: Transaction[] = [
      ...base,
      tx({ side: 'buy', quantity: 5, price: 100, executedAt: '2024-01-03T10:00:00Z' }),
    ];

    const before = await valueOverTime({
      transactions: base,
      assets: [asset],
      today: '2024-01-05',
      converter: fxConverter(),
    });
    const after = await valueOverTime({
      transactions: withLater,
      assets: [asset],
      today: '2024-01-05',
      converter: fxConverter(),
    });

    // 5 days, each held·close·0.9 = 10·100·0.9 = 900 before the extra buy.
    expect(before.map((p) => p.valueEur)).toEqual([900, 900, 900, 900, 900]);
    // Rows before 2024-01-03 are byte-identical; only 01-03..01-05 move to 1350.
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
    expect(after.map((p) => p.valueEur)).toEqual([900, 900, 1350, 1350, 1350]);
  });

  it('recomputing the cost-basis series over a longer window reproduces the earlier rows exactly', async () => {
    const txns: Transaction[] = [
      tx({ side: 'buy', quantity: 10, price: 100, executedAt: '2024-01-01T10:00:00Z' }),
      tx({ side: 'buy', quantity: 5, price: 100, executedAt: '2024-01-03T10:00:00Z' }),
    ];

    const short = await costBasisOverTime({
      transactions: txns,
      assets: [asset],
      today: '2024-01-02',
      converter: fxConverter(),
    });
    const long = await costBasisOverTime({
      transactions: txns,
      assets: [asset],
      today: '2024-01-05',
      converter: fxConverter(),
    });

    // Open cost = held·avgCost·0.9 = 10·100·0.9 = 900 through 01-02, 15·100·0.9 = 1350 after.
    expect(short.map((p) => p.costBasisEur)).toEqual([900, 900]);
    expect(long.map((p) => p.costBasisEur)).toEqual([900, 900, 1350, 1350, 1350]);
    // "Rows before fromDay are untouched": the longer recompute yields the same
    // prefix a shorter one did — nothing before the changed day is rewritten.
    expect(long.slice(0, short.length)).toEqual(short);
  });
});

// ---------------------------------------------------------------------------
// allocateBudget — deviation math edge cases (§6.7)
// ---------------------------------------------------------------------------

describe('allocateBudget — deviation edge cases', () => {
  it('a single-weight basket floors to the affordable share count and reports the budget-relative deviation', () => {
    const result = allocateBudget({
      budgetEur: 1000,
      mode: 'whole',
      positions: [{ assetId: 'A', symbol: 'AAA', weight: 1, priceEur: 300 }],
    });

    expect(result.positions).toEqual([
      {
        assetId: 'A',
        symbol: 'AAA',
        qty: 3, // floor(1000/300); a 4th share (1200 €) overshoots
        costEur: 900,
        actualPct: 90, // 900/1000
        targetPct: 100,
        deltaPp: -10, // achieved vs target, budget-relative
      },
    ]);
    expect(result.totalCostEur).toBe(900);
    expect(result.leftoverEur).toBe(100);
    expect(result.warnings).toEqual([]); // qty > 0 ⇒ no unreachable note
  });

  it('lands an even split exactly on target with zero leftover and zero deviation', () => {
    const result = allocateBudget({
      budgetEur: 1000,
      mode: 'whole',
      positions: [
        { assetId: 'A', symbol: 'AAA', weight: 0.5, priceEur: 100 },
        { assetId: 'B', symbol: 'BBB', weight: 0.5, priceEur: 100 },
      ],
    });

    expect(result.positions.map((p) => p.qty)).toEqual([5, 5]); // floor(500/100) each
    expect(result.positions.map((p) => p.deltaPp)).toEqual([0, 0]);
    expect(result.totalCostEur).toBe(1000);
    expect(result.leftoverEur).toBe(0); // no greedy fill can afford a 6th share
  });
});
