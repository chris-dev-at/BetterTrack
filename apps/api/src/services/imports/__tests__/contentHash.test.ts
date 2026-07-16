import { describe, expect, it } from 'vitest';

import { canonicalAmount, contentHash } from '../contentHash';

/**
 * The §13.4 dedupe key, unit-pinned where collisions would cost money: opposite
 * trade sides and opposite cash directions must never collapse, and decimals
 * must hash identically before and after their `numeric`-column round-trip.
 */

const at = new Date('2024-01-15T12:00:00Z');

describe('contentHash', () => {
  it('keeps buy and sell distinct at equal day/instrument/qty/price (flat round-trip)', () => {
    const base = {
      executedAt: at,
      instrument: 'asset-1',
      quantity: 10,
      price: 50,
      amountEur: null,
    };
    expect(contentHash({ ...base, kind: 'buy' })).not.toBe(contentHash({ ...base, kind: 'sell' }));
  });

  it('keeps deposit and withdrawal distinct at equal day/amount', () => {
    const base = { executedAt: at, instrument: null, quantity: null, price: null, amountEur: 250 };
    expect(contentHash({ ...base, kind: 'deposit' })).not.toBe(
      contentHash({ ...base, kind: 'withdrawal' }),
    );
  });

  it('hashes a full-precision file value identically to its numeric-column round-trip', () => {
    // quantity is numeric(20,8), price numeric(20,6): the DB rounds on insert,
    // so the hash must round the same way or re-importing the file that created
    // an entity would no longer dedupe against it.
    const fromFile = contentHash({
      kind: 'buy',
      executedAt: at,
      instrument: 'asset-1',
      quantity: 1.234567894,
      price: 50.0000004,
      amountEur: null,
    });
    const fromDb = contentHash({
      kind: 'buy',
      executedAt: at,
      instrument: 'asset-1',
      quantity: 1.23456789,
      price: 50,
      amountEur: null,
    });
    expect(fromFile).toBe(fromDb);
  });

  it('canonicalizes decimal renderings', () => {
    expect(canonicalAmount(5, 6)).toBe('5');
    expect(canonicalAmount(5.0, 6)).toBe('5');
    expect(canonicalAmount(Number('5.000000'), 6)).toBe('5');
    expect(canonicalAmount(1.5, 6)).toBe('1.5');
    expect(canonicalAmount(1.23456789, 8)).toBe('1.23456789');
    expect(canonicalAmount(-0.0000001, 6)).toBe('0');
    expect(canonicalAmount(null, 6)).toBe('');
  });

  describe('cent-floored dividend/cash amounts (live entities persist floorCents at 2 dp)', () => {
    it('a >2-decimal file amount hashes identically to its cent-floored persisted form', () => {
      const dividend = {
        kind: 'dividend' as const,
        executedAt: at,
        instrument: 'asset-1',
        quantity: null,
        price: null,
      };
      expect(contentHash({ ...dividend, amountEur: 3.755 })).toBe(
        contentHash({ ...dividend, amountEur: 3.75 }),
      );
      const deposit = {
        kind: 'deposit' as const,
        executedAt: at,
        instrument: null,
        quantity: null,
        price: null,
      };
      expect(contentHash({ ...deposit, amountEur: 100.006 })).toBe(
        contentHash({ ...deposit, amountEur: 100 }),
      );
      // Floor, not round: 3.759 keys on 3.75, never 3.76.
      expect(contentHash({ ...dividend, amountEur: 3.759 })).toBe(
        contentHash({ ...dividend, amountEur: 3.75 }),
      );
      expect(contentHash({ ...dividend, amountEur: 3.759 })).not.toBe(
        contentHash({ ...dividend, amountEur: 3.76 }),
      );
      // Exact cents survive FP representation (floorCents epsilon nudge).
      expect(contentHash({ ...deposit, amountEur: 8.61 })).toBe(
        contentHash({ ...deposit, amountEur: 8.61 }),
      );
    });

    it('trade price slots keep the 6-dp column scale (unchanged by the cent floor)', () => {
      const trade = {
        kind: 'buy' as const,
        executedAt: at,
        instrument: 'asset-1',
        quantity: 2,
        amountEur: null,
      };
      expect(contentHash({ ...trade, price: 3.755 })).not.toBe(
        contentHash({ ...trade, price: 3.75 }),
      );
    });
  });
});
