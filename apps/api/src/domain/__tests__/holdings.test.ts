import { describe, expect, it, vi } from 'vitest';

import {
  dailyCloseSeries,
  deriveHoldings,
  netFlowsOverTime,
  OversellError,
  QTY_EPSILON,
  rebasePerformance,
  reducePosition,
  timeWeightedReturn,
  valueOverTime,
  type CurrencyConverter,
  type HoldingAssetInput,
  type Transaction,
  type ValueOverTimeAsset,
} from '../holdings';

// --- Helpers ---------------------------------------------------------------

/** Build a transaction with sensible defaults; override what a case needs. */
function tx(
  over: Partial<Transaction> & Pick<Transaction, 'side' | 'quantity' | 'price'>,
): Transaction {
  return {
    assetId: over.assetId ?? 'A',
    side: over.side,
    quantity: over.quantity,
    price: over.price,
    fee: over.fee ?? 0,
    executedAt: over.executedAt ?? '2026-01-01T00:00:00Z',
  };
}

/**
 * A stub converter: `amount → amount · rate(currency)`. Because the rate is the
 * same for spot and historical, both holdings (spot) and value-over-time
 * (historical) can share it. `vi.fn` so tests can assert FX coalescing.
 */
function stubConverter(rates: Record<string, number> = { EUR: 1, USD: 0.9 }): CurrencyConverter {
  return {
    toBase: vi.fn((amount: number, currency: string) => {
      const rate = rates[currency];
      if (rate === undefined) return Promise.reject(new Error(`no rate for ${currency}`));
      return Promise.resolve(amount * rate);
    }),
  };
}

/**
 * A date-aware stub converter for verifying **historical FX** (§5.4): EUR is
 * identity; any other currency requires `opts.date` and looks its daily rate up
 * in `ratesByDate` — a missing (currency, date) rate rejects, so a test fails
 * loud if valueOverTime ever asks for a spot rate or the wrong day.
 */
function datedStubConverter(
  ratesByDate: Record<string, Record<string, number>>,
): CurrencyConverter {
  return {
    toBase: vi.fn((amount: number, currency: string, opts?: { date?: string }) => {
      if (currency === 'EUR') return Promise.resolve(amount);
      const rate = opts?.date === undefined ? undefined : ratesByDate[currency]?.[opts.date];
      if (rate === undefined) {
        return Promise.reject(new Error(`no rate for ${currency} on ${opts?.date ?? 'spot'}`));
      }
      return Promise.resolve(amount * rate);
    }),
  };
}

// ---------------------------------------------------------------------------
// reducePosition — average cost & realized P/L (§6.8)
// ---------------------------------------------------------------------------

describe('reducePosition', () => {
  describe('average-cost basis (BUY re-averages, fees capitalised)', () => {
    it.each([
      {
        name: 'single buy, no fee',
        txns: [tx({ side: 'buy', quantity: 10, price: 100 })],
        quantity: 10,
        avgCost: 100,
      },
      {
        name: 'single buy capitalises the fee',
        txns: [tx({ side: 'buy', quantity: 10, price: 100, fee: 5 })],
        quantity: 10,
        // (0 + 10·100 + 5) / 10
        avgCost: 100.5,
      },
      {
        name: 'two buys re-average with fees',
        txns: [
          tx({ side: 'buy', quantity: 10, price: 100, fee: 5, executedAt: '2026-01-01T00:00:00Z' }),
          tx({ side: 'buy', quantity: 5, price: 120, executedAt: '2026-01-02T00:00:00Z' }),
        ],
        quantity: 15,
        // (10·100.5 + 5·120) / 15 = 1605 / 15
        avgCost: 107,
      },
    ])('$name', ({ txns, quantity, avgCost }) => {
      const pos = reducePosition(txns);
      expect(pos.quantity).toBeCloseTo(quantity, 10);
      expect(pos.avgCost).toBeCloseTo(avgCost, 10);
      expect(pos.realizedPnl).toBe(0);
    });
  });

  describe('SELL realizes P/L and leaves average cost unchanged', () => {
    it('realized P/L = qty·(price − avg) − fee; avg unchanged', () => {
      const pos = reducePosition([
        tx({ side: 'buy', quantity: 10, price: 100, fee: 5, executedAt: '2026-01-01T00:00:00Z' }),
        tx({ side: 'buy', quantity: 5, price: 120, executedAt: '2026-01-02T00:00:00Z' }),
        // held 15 @ avg 107; sell 4 @ 130 fee 2 → 4·(130−107) − 2 = 90
        tx({ side: 'sell', quantity: 4, price: 130, fee: 2, executedAt: '2026-01-03T00:00:00Z' }),
      ]);
      expect(pos.quantity).toBeCloseTo(11, 10);
      expect(pos.avgCost).toBeCloseTo(107, 10);
      expect(pos.realizedPnl).toBeCloseTo(90, 10);
      expect(pos.realizations).toEqual([{ index: 2, realizedPnl: expect.closeTo(90, 10) }]);
    });

    it('interleaved buy/sell: the running average drives realized P/L', () => {
      const pos = reducePosition([
        tx({ side: 'buy', quantity: 10, price: 100, executedAt: '2026-01-01T00:00:00Z' }),
        // sell 5 @ 110 against avg 100 → +50; held 5 @ 100
        tx({ side: 'sell', quantity: 5, price: 110, executedAt: '2026-01-02T00:00:00Z' }),
        // buy 5 @ 200 → (5·100 + 5·200)/10 = 150
        tx({ side: 'buy', quantity: 5, price: 200, executedAt: '2026-01-03T00:00:00Z' }),
      ]);
      expect(pos.quantity).toBeCloseTo(10, 10);
      expect(pos.avgCost).toBeCloseTo(150, 10);
      expect(pos.realizedPnl).toBeCloseTo(50, 10);
    });

    it('orders by executedAt, not input order; realization index points at the input row', () => {
      // Same economics as above but supplied out of chronological order.
      const pos = reducePosition([
        tx({ side: 'buy', quantity: 5, price: 200, executedAt: '2026-01-03T00:00:00Z' }), // index 0
        tx({ side: 'buy', quantity: 10, price: 100, executedAt: '2026-01-01T00:00:00Z' }), // index 1
        tx({ side: 'sell', quantity: 5, price: 110, executedAt: '2026-01-02T00:00:00Z' }), // index 2
      ]);
      expect(pos.avgCost).toBeCloseTo(150, 10);
      expect(pos.realizedPnl).toBeCloseTo(50, 10);
      expect(pos.realizations).toEqual([{ index: 2, realizedPnl: expect.closeTo(50, 10) }]);
    });
  });

  describe('precision (§5.4 — exact decimal cases, asserted with toBe, no drift)', () => {
    // Inputs chosen so every intermediate double is exactly representable
    // (prices on 1/4- and 1/8-cent boundaries): any mid-computation rounding or
    // drift would break strict equality.
    it.each([
      {
        name: 'buy with fee: avg = (8·100.25 + 2)/8 = 100.5 exactly',
        txns: [tx({ side: 'buy', quantity: 8, price: 100.25, fee: 2 })],
        quantity: 8,
        avgCost: 100.5,
        realizedPnl: 0,
      },
      {
        name: 're-average: (4·100.5 + 4·101.5 + 1)/8 = 101.125 exactly',
        txns: [
          tx({ side: 'buy', quantity: 4, price: 100.5, executedAt: '2026-01-01T00:00:00Z' }),
          tx({
            side: 'buy',
            quantity: 4,
            price: 101.5,
            fee: 1,
            executedAt: '2026-01-02T00:00:00Z',
          }),
        ],
        quantity: 8,
        avgCost: 101.125,
        realizedPnl: 0,
      },
      {
        name: 'sell: realized = 4·(130.75 − 100.5) − 2.5 = 118.5 exactly; avg unchanged',
        txns: [
          tx({
            side: 'buy',
            quantity: 8,
            price: 100.25,
            fee: 2,
            executedAt: '2026-01-01T00:00:00Z',
          }),
          tx({
            side: 'sell',
            quantity: 4,
            price: 130.75,
            fee: 2.5,
            executedAt: '2026-01-02T00:00:00Z',
          }),
        ],
        quantity: 4,
        avgCost: 100.5,
        realizedPnl: 118.5,
      },
      {
        name: 'sell at avg cost: realized = −fee exactly',
        txns: [
          tx({ side: 'buy', quantity: 2, price: 50.25, executedAt: '2026-01-01T00:00:00Z' }),
          tx({
            side: 'sell',
            quantity: 1,
            price: 50.25,
            fee: 1.25,
            executedAt: '2026-01-02T00:00:00Z',
          }),
        ],
        quantity: 1,
        avgCost: 50.25,
        realizedPnl: -1.25,
      },
    ])('$name', ({ txns, quantity, avgCost, realizedPnl }) => {
      const pos = reducePosition(txns);
      expect(pos.quantity).toBe(quantity);
      expect(pos.avgCost).toBe(avgCost);
      expect(pos.realizedPnl).toBe(realizedPnl);
    });

    it('handles 6-dp fractional quantities: closing the position lands on exactly 0', () => {
      const pos = reducePosition([
        tx({ side: 'buy', quantity: 0.123456, price: 81, executedAt: '2026-01-01T00:00:00Z' }),
        tx({ side: 'sell', quantity: 0.123456, price: 90, executedAt: '2026-01-02T00:00:00Z' }),
      ]);
      expect(pos.quantity).toBe(0);
      expect(pos.avgCost).toBe(0);
      expect(pos.realizedPnl).toBeCloseTo(0.123456 * 9, 9);
    });
  });

  describe('selling the whole position', () => {
    it('selling exactly the held quantity flattens to 0 and resets avg', () => {
      const pos = reducePosition([
        tx({ side: 'buy', quantity: 3.5, price: 10, executedAt: '2026-01-01T00:00:00Z' }),
        tx({ side: 'sell', quantity: 3.5, price: 12, executedAt: '2026-01-02T00:00:00Z' }),
      ]);
      expect(pos.quantity).toBe(0);
      expect(pos.avgCost).toBe(0);
      expect(pos.realizedPnl).toBeCloseTo(7, 10); // 3.5·(12−10)
    });

    it('floating-point dust from a sell-everything clamps to exactly 0', () => {
      // 0.1 + 0.2 = 0.30000000000000004; selling 0.3 leaves ~4.4e-17.
      const pos = reducePosition([
        tx({ side: 'buy', quantity: 0.1, price: 10, executedAt: '2026-01-01T00:00:00Z' }),
        tx({ side: 'buy', quantity: 0.2, price: 10, executedAt: '2026-01-02T00:00:00Z' }),
        tx({ side: 'sell', quantity: 0.3, price: 10, executedAt: '2026-01-03T00:00:00Z' }),
      ]);
      expect(pos.quantity).toBe(0);
      expect(pos.avgCost).toBe(0);
    });
  });

  describe('negative-sell rejection', () => {
    it('rejects a sell that would push held quantity negative', () => {
      expect(() =>
        reducePosition([
          tx({ side: 'buy', quantity: 10, price: 100, executedAt: '2026-01-01T00:00:00Z' }),
          tx({ side: 'sell', quantity: 11, price: 100, executedAt: '2026-01-02T00:00:00Z' }),
        ]),
      ).toThrow(OversellError);
    });

    it('rejects selling with nothing held', () => {
      expect(() => reducePosition([tx({ side: 'sell', quantity: 1, price: 100 })])).toThrow(
        OversellError,
      );
    });

    it('OversellError carries the requested and held quantities', () => {
      try {
        reducePosition([
          tx({ side: 'buy', quantity: 3.5, price: 10, executedAt: '2026-01-01T00:00:00Z' }),
          tx({ side: 'sell', quantity: 4, price: 10, executedAt: '2026-01-02T00:00:00Z' }),
        ]);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(OversellError);
        const oversell = err as OversellError;
        expect(oversell.requested).toBe(4);
        expect(oversell.held).toBeCloseTo(3.5, 10);
        expect(oversell.assetId).toBe('A');
        expect(oversell.message).toMatch(/only 3.5 held/);
      }
    });

    it('rejects an oversell of one stored quantity unit (1e-8) — just past the tolerance', () => {
      expect(() =>
        reducePosition([
          tx({ side: 'buy', quantity: 5, price: 10, executedAt: '2026-01-01T00:00:00Z' }),
          tx({ side: 'sell', quantity: 5 + 1e-8, price: 10, executedAt: '2026-01-02T00:00:00Z' }),
        ]),
      ).toThrow(OversellError);
    });

    it('rejects an oversell after partial sells reduced the held quantity', () => {
      expect(() =>
        reducePosition([
          tx({ side: 'buy', quantity: 10, price: 10, executedAt: '2026-01-01T00:00:00Z' }),
          tx({ side: 'sell', quantity: 6, price: 10, executedAt: '2026-01-02T00:00:00Z' }),
          tx({ side: 'sell', quantity: 4.001, price: 10, executedAt: '2026-01-03T00:00:00Z' }),
        ]),
      ).toThrow(/only 4 held/);
    });

    it('allows a sell within QTY_EPSILON of the held quantity', () => {
      const pos = reducePosition([
        tx({ side: 'buy', quantity: 5, price: 10, executedAt: '2026-01-01T00:00:00Z' }),
        tx({
          side: 'sell',
          quantity: 5 + QTY_EPSILON / 2,
          price: 10,
          executedAt: '2026-01-02T00:00:00Z',
        }),
      ]);
      expect(pos.quantity).toBe(0);
    });
  });

  describe('validation (money path fails loud)', () => {
    it('rejects a zero/negative quantity', () => {
      expect(() => reducePosition([tx({ side: 'buy', quantity: 0, price: 100 })])).toThrow(
        /quantity/,
      );
    });
    it('rejects a negative price', () => {
      expect(() => reducePosition([tx({ side: 'buy', quantity: 1, price: -1 })])).toThrow(/price/);
    });
    it('rejects transactions spanning multiple assets', () => {
      expect(() =>
        reducePosition([
          tx({ assetId: 'A', side: 'buy', quantity: 1, price: 10 }),
          tx({ assetId: 'B', side: 'buy', quantity: 1, price: 10 }),
        ]),
      ).toThrow(/multiple assets/);
    });
  });
});

// ---------------------------------------------------------------------------
// deriveHoldings — the holdings view (§6.8)
// ---------------------------------------------------------------------------

describe('deriveHoldings', () => {
  it('derives qty, avg cost, market value, unrealized P/L €/% and day change', async () => {
    const transactions: Transaction[] = [
      // EUR asset: 10 @ 100, now 120 (prev close 110)
      tx({ assetId: 'A', side: 'buy', quantity: 10, price: 100 }),
      // USD asset: 5 @ 200, now 220 (prev close 210)
      tx({ assetId: 'B', side: 'buy', quantity: 5, price: 200 }),
    ];
    const assets: HoldingAssetInput[] = [
      { assetId: 'A', currency: 'EUR', quote: { price: 120, prevClose: 110 } },
      { assetId: 'B', currency: 'USD', quote: { price: 220, prevClose: 210 } },
    ];

    const [a, b] = await deriveHoldings(transactions, assets, stubConverter());

    expect(a).toMatchObject({ assetId: 'A', currency: 'EUR', quantity: 10, avgCost: 100 });
    expect(a?.marketValueEur).toBeCloseTo(1200, 10); // 10·120 · 1
    expect(a?.costBasisEur).toBeCloseTo(1000, 10); // 10·100 · 1
    expect(a?.unrealizedPnlEur).toBeCloseTo(200, 10);
    expect(a?.unrealizedPnlPct).toBeCloseTo(20, 10);
    expect(a?.dayChangeEur).toBeCloseTo(100, 10); // 10·(120−110)
    expect(a?.dayChangePct).toBeCloseTo(9.090909, 5);

    expect(b).toMatchObject({ assetId: 'B', currency: 'USD', quantity: 5, avgCost: 200 });
    expect(b?.marketValueEur).toBeCloseTo(990, 10); // 5·220 · 0.9
    expect(b?.costBasisEur).toBeCloseTo(900, 10); // 5·200 · 0.9
    expect(b?.unrealizedPnlEur).toBeCloseTo(90, 10);
    expect(b?.unrealizedPnlPct).toBeCloseTo(10, 10); // FX-independent
    expect(b?.dayChangeEur).toBeCloseTo(45, 10); // 5·(220−210)·0.9
    expect(b?.dayChangePct).toBeCloseTo(4.761905, 5);
  });

  it('handles a loss position (negative P/L and day change convert correctly)', async () => {
    const [d] = await deriveHoldings(
      [tx({ assetId: 'D', side: 'buy', quantity: 10, price: 100 })],
      [{ assetId: 'D', currency: 'EUR', quote: { price: 90, prevClose: 95 } }],
      stubConverter(),
    );
    expect(d?.unrealizedPnlEur).toBeCloseTo(-100, 10);
    expect(d?.unrealizedPnlPct).toBeCloseTo(-10, 10);
    expect(d?.dayChangeEur).toBeCloseTo(-50, 10);
    expect(d?.dayChangePct).toBeCloseTo(-5.263158, 5);
  });

  it('keeps the open position when there is no quote (EUR figures null)', async () => {
    const [h] = await deriveHoldings(
      [tx({ assetId: 'A', side: 'buy', quantity: 4, price: 50 })],
      [{ assetId: 'A', currency: 'EUR', quote: null }],
      stubConverter(),
    );
    expect(h).toMatchObject({
      quantity: 4,
      avgCost: 50,
      price: null,
      marketValueEur: null,
      costBasisEur: null,
      unrealizedPnlEur: null,
      unrealizedPnlPct: null,
      dayChangeEur: null,
      dayChangePct: null,
    });
  });

  it('omits day change when prev close is missing but keeps unrealized P/L', async () => {
    const [h] = await deriveHoldings(
      [tx({ assetId: 'A', side: 'buy', quantity: 2, price: 50 })],
      [{ assetId: 'A', currency: 'EUR', quote: { price: 60 } }],
      stubConverter(),
    );
    expect(h?.unrealizedPnlEur).toBeCloseTo(20, 10);
    expect(h?.dayChangeEur).toBeNull();
    expect(h?.dayChangePct).toBeNull();
  });

  it('includes a fully-closed position with its realized P/L but null market figures', async () => {
    const [h] = await deriveHoldings(
      [
        tx({
          assetId: 'A',
          side: 'buy',
          quantity: 5,
          price: 10,
          executedAt: '2026-01-01T00:00:00Z',
        }),
        tx({
          assetId: 'A',
          side: 'sell',
          quantity: 5,
          price: 14,
          executedAt: '2026-01-02T00:00:00Z',
        }),
      ],
      [{ assetId: 'A', currency: 'EUR', quote: { price: 14, prevClose: 13 } }],
      stubConverter(),
    );
    expect(h?.quantity).toBe(0);
    expect(h?.realizedPnl).toBeCloseTo(20, 10); // 5·(14−10)
    expect(h?.marketValueEur).toBeNull();
    expect(h?.unrealizedPnlEur).toBeNull();
  });

  it('throws when a transacted asset has no currency/quote input (no silent omission)', async () => {
    await expect(
      deriveHoldings(
        [
          tx({ assetId: 'A', side: 'buy', quantity: 1, price: 10 }),
          tx({ assetId: 'Z', side: 'buy', quantity: 1, price: 10 }),
        ],
        [{ assetId: 'A', currency: 'EUR', quote: { price: 12 } }],
        stubConverter(),
      ),
    ).rejects.toThrow(/assets with no currency\/quote input: Z/);
  });

  it('preserves the asset input order and skips assets with no transactions', async () => {
    const holdings = await deriveHoldings(
      [tx({ assetId: 'B', side: 'buy', quantity: 1, price: 10 })],
      [
        { assetId: 'A', currency: 'EUR', quote: { price: 1 } }, // no txns → skipped
        { assetId: 'B', currency: 'EUR', quote: { price: 12 } },
      ],
      stubConverter(),
    );
    expect(holdings.map((h) => h.assetId)).toEqual(['B']);
  });
});

// ---------------------------------------------------------------------------
// valueOverTime — daily portfolio value series (§6.8)
// ---------------------------------------------------------------------------

describe('valueOverTime', () => {
  it('reconstructs a multi-asset, multi-currency series with a carried-forward custom asset', async () => {
    const transactions: Transaction[] = [
      tx({
        assetId: 'A',
        side: 'buy',
        quantity: 10,
        price: 100,
        executedAt: '2026-01-01T00:00:00Z',
      }),
      tx({ assetId: 'C', side: 'buy', quantity: 2, price: 50, executedAt: '2026-01-03T00:00:00Z' }),
      tx({
        assetId: 'X',
        side: 'buy',
        quantity: 1,
        price: 1000,
        executedAt: '2026-01-01T00:00:00Z',
      }),
    ];
    const assets: ValueOverTimeAsset[] = [
      {
        assetId: 'A',
        currency: 'EUR',
        prices: [
          { date: '2026-01-01', close: 100 },
          { date: '2026-01-02', close: 102 },
          { date: '2026-01-03', close: 101 },
          { date: '2026-01-04', close: 105 },
          { date: '2026-01-05', close: 110 },
        ],
      },
      {
        assetId: 'C',
        currency: 'USD',
        prices: [
          { date: '2026-01-03', close: 50 },
          { date: '2026-01-04', close: 52 },
          { date: '2026-01-05', close: 51 },
        ],
      },
      {
        // Custom asset: sparse value points carried forward (step function).
        assetId: 'X',
        currency: 'EUR',
        prices: [
          { date: '2026-01-01', close: 1000 },
          { date: '2026-01-04', close: 1200 },
        ],
      },
    ];

    const converter = stubConverter();
    const series = await valueOverTime({
      transactions,
      assets,
      today: '2026-01-05',
      converter,
    });

    expect(series.map((p) => p.date)).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
      '2026-01-05',
    ]);
    // 01: A 10·100 + X 1000                         = 2000
    // 02: A 10·102 + X 1000 (carry)                 = 2020
    // 03: A 10·101 + C 2·50·0.9 + X 1000            = 2100
    // 04: A 10·105 + C 2·52·0.9 + X 1200            = 2343.6
    // 05: A 10·110 + C 2·51·0.9 + X 1200            = 2391.8
    expect(series[0]?.valueEur).toBeCloseTo(2000, 6);
    expect(series[1]?.valueEur).toBeCloseTo(2020, 6);
    expect(series[2]?.valueEur).toBeCloseTo(2100, 6);
    expect(series[3]?.valueEur).toBeCloseTo(2343.6, 6);
    expect(series[4]?.valueEur).toBeCloseTo(2391.8, 6);

    // FX coalescing: exactly one conversion per (currency, day). EUR is needed
    // every day (5) — shared by A and X — and USD on the three days C is held.
    expect(converter.toBase).toHaveBeenCalledTimes(8);
  });

  it('carries a custom asset value forward between sparse points (step function)', async () => {
    const series = await valueOverTime({
      transactions: [
        tx({
          assetId: 'X',
          side: 'buy',
          quantity: 1,
          price: 1000,
          executedAt: '2026-01-01T00:00:00Z',
        }),
      ],
      assets: [
        {
          assetId: 'X',
          currency: 'EUR',
          prices: [
            { date: '2026-01-01', close: 1000 },
            { date: '2026-01-03', close: 1500 },
          ],
        },
      ],
      today: '2026-01-05',
      converter: stubConverter(),
    });
    expect(series.map((p) => p.valueEur)).toEqual([1000, 1000, 1500, 1500, 1500]);
  });

  it('values a position at zero on days before its first price point', async () => {
    // Held from day 01 but priced only from day 03 → 0 until a price exists.
    const series = await valueOverTime({
      transactions: [
        tx({
          assetId: 'A',
          side: 'buy',
          quantity: 2,
          price: 10,
          executedAt: '2026-01-01T00:00:00Z',
        }),
      ],
      assets: [
        {
          assetId: 'A',
          currency: 'EUR',
          prices: [
            { date: '2026-01-03', close: 10 },
            { date: '2026-01-04', close: 11 },
          ],
        },
      ],
      today: '2026-01-04',
      converter: stubConverter(),
    });
    expect(series.map((p) => p.valueEur)).toEqual([0, 0, 20, 22]);
  });

  it('drops to zero after the position is fully sold', async () => {
    const series = await valueOverTime({
      transactions: [
        tx({
          assetId: 'A',
          side: 'buy',
          quantity: 4,
          price: 10,
          executedAt: '2026-01-01T00:00:00Z',
        }),
        tx({
          assetId: 'A',
          side: 'sell',
          quantity: 4,
          price: 10,
          executedAt: '2026-01-03T00:00:00Z',
        }),
      ],
      assets: [
        {
          assetId: 'A',
          currency: 'EUR',
          prices: [
            { date: '2026-01-01', close: 10 },
            { date: '2026-01-02', close: 12 },
            { date: '2026-01-03', close: 11 },
          ],
        },
      ],
      today: '2026-01-03',
      converter: stubConverter(),
    });
    // 01: 4·10=40, 02: 4·12=48, 03: sold → 0
    expect(series.map((p) => p.valueEur)).toEqual([40, 48, 0]);
  });

  it("applies each day's historical FX rate — worked scenario with carry-forward and a mid-series sell", async () => {
    const converter = datedStubConverter({
      USD: {
        '2026-01-01': 0.9,
        '2026-01-02': 0.85,
        '2026-01-03': 0.8,
        '2026-01-04': 0.75,
        '2026-01-05': 0.7,
      },
    });
    const series = await valueOverTime({
      transactions: [
        tx({
          assetId: 'C',
          side: 'buy',
          quantity: 2,
          price: 50,
          executedAt: '2026-01-01T00:00:00Z',
        }),
        tx({
          assetId: 'C',
          side: 'sell',
          quantity: 1,
          price: 50,
          executedAt: '2026-01-03T00:00:00Z',
        }),
      ],
      assets: [
        {
          assetId: 'C',
          currency: 'USD',
          prices: [
            { date: '2026-01-01', close: 50 },
            { date: '2026-01-04', close: 52 },
          ],
        },
      ],
      today: '2026-01-05',
      converter,
    });

    // 01: 2·50·0.90 = 90       (buy day)
    // 02: 2·50·0.85 = 85       (price carried forward, FX moves)
    // 03: 1·50·0.80 = 40       (sell applied, price still carried)
    // 04: 1·52·0.75 = 39       (new price point)
    // 05: 1·52·0.70 = 36.4     (price carried forward)
    expect(series.map((p) => p.date)).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
      '2026-01-05',
    ]);
    expect(series[0]?.valueEur).toBeCloseTo(90, 9);
    expect(series[1]?.valueEur).toBeCloseTo(85, 9);
    expect(series[2]?.valueEur).toBeCloseTo(40, 9);
    expect(series[3]?.valueEur).toBeCloseTo(39, 9);
    expect(series[4]?.valueEur).toBeCloseTo(36.4, 9);

    // Historical, not spot: every conversion names its day.
    expect(converter.toBase).toHaveBeenCalledTimes(5);
    for (const day of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']) {
      expect(converter.toBase).toHaveBeenCalledWith(1, 'USD', { date: day });
    }
  });

  it('coalesces FX to one conversion per (currency, day) across same-currency assets', async () => {
    const converter = datedStubConverter({
      USD: { '2026-01-01': 0.9, '2026-01-02': 0.8 },
    });
    const series = await valueOverTime({
      transactions: [
        tx({
          assetId: 'C',
          side: 'buy',
          quantity: 1,
          price: 100,
          executedAt: '2026-01-01T00:00:00Z',
        }),
        tx({
          assetId: 'D',
          side: 'buy',
          quantity: 2,
          price: 50,
          executedAt: '2026-01-01T00:00:00Z',
        }),
      ],
      assets: [
        {
          assetId: 'C',
          currency: 'USD',
          prices: [
            { date: '2026-01-01', close: 100 },
            { date: '2026-01-02', close: 110 },
          ],
        },
        {
          assetId: 'D',
          currency: 'USD',
          prices: [
            { date: '2026-01-01', close: 50 },
            { date: '2026-01-02', close: 60 },
          ],
        },
      ],
      today: '2026-01-02',
      converter,
    });
    // 01: (1·100 + 2·50)·0.9 = 180; 02: (1·110 + 2·60)·0.8 = 184
    expect(series[0]?.valueEur).toBeCloseTo(180, 9);
    expect(series[1]?.valueEur).toBeCloseTo(184, 9);
    // Both USD assets share one rate lookup per day.
    expect(converter.toBase).toHaveBeenCalledTimes(2);
  });

  it('throws on an invalid FX rate instead of producing a wrong value', async () => {
    await expect(
      valueOverTime({
        transactions: [
          tx({
            assetId: 'C',
            side: 'buy',
            quantity: 1,
            price: 10,
            executedAt: '2026-01-01T00:00:00Z',
          }),
        ],
        assets: [{ assetId: 'C', currency: 'USD', prices: [{ date: '2026-01-01', close: 10 }] }],
        today: '2026-01-01',
        converter: stubConverter({ EUR: 1, USD: 0 }),
      }),
    ).rejects.toThrow(/Invalid FX rate 0 for USD/);
  });

  it('rejects a malformed price point date even when it is the only point', async () => {
    await expect(
      valueOverTime({
        transactions: [
          tx({ side: 'buy', quantity: 1, price: 10, executedAt: '2026-01-01T00:00:00Z' }),
        ],
        assets: [{ assetId: 'A', currency: 'EUR', prices: [{ date: '2026-1-3', close: 10 }] }],
        today: '2026-01-05',
        converter: stubConverter(),
      }),
    ).rejects.toThrow(/price point date/);
  });

  it('rejects a non-finite price point close', async () => {
    await expect(
      valueOverTime({
        transactions: [
          tx({ side: 'buy', quantity: 1, price: 10, executedAt: '2026-01-01T00:00:00Z' }),
        ],
        assets: [
          { assetId: 'A', currency: 'EUR', prices: [{ date: '2026-01-01', close: Number.NaN }] },
        ],
        today: '2026-01-02',
        converter: stubConverter(),
      }),
    ).rejects.toThrow(/finite/);
  });

  it('returns an empty series when there are no transactions', async () => {
    await expect(
      valueOverTime({
        transactions: [],
        assets: [],
        today: '2026-01-05',
        converter: stubConverter(),
      }),
    ).resolves.toEqual([]);
  });

  it('returns an empty series when the first transaction is after today', async () => {
    await expect(
      valueOverTime({
        transactions: [
          tx({ side: 'buy', quantity: 1, price: 10, executedAt: '2026-02-01T00:00:00Z' }),
        ],
        assets: [{ assetId: 'A', currency: 'EUR', prices: [{ date: '2026-02-01', close: 10 }] }],
        today: '2026-01-05',
        converter: stubConverter(),
      }),
    ).resolves.toEqual([]);
  });

  it('throws when a transaction references an asset with no price/currency input', async () => {
    await expect(
      valueOverTime({
        transactions: [tx({ assetId: 'Z', side: 'buy', quantity: 1, price: 10 })],
        assets: [],
        today: '2026-01-02',
        converter: stubConverter(),
      }),
    ).rejects.toThrow(/no price\/currency input/);
  });
});

// ---------------------------------------------------------------------------
// dailyCloseSeries — the per-asset overlay grid (#122)
// ---------------------------------------------------------------------------

describe('dailyCloseSeries', () => {
  it('expands sparse closes to one point per calendar day, carrying forward over gaps', () => {
    // 2026-01-02/03 is a weekend-style gap; 01-05 resumes trading.
    const series = dailyCloseSeries(
      [
        { date: '2026-01-01', close: 100 },
        { date: '2026-01-05', close: 110 },
      ],
      '2026-01-01',
      '2026-01-06',
    );
    expect(series).toEqual([
      { date: '2026-01-01', close: 100 },
      { date: '2026-01-02', close: 100 }, // carried forward
      { date: '2026-01-03', close: 100 }, // carried forward
      { date: '2026-01-04', close: 100 }, // carried forward
      { date: '2026-01-05', close: 110 },
      { date: '2026-01-06', close: 110 }, // carried forward
    ]);
  });

  it('omits days before the first known close instead of inventing prices', () => {
    const series = dailyCloseSeries(
      [{ date: '2026-01-03', close: 50 }],
      '2026-01-01',
      '2026-01-04',
    );
    expect(series).toEqual([
      { date: '2026-01-03', close: 50 },
      { date: '2026-01-04', close: 50 },
    ]);
  });

  it('sorts unsorted input and lets a later duplicate of a date win', () => {
    const series = dailyCloseSeries(
      [
        { date: '2026-01-02', close: 20 },
        { date: '2026-01-01', close: 10 },
        { date: '2026-01-02', close: 22 }, // later entry wins (provider over stored)
      ],
      '2026-01-01',
      '2026-01-02',
    );
    expect(series).toEqual([
      { date: '2026-01-01', close: 10 },
      { date: '2026-01-02', close: 22 },
    ]);
  });

  it('returns empty for no prices or an inverted window', () => {
    expect(dailyCloseSeries([], '2026-01-01', '2026-01-05')).toEqual([]);
    expect(
      dailyCloseSeries([{ date: '2026-01-01', close: 1 }], '2026-01-05', '2026-01-01'),
    ).toEqual([]);
  });

  it('rejects malformed dates and non-finite closes instead of mis-plotting', () => {
    expect(() =>
      dailyCloseSeries([{ date: '01.02.2026', close: 1 }], '2026-01-01', '2026-01-02'),
    ).toThrow(/ISO YYYY-MM-DD/);
    expect(() =>
      dailyCloseSeries([{ date: '2026-01-01', close: Number.NaN }], '2026-01-01', '2026-01-02'),
    ).toThrow(/finite/);
    expect(() =>
      dailyCloseSeries([{ date: '2026-01-01', close: 1 }], 'nope', '2026-01-02'),
    ).toThrow(/startDay/);
  });
});

// ---------------------------------------------------------------------------
// netFlowsOverTime — daily external cash flows in EUR (#125)
// ---------------------------------------------------------------------------

describe('netFlowsOverTime', () => {
  const CCY = new Map([
    ['A', 'EUR'],
    ['U', 'USD'],
  ]);

  it('signs flows correctly: buys (cost + fee) in, sells (proceeds − fee) out', async () => {
    const flows = await netFlowsOverTime({
      transactions: [
        tx({ side: 'buy', quantity: 10, price: 100, fee: 5, executedAt: '2026-01-01T10:00:00Z' }),
        tx({ side: 'sell', quantity: 4, price: 110, fee: 3, executedAt: '2026-01-03T10:00:00Z' }),
      ],
      currencyByAsset: CCY,
      converter: stubConverter(),
    });
    expect(flows).toEqual([
      { date: '2026-01-01', flowEur: 1005 }, // 10·100 + 5
      { date: '2026-01-03', flowEur: -437 }, // −(4·110 − 3)
    ]);
  });

  it('aggregates same-day transactions into one point and sorts ascending', async () => {
    const flows = await netFlowsOverTime({
      transactions: [
        tx({ side: 'sell', quantity: 1, price: 50, fee: 0, executedAt: '2026-02-01T12:00:00Z' }),
        tx({ side: 'buy', quantity: 2, price: 100, fee: 0, executedAt: '2026-02-01T09:00:00Z' }),
        tx({ side: 'buy', quantity: 1, price: 10, fee: 0, executedAt: '2026-01-15T09:00:00Z' }),
      ],
      currencyByAsset: CCY,
      converter: stubConverter(),
    });
    expect(flows).toEqual([
      { date: '2026-01-15', flowEur: 10 },
      { date: '2026-02-01', flowEur: 150 }, // 200 in − 50 out
    ]);
  });

  it('converts native flows at that day’s historical rate, coalesced per (currency, day)', async () => {
    const converter = datedStubConverter({
      USD: { '2026-01-01': 0.9, '2026-01-02': 0.8 },
    });
    const flows = await netFlowsOverTime({
      transactions: [
        tx({
          assetId: 'U',
          side: 'buy',
          quantity: 10,
          price: 100,
          executedAt: '2026-01-01T10:00:00Z',
        }),
        tx({
          assetId: 'U',
          side: 'buy',
          quantity: 5,
          price: 100,
          executedAt: '2026-01-01T15:00:00Z',
        }),
        tx({
          assetId: 'U',
          side: 'buy',
          quantity: 10,
          price: 100,
          executedAt: '2026-01-02T10:00:00Z',
        }),
      ],
      currencyByAsset: CCY,
      converter,
    });
    expect(flows).toEqual([
      { date: '2026-01-01', flowEur: 1500 * 0.9 },
      { date: '2026-01-02', flowEur: 1000 * 0.8 },
    ]);
    // Same-day USD amounts were summed natively first: one rate call per day.
    expect(converter.toBase).toHaveBeenCalledTimes(2);
  });

  it('fails loud on a transaction whose asset has no currency input', async () => {
    await expect(
      netFlowsOverTime({
        transactions: [tx({ assetId: 'X', side: 'buy', quantity: 1, price: 1 })],
        currencyByAsset: CCY,
        converter: stubConverter(),
      }),
    ).rejects.toThrow(/no currency input/);
  });
});

// ---------------------------------------------------------------------------
// timeWeightedReturn — cash-flow-neutralized performance (#125)
// ---------------------------------------------------------------------------

describe('timeWeightedReturn', () => {
  it('a deposit causes NO jump: buying more at the current price leaves the curve flat', () => {
    // Day 1: invest 1 000. Day 2: price unchanged, top up another 1 000.
    // The absolute curve jumps 1 000 → 2 000; performance must stay at 0 %.
    const values = [
      { date: '2026-01-01', valueEur: 1000 },
      { date: '2026-01-02', valueEur: 2000 },
      { date: '2026-01-03', valueEur: 2200 },
    ];
    const flows = [
      { date: '2026-01-01', flowEur: 1000 },
      { date: '2026-01-02', flowEur: 1000 },
    ];
    const perf = timeWeightedReturn(values, flows);
    expect(perf).toEqual([
      { date: '2026-01-01', pct: 0 },
      { date: '2026-01-02', pct: 0 },
      { date: '2026-01-03', pct: 10.000000000000009 }, // 2200/2000 − 1, full float precision
    ]);
  });

  it('the issue-#125 scenario: investing more after a loss shows the loss, not the deposit', () => {
    // 4 000 invested, market drops 25 % → 3 000. Then 1 000 more is invested:
    // the absolute curve rises 3 000 → 4 000 (reads like a recovery), while the
    // higher-invested point sits at the same EUR level as the start (reads
    // wrong). Performance mode must show −25 % throughout the deposit.
    const values = [
      { date: '2026-01-01', valueEur: 4000 },
      { date: '2026-01-02', valueEur: 3000 },
      { date: '2026-01-03', valueEur: 4000 },
    ];
    const flows = [
      { date: '2026-01-01', flowEur: 4000 },
      { date: '2026-01-03', flowEur: 1000 },
    ];
    expect(timeWeightedReturn(values, flows)).toEqual([
      { date: '2026-01-01', pct: 0 },
      { date: '2026-01-02', pct: -25 },
      { date: '2026-01-03', pct: -25 },
    ]);
  });

  it('chains market moves across a deposit multiplicatively', () => {
    // +10 % on 1 000, deposit 1 100 (value doubles), then +10 % again → 21 %.
    const values = [
      { date: '2026-01-01', valueEur: 1000 },
      { date: '2026-01-02', valueEur: 1100 },
      { date: '2026-01-03', valueEur: 2200 },
      { date: '2026-01-04', valueEur: 2420 },
    ];
    const flows = [
      { date: '2026-01-01', flowEur: 1000 },
      { date: '2026-01-03', flowEur: 1100 },
    ];
    const perf = timeWeightedReturn(values, flows);
    expect(perf[1]?.pct).toBeCloseTo(10, 10);
    expect(perf[2]?.pct).toBeCloseTo(10, 10);
    expect(perf[3]?.pct).toBeCloseTo(21, 10);
  });

  it('books a full liquidation’s final day correctly (outflows count end-of-day)', () => {
    // 4 000 → sold everything for 3 900 (the last −2.5 % happened on the sell
    // day). The naive start-of-day convention would collapse to −100 % here.
    const values = [
      { date: '2026-01-01', valueEur: 4000 },
      { date: '2026-01-02', valueEur: 0 },
      { date: '2026-01-03', valueEur: 0 },
    ];
    const flows = [
      { date: '2026-01-01', flowEur: 4000 },
      { date: '2026-01-02', flowEur: -3900 },
    ];
    expect(timeWeightedReturn(values, flows)).toEqual([
      { date: '2026-01-01', pct: 0 },
      { date: '2026-01-02', pct: -2.5000000000000022 },
      { date: '2026-01-03', pct: -2.5000000000000022 }, // flat while empty
    ]);
  });

  it('captures the first day’s execution→close move (inflows count start-of-day)', () => {
    // Bought at 100/unit intraday, closed at 104: day one is +4 %.
    const values = [{ date: '2026-01-01', valueEur: 1040 }];
    const flows = [{ date: '2026-01-01', flowEur: 1000 }];
    expect(timeWeightedReturn(values, flows)).toEqual([
      { date: '2026-01-01', pct: 4.0000000000000036 },
    ]);
  });

  it('fees drag performance (flows are gross of fee, value is not)', () => {
    // 1 000 invested + 10 fee, value at close exactly 1 000 → −0.99 %.
    const values = [{ date: '2026-01-01', valueEur: 1000 }];
    const flows = [{ date: '2026-01-01', flowEur: 1010 }];
    const perf = timeWeightedReturn(values, flows);
    expect(perf[0]?.pct).toBeCloseTo((1000 / 1010 - 1) * 100, 10);
  });

  it('a zero-value day from missing price data links flat and recovers — never −100 %', () => {
    // Buy day has no known close yet (value 0); the next day data appears.
    const values = [
      { date: '2026-01-01', valueEur: 0 },
      { date: '2026-01-02', valueEur: 1000 },
      { date: '2026-01-03', valueEur: 1100 },
    ];
    const flows = [{ date: '2026-01-01', flowEur: 1000 }];
    const perf = timeWeightedReturn(values, flows);
    expect(perf[0]?.pct).toBe(0);
    expect(perf[1]?.pct).toBe(0); // resumes flat — the gap carries no information
    expect(perf[2]?.pct).toBeCloseTo(10, 10);
  });

  it('ignores flows outside the value window (future-dated transaction)', () => {
    const values = [{ date: '2026-01-01', valueEur: 1000 }];
    const flows = [
      { date: '2026-01-01', flowEur: 1000 },
      { date: '2026-02-01', flowEur: 500 },
    ];
    expect(timeWeightedReturn(values, flows)).toEqual([{ date: '2026-01-01', pct: 0 }]);
  });

  it('sorts unsorted value input and fails loud on malformed points', () => {
    const perf = timeWeightedReturn(
      [
        { date: '2026-01-02', valueEur: 1100 },
        { date: '2026-01-01', valueEur: 1000 },
      ],
      [{ date: '2026-01-01', flowEur: 1000 }],
    );
    expect(perf.map((p) => p.date)).toEqual(['2026-01-01', '2026-01-02']);
    expect(perf[1]?.pct).toBeCloseTo(10, 10);

    expect(() => timeWeightedReturn([{ date: '01.02.2026', valueEur: 1 }], [])).toThrow(
      /ISO YYYY-MM-DD/,
    );
    expect(() => timeWeightedReturn([{ date: '2026-01-01', valueEur: Number.NaN }], [])).toThrow(
      /finite/,
    );
    expect(() =>
      timeWeightedReturn(
        [{ date: '2026-01-01', valueEur: 1 }],
        [{ date: '2026-01-01', flowEur: Number.POSITIVE_INFINITY }],
      ),
    ).toThrow(/finite/);
  });
});

// ---------------------------------------------------------------------------
// rebasePerformance — window slices restart at 0 % (#125)
// ---------------------------------------------------------------------------

describe('rebasePerformance', () => {
  it('re-bases by compounding, not subtraction', () => {
    // Sliced window starts at +25 %; a later −10 % day sits at 1.25·0.9 − 1.
    const rebased = rebasePerformance([
      { date: '2026-03-01', pct: 25 },
      { date: '2026-03-02', pct: 12.5 },
    ]);
    expect(rebased[0]).toEqual({ date: '2026-03-01', pct: 0 });
    expect(rebased[1]?.pct).toBeCloseTo((1.125 / 1.25 - 1) * 100, 10); // −10 %
  });

  it('handles the empty slice and rejects a corrupt (≤ −100 %) base', () => {
    expect(rebasePerformance([])).toEqual([]);
    expect(() => rebasePerformance([{ date: '2026-01-01', pct: -100 }])).toThrow(
      /non-positive base/,
    );
  });
});
