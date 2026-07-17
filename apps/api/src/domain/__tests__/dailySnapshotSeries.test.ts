import { describe, expect, it } from 'vitest';

import {
  cashBySourceOverTime,
  netWorthSeries,
  CashLedgerError,
  type SourcedCashMovement,
} from '../cashLedger';
import {
  costBasisOverTime,
  type CurrencyConverter,
  type Transaction,
  type ValueOverTimeAsset,
} from '../holdings';

/**
 * Unit tests for the two pure series the V5-P1 daily snapshot writer persists
 * (issue #553): the daily open-cost-basis curve (`costBasisOverTime`) and the
 * dense per-source EOD cash split (`cashBySourceOverTime`).
 */

const identity: CurrencyConverter = {
  toBase: async (amount) => amount,
};

/** Converter with per-(currency, date) rates; unknown pairs fail loud. */
function fxConverter(rates: Record<string, number>): CurrencyConverter {
  return {
    async toBase(amount, currency, opts) {
      if (currency === 'EUR') return amount;
      const rate = rates[`${currency}|${opts?.date ?? 'spot'}`];
      if (rate === undefined) throw new Error(`no rate for ${currency} on ${opts?.date}`);
      return amount * rate;
    },
  };
}

function txn(overrides: Partial<Transaction> & { executedAt: string }): Transaction {
  return {
    assetId: 'a1',
    side: 'buy',
    quantity: 1,
    price: 100,
    fee: 0,
    ...overrides,
  };
}

function asset(
  assetId: string,
  currency: string,
  priceDates: readonly string[],
): ValueOverTimeAsset {
  return { assetId, currency, prices: priceDates.map((date) => ({ date, close: 1 })) };
}

function movement(
  overrides: Partial<SourcedCashMovement> & { occurredAt: string },
): SourcedCashMovement {
  return { kind: 'deposit', amountEur: 100, sourceId: 's1', ...overrides };
}

const at = (day: string): string => `${day}T10:00:00.000Z`;

describe('costBasisOverTime', () => {
  it('returns an empty series without transactions or when the first is after today', async () => {
    expect(
      await costBasisOverTime({
        transactions: [],
        assets: [],
        today: '2026-01-05',
        converter: identity,
      }),
    ).toEqual([]);
    expect(
      await costBasisOverTime({
        transactions: [txn({ executedAt: at('2026-01-10') })],
        assets: [asset('a1', 'EUR', ['2026-01-10'])],
        today: '2026-01-05',
        converter: identity,
      }),
    ).toEqual([]);
  });

  it('capitalises the fee into the basis and carries it forward daily', async () => {
    const series = await costBasisOverTime({
      transactions: [txn({ quantity: 2, price: 100, fee: 10, executedAt: at('2026-01-01') })],
      assets: [asset('a1', 'EUR', ['2026-01-01'])],
      today: '2026-01-03',
      converter: identity,
    });
    // avg = (2·100 + 10) / 2 = 105 → basis 2 · 105 = 210 on every day.
    expect(series).toEqual([
      { date: '2026-01-01', costBasisEur: 210 },
      { date: '2026-01-02', costBasisEur: 210 },
      { date: '2026-01-03', costBasisEur: 210 },
    ]);
  });

  it('gates each asset on its first known price, mirroring the value series', async () => {
    const series = await costBasisOverTime({
      transactions: [txn({ quantity: 1, price: 100, executedAt: at('2026-01-01') })],
      assets: [asset('a1', 'EUR', ['2026-01-03'])],
      today: '2026-01-04',
      converter: identity,
    });
    // No close before the 3rd → the value series carries 0 there, so the cost
    // series must too (a cost against zero value would fake a total loss).
    expect(series).toEqual([
      { date: '2026-01-01', costBasisEur: 0 },
      { date: '2026-01-02', costBasisEur: 0 },
      { date: '2026-01-03', costBasisEur: 100 },
      { date: '2026-01-04', costBasisEur: 100 },
    ]);
  });

  it('keeps the average on a partial sell and zeroes the basis on a full close', async () => {
    const series = await costBasisOverTime({
      transactions: [
        txn({ quantity: 4, price: 100, executedAt: at('2026-01-01') }),
        txn({ side: 'sell', quantity: 2, price: 150, executedAt: at('2026-01-02') }),
        txn({ side: 'sell', quantity: 2, price: 150, executedAt: at('2026-01-03') }),
      ],
      assets: [asset('a1', 'EUR', ['2026-01-01'])],
      today: '2026-01-04',
      converter: identity,
    });
    expect(series).toEqual([
      { date: '2026-01-01', costBasisEur: 400 },
      { date: '2026-01-02', costBasisEur: 200 }, // 2 remaining · avg 100
      { date: '2026-01-03', costBasisEur: 0 },
      { date: '2026-01-04', costBasisEur: 0 },
    ]);
  });

  it('re-averages a re-entry from scratch and books same-day interleaving at EOD', async () => {
    const series = await costBasisOverTime({
      transactions: [
        txn({ quantity: 2, price: 100, executedAt: `2026-01-01T09:00:00.000Z` }),
        txn({ side: 'sell', quantity: 2, price: 120, executedAt: `2026-01-01T12:00:00.000Z` }),
        txn({ quantity: 1, price: 300, executedAt: `2026-01-01T15:00:00.000Z` }),
      ],
      assets: [asset('a1', 'EUR', ['2026-01-01'])],
      today: '2026-01-02',
      converter: identity,
    });
    // The day's EOD state: position closed at 12:00 (avg reset), rebuilt at
    // 15:00 → basis 1 · 300, not a blend with the morning's 100 average.
    expect(series).toEqual([
      { date: '2026-01-01', costBasisEur: 300 },
      { date: '2026-01-02', costBasisEur: 300 },
    ]);
  });

  it('closes an acknowledged uncovered sell at exactly zero basis', async () => {
    const series = await costBasisOverTime({
      transactions: [
        txn({ quantity: 1, price: 100, executedAt: at('2026-01-01') }),
        txn({
          side: 'sell',
          quantity: 5,
          price: 100,
          executedAt: at('2026-01-02'),
          allowUncovered: true,
        }),
      ],
      assets: [asset('a1', 'EUR', ['2026-01-01'])],
      today: '2026-01-03',
      converter: identity,
    });
    expect(series.map((p) => p.costBasisEur)).toEqual([100, 0, 0]);
  });

  it('converts each day at that day’s historical FX rate and sums across assets', async () => {
    const converter = fxConverter({
      'USD|2026-01-01': 0.5,
      'USD|2026-01-02': 0.8,
    });
    const series = await costBasisOverTime({
      transactions: [
        txn({ assetId: 'eur', quantity: 1, price: 100, executedAt: at('2026-01-01') }),
        txn({ assetId: 'usd', quantity: 2, price: 100, executedAt: at('2026-01-01') }),
      ],
      assets: [asset('eur', 'EUR', ['2026-01-01']), asset('usd', 'USD', ['2026-01-01'])],
      today: '2026-01-02',
      converter,
    });
    expect(series).toEqual([
      { date: '2026-01-01', costBasisEur: 100 + 200 * 0.5 },
      { date: '2026-01-02', costBasisEur: 100 + 200 * 0.8 },
    ]);
  });

  it('fails loud on a transaction with no asset input', async () => {
    await expect(
      costBasisOverTime({
        transactions: [txn({ executedAt: at('2026-01-01') })],
        assets: [],
        today: '2026-01-02',
        converter: identity,
      }),
    ).rejects.toThrow(/no price\/currency input/);
  });
});

describe('cashBySourceOverTime', () => {
  it('returns an empty series without movements on or before endDay', () => {
    expect(cashBySourceOverTime([], '2026-01-05')).toEqual([]);
    expect(
      cashBySourceOverTime([movement({ occurredAt: at('2026-02-01') })], '2026-01-05'),
    ).toEqual([]);
  });

  it('carries each source’s EOD balance forward daily', () => {
    const series = cashBySourceOverTime(
      [
        movement({ occurredAt: at('2026-01-01'), amountEur: 100, sourceId: 'main' }),
        movement({ occurredAt: at('2026-01-03'), amountEur: 50, sourceId: 'bank' }),
      ],
      '2026-01-04',
    );
    expect(series.map((p) => p.date)).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
    ]);
    expect([...series[0]!.balances]).toEqual([['main', 100]]);
    expect([...series[1]!.balances]).toEqual([['main', 100]]);
    expect(series[2]!.balances.get('bank')).toBe(50);
    expect(series[3]!.balances.get('main')).toBe(100);
    expect(series[3]!.balances.get('bank')).toBe(50);
  });

  it('nets same-day movements to one EOD figure and moves a transfer between sources', () => {
    const series = cashBySourceOverTime(
      [
        movement({ occurredAt: `2026-01-01T09:00:00.000Z`, amountEur: 100, sourceId: 'main' }),
        movement({
          kind: 'transfer_out',
          occurredAt: `2026-01-01T12:00:00.000Z`,
          amountEur: -40,
          sourceId: 'main',
        }),
        movement({
          kind: 'transfer_in',
          occurredAt: `2026-01-01T12:00:00.000Z`,
          amountEur: 40,
          sourceId: 'bank',
        }),
      ],
      '2026-01-01',
    );
    expect(series).toHaveLength(1);
    expect(series[0]!.balances.get('main')).toBe(60);
    expect(series[0]!.balances.get('bank')).toBe(40);
  });

  it('sums per day to exactly the net-worth curve’s cash leg', () => {
    const movements = [
      movement({ occurredAt: at('2026-01-01'), amountEur: 123.45, sourceId: 'main' }),
      movement({
        kind: 'withdrawal',
        occurredAt: at('2026-01-02'),
        amountEur: -23.45,
        sourceId: 'main',
      }),
      movement({ occurredAt: at('2026-01-02'), amountEur: 10, sourceId: 'bank' }),
    ];
    const split = cashBySourceOverTime(movements, '2026-01-03');
    const netWorth = netWorthSeries({ holdingsValues: [], movements, today: '2026-01-03' });
    expect(split.map((p) => p.date)).toEqual(netWorth.map((p) => p.date));
    for (let i = 0; i < split.length; i += 1) {
      const total = [...split[i]!.balances.values()].reduce((a, b) => a + b, 0);
      expect(total).toBe(netWorth[i]!.valueEur);
    }
  });

  it('fails loud on malformed input', () => {
    expect(() => cashBySourceOverTime([], 'nope')).toThrow(CashLedgerError);
    expect(() =>
      cashBySourceOverTime(
        [movement({ occurredAt: at('2026-01-01'), amountEur: -5 })], // deposit must be > 0
        '2026-01-02',
      ),
    ).toThrow(CashLedgerError);
  });
});
