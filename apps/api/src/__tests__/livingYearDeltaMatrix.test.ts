import { describe, expect, it } from 'vitest';

import { AT_AS_CUSTOM_PARAMS, TAX_COUNTRY_AT, TAX_COUNTRY_DE, TAX_COUNTRY_FI } from '../domain/tax';
import { settleLiveYears, type LiveRegime, type LiveYearRowView } from '../services/tax/livingYear';
import {
  categoryOfBuilder,
  realizationsBuilder,
  txRecord,
  yearOf,
} from '../services/tax/__tests__/records';

/**
 * A backdated insert does not stop at its own year: the moving-average basis
 * and the FIFO lot queue (with DE's loss pots) both propagate forward, so every
 * LATER living year re-settles too. Settling more than one year here is what
 * makes a cross-year regression fail this matrix (#1591).
 */
const YEARS = [2024, 2025];

function rows(withBackdatedBuy: boolean) {
  return [
    ...(withBackdatedBuy
      ? [
          txRecord({
            id: 'backdated-buy',
            side: 'buy',
            assetId: 'stock',
            quantity: 10,
            price: 700,
            executedAt: new Date('2024-01-10T10:00:00.000Z'),
          }),
        ]
      : []),
    txRecord({
      id: 'original-buy',
      side: 'buy',
      assetId: 'stock',
      quantity: 10,
      price: 100,
      executedAt: new Date('2024-06-10T10:00:00.000Z'),
    }),
    txRecord({
      id: 'sell',
      side: 'sell',
      assetId: 'stock',
      quantity: 5,
      price: 500,
      executedAt: new Date('2024-10-10T10:00:00.000Z'),
    }),
    txRecord({
      id: 'later-sell',
      side: 'sell',
      assetId: 'stock',
      quantity: 5,
      price: 500,
      executedAt: new Date('2025-10-10T10:00:00.000Z'),
    }),
  ];
}

/**
 * The DE-specific channel the shared fixture above cannot isolate: 2024 is a
 * LOSS year both before and after the backdated buy (target 0 either way), so
 * the only thing that reaches 2025 is the carried aktien pot. 2025's own gain
 * is €2 000 in both cases — if the pot carry-in regressed, 2025's target would
 * not move (#1591 review).
 */
function dePotCarryRows(withBackdatedBuy: boolean) {
  return [
    ...(withBackdatedBuy
      ? [
          txRecord({
            id: 'backdated-cheap-lot',
            side: 'buy',
            assetId: 'stock',
            quantity: 10,
            price: 40,
            executedAt: new Date('2024-01-05T10:00:00.000Z'),
          }),
        ]
      : []),
    txRecord({
      id: 'lot-2024',
      side: 'buy',
      assetId: 'stock',
      quantity: 10,
      price: 100,
      executedAt: new Date('2024-01-10T10:00:00.000Z'),
    }),
    txRecord({
      id: 'loss-sell-2024',
      side: 'sell',
      assetId: 'stock',
      quantity: 10,
      price: 20,
      executedAt: new Date('2024-06-10T10:00:00.000Z'),
    }),
    txRecord({
      id: 'lot-2025',
      side: 'buy',
      assetId: 'stock',
      quantity: 10,
      price: 100,
      executedAt: new Date('2025-01-10T10:00:00.000Z'),
    }),
    txRecord({
      id: 'gain-sell-2025',
      side: 'sell',
      assetId: 'stock',
      quantity: 10,
      price: 300,
      executedAt: new Date('2025-06-10T10:00:00.000Z'),
    }),
  ];
}

/** Every settled year's engine target, keyed by year. */
function targetsOf(
  regime: Exclude<LiveRegime, { kind: 'manual' }>,
  transactions: readonly ReturnType<typeof txRecord>[],
) {
  const view: LiveYearRowView = {
    transactions,
    dividendRows: [],
    realizationsFor: realizationsBuilder(transactions),
    categoryOf: categoryOfBuilder({ stock: 'stock' }),
    yearOf,
  };
  const settlements = settleLiveYears({
    regime,
    view,
    years: YEARS,
    heldOf: () => 0,
  });
  return Object.fromEntries(settlements.map((s) => [s.year, s.targetAfterEur]));
}

describe('#1399 living-year delta matrix', () => {
  it.each<{
    name: string;
    regime: Exclude<LiveRegime, { kind: 'manual' }>;
    before: Record<number, number>;
    after: Record<number, number>;
  }>([
    {
      name: 'AT moving average',
      regime: { kind: 'country', country: TAX_COUNTRY_AT },
      before: { 2024: 550, 2025: 550 },
      after: { 2024: 137.5, 2025: 137.5 },
    },
    {
      name: 'DE FIFO',
      regime: { kind: 'country', country: TAX_COUNTRY_DE },
      before: { 2024: 263.75, 2025: 263.75 },
      after: { 2024: 0, 2025: 0 },
    },
    {
      name: 'FI FIFO',
      regime: { kind: 'country', country: TAX_COUNTRY_FI },
      before: { 2024: 600, 2025: 600 },
      after: { 2024: 0, 2025: 0 },
    },
    {
      name: 'custom moving average',
      regime: { kind: 'custom', params: AT_AS_CUSTOM_PARAMS },
      before: { 2024: 550, 2025: 550 },
      after: { 2024: 137.5, 2025: 137.5 },
    },
  ])(
    'recomputes every living $name year after a backdated insert, not just its own',
    ({ regime, before, after }) => {
      expect(targetsOf(regime, rows(false))).toEqual(before);
      expect(targetsOf(regime, rows(true))).toEqual(after);
    },
  );

  it('carries the DE loss pot into the next year, and a backdated buy re-cuts it', () => {
    const de: LiveRegime = { kind: 'country', country: TAX_COUNTRY_DE };
    // 2024 realizes −800 ⇒ aktien pot 800; 2025's €2 000 gain nets to 1 200,
    // the €1 000 allowance leaves 200 ⇒ 25 % = 50 KapESt + 5.5 % soli.
    expect(targetsOf(de, dePotCarryRows(false))).toEqual({ 2024: 0, 2025: 52.75 });
    // The cheaper backdated lot cuts 2024's loss to −200 ⇒ pot 200. 2025's own
    // gain is unchanged at €2 000, so ONLY the carry moves: 800 taxable ⇒ 200
    // KapESt + 11 soli. 2024 stays at 0 both times — a pure carry regression.
    expect(targetsOf(de, dePotCarryRows(true))).toEqual({ 2024: 0, 2025: 211 });
  });
});
