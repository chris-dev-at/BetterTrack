import { describe, expect, it, vi } from 'vitest';

import {
  deriveHoldings,
  OversellError,
  QTY_EPSILON,
  reducePosition,
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

// ---------------------------------------------------------------------------
// reducePosition — average cost & realized P/L (§6.9)
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
// deriveHoldings — the holdings view (§6.9)
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
// valueOverTime — daily portfolio value series (§6.9)
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
