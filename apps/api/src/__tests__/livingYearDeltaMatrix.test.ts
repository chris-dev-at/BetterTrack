import { describe, expect, it } from 'vitest';

import { AT_AS_CUSTOM_PARAMS, TAX_COUNTRY_AT, TAX_COUNTRY_DE, TAX_COUNTRY_FI } from '../domain/tax';
import { settleLiveYears, type LiveRegime, type LiveYearRowView } from '../services/tax/livingYear';
import {
  categoryOfBuilder,
  realizationsBuilder,
  txRecord,
  yearOf,
} from '../services/tax/__tests__/records';

const YEAR = 2024;

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
  ];
}

function target(regime: Exclude<LiveRegime, { kind: 'manual' }>, withBackdatedBuy: boolean) {
  const transactions = rows(withBackdatedBuy);
  const view: LiveYearRowView = {
    transactions,
    dividendRows: [],
    realizationsFor: realizationsBuilder(transactions),
    categoryOf: categoryOfBuilder({ stock: 'stock' }),
    yearOf,
  };
  const [settlement] = settleLiveYears({
    regime,
    view,
    years: [YEAR],
    heldOf: () => 0,
  });
  return settlement!.targetAfterEur;
}

describe('#1399 living-year delta matrix', () => {
  it.each<{
    name: string;
    regime: Exclude<LiveRegime, { kind: 'manual' }>;
    before: number;
    after: number;
  }>([
    {
      name: 'AT moving average',
      regime: { kind: 'country', country: TAX_COUNTRY_AT },
      before: 550,
      after: 137.5,
    },
    {
      name: 'DE FIFO',
      regime: { kind: 'country', country: TAX_COUNTRY_DE },
      before: 263.75,
      after: 0,
    },
    {
      name: 'FI FIFO',
      regime: { kind: 'country', country: TAX_COUNTRY_FI },
      before: 600,
      after: 0,
    },
    {
      name: 'custom moving average',
      regime: { kind: 'custom', params: AT_AS_CUSTOM_PARAMS },
      before: 550,
      after: 137.5,
    },
  ])('recomputes a past $name year after a backdated insert', ({ regime, before, after }) => {
    expect(target(regime, false)).toBe(before);
    expect(target(regime, true)).toBe(after);
  });
});
