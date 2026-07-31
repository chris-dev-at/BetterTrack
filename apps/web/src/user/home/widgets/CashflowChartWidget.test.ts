import { describe, expect, test } from 'vitest';

import type { CashTrendPoint } from '@bettertrack/contracts';

import { combineCashTrends } from './CashflowChartWidget';

/**
 * The combined cash-flow curve's arithmetic, in isolation — the FLOW
 * counterpart to `NetWorthHistoryWidget.test.ts`'s balance-series tests. The
 * one rule that must never regress: a portfolio missing a month contributes
 * ZERO for it — never its neighbour's figure, and never forward-filled, since
 * these are per-month flows, not a running balance.
 */

function points(entries: readonly [string, number, number][]): CashTrendPoint[] {
  return entries.map(([month, inflow, outflow]) => ({ month, inflow, outflow }));
}

describe('combineCashTrends', () => {
  test('sums two portfolios on the union of their months', () => {
    const main = points([
      ['2026-06', 4_000, 3_600],
      ['2026-07', 4_200, 1_000],
    ]);
    const savings = points([['2026-07', 500, 0]]);

    expect(combineCashTrends([main, savings])).toEqual([
      { month: '2026-06', inflow: 4_000, outflow: 3_600 },
      { month: '2026-07', inflow: 4_700, outflow: 1_000 },
    ]);
  });

  test('a portfolio missing a month contributes 0, never a carried-forward figure', () => {
    const main = points([
      ['2026-05', 1_000, 200],
      ['2026-07', 900, 100],
    ]);
    const openedLater = points([['2026-07', 300, 0]]);

    // Main has no June point at all — June must not inherit May's 1 000/200,
    // the way a BALANCE series would forward-fill it.
    expect(combineCashTrends([main, openedLater])).toEqual([
      { month: '2026-05', inflow: 1_000, outflow: 200 },
      { month: '2026-07', inflow: 1_200, outflow: 100 },
    ]);
  });

  test('sorts months ascending regardless of input order', () => {
    const set = points([
      ['2026-07', 1, 1],
      ['2026-05', 2, 2],
      ['2026-06', 3, 3],
    ]);
    expect(combineCashTrends([set]).map((p) => p.month)).toEqual(['2026-05', '2026-06', '2026-07']);
  });

  test('one portfolio alone is just its own series', () => {
    const only = points([['2026-07', 10, 5]]);
    expect(combineCashTrends([only])).toEqual(only);
  });

  test.each([
    ['no portfolios', [] as const],
    ['portfolios with no points', [[], []] as const],
  ])('%s ⇒ an empty series, never a fabricated point', (_label, sets) => {
    expect(combineCashTrends(sets as never)).toEqual([]);
  });
});
