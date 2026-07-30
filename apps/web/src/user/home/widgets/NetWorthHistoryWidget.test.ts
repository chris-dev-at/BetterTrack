import { describe, expect, test } from 'vitest';

import type { PortfolioHistoryPoint } from '@bettertrack/contracts';

import { combineSamples, normalizeSamples } from './NetWorthHistoryWidget';

/**
 * The all-portfolios curve's arithmetic, in isolation.
 *
 * This is the only real logic in the expanded widget catalog, and it is the kind
 * that fails *plausibly*: a wrong fill rule still draws a smooth line, so a bug
 * here shows up as a net-worth history that is quietly false rather than as a
 * blank widget. Hence direct tests of the three rules the widget promises —
 * epoch-second normalization, the sorted union of stamps, and forward-fill with
 * a zero contribution before a portfolio's first point.
 */

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function daily(entries: readonly [string, number][]): PortfolioHistoryPoint[] {
  return entries.map(([date, valueEur]) => ({ date, valueEur }));
}

describe('normalizeSamples', () => {
  test('keys daily points on their UTC midnight in epoch seconds', () => {
    expect(normalizeSamples(daily([['2026-07-01', 100]]))).toEqual([
      { seconds: at('2026-07-01'), value: 100 },
    ]);
  });

  test('prefers an intraday point’s exact instant over its calendar day (#556)', () => {
    // Two points share a `date`; only `time` can tell them apart, so `time` wins.
    const points: PortfolioHistoryPoint[] = [
      { date: '2026-07-01', time: '2026-07-01T09:30:00.000Z', valueEur: 100 },
      { date: '2026-07-01', time: '2026-07-01T17:00:00.000Z', valueEur: 110 },
    ];
    expect(normalizeSamples(points)).toEqual([
      { seconds: at('2026-07-01T09:30:00.000Z'), value: 100 },
      { seconds: at('2026-07-01T17:00:00.000Z'), value: 110 },
    ]);
  });

  test('sorts ascending even if the payload arrived out of order', () => {
    const sorted = normalizeSamples(
      daily([
        ['2026-07-03', 3],
        ['2026-07-01', 1],
        ['2026-07-02', 2],
      ]),
    );
    expect(sorted.map((sample) => sample.value)).toEqual([1, 2, 3]);
  });

  test('skips an unparseable stamp instead of emitting a NaN key', () => {
    // A NaN stamp would poison the union and sort unpredictably.
    const points = [{ date: 'not-a-date', valueEur: 5 }] as unknown as PortfolioHistoryPoint[];
    expect(normalizeSamples(points)).toEqual([]);
  });
});

describe('combineSamples', () => {
  test('sums two portfolios on the union of their stamps, forward-filling', () => {
    const main = normalizeSamples(
      daily([
        ['2026-07-01', 100],
        ['2026-07-03', 120],
      ]),
    );
    const savings = normalizeSamples(daily([['2026-07-02', 50]]));

    expect(combineSamples([main, savings])).toEqual([
      // Savings does not exist yet ⇒ contributes 0, not its future 50.
      { time: at('2026-07-01'), value: 100 },
      // Main has no point today ⇒ carries 100 forward; savings opens at 50.
      { time: at('2026-07-02'), value: 150 },
      // Main moves to 120; savings carries its 50 forward.
      { time: at('2026-07-03'), value: 170 },
    ]);
  });

  test('a portfolio opened mid-window lifts the total on its first day only', () => {
    const old = normalizeSamples(
      daily([
        ['2026-07-01', 1_000],
        ['2026-07-02', 1_000],
      ]),
    );
    const fresh = normalizeSamples(daily([['2026-07-02', 400]]));

    expect(combineSamples([old, fresh]).map((point) => point.value)).toEqual([1_000, 1_400]);
  });

  test('several points sharing one stamp collapse to the last of them', () => {
    const one = normalizeSamples([
      { date: '2026-07-01', time: '2026-07-01T10:00:00.000Z', valueEur: 10 },
      { date: '2026-07-01', time: '2026-07-01T10:00:00.000Z', valueEur: 20 },
    ]);
    expect(combineSamples([one])).toEqual([{ time: at('2026-07-01T10:00:00.000Z'), value: 20 }]);
  });

  test('interleaves intraday and daily grids without losing a stamp', () => {
    const intraday = normalizeSamples([
      { date: '2026-07-01', time: '2026-07-01T12:00:00.000Z', valueEur: 60 },
    ]);
    const dailyOnly = normalizeSamples(daily([['2026-07-01', 40]]));

    // Midnight comes first, then noon — the daily point is carried into it.
    expect(combineSamples([intraday, dailyOnly])).toEqual([
      { time: at('2026-07-01'), value: 40 },
      { time: at('2026-07-01T12:00:00.000Z'), value: 100 },
    ]);
  });

  test('one portfolio alone is just its own curve', () => {
    const only = normalizeSamples(
      daily([
        ['2026-07-01', 7],
        ['2026-07-02', 9],
      ]),
    );
    expect(combineSamples([only]).map((point) => point.value)).toEqual([7, 9]);
  });

  test.each([
    ['no portfolios', [] as const],
    ['portfolios with no points', [[], []] as const],
  ])('%s ⇒ an empty series, never a fabricated point', (_label, sets) => {
    expect(combineSamples(sets as never)).toEqual([]);
  });
});
