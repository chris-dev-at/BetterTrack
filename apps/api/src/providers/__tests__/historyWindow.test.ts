import { describe, expect, it } from 'vitest';

import { rangeStartMs } from '../historyWindow';

const END_MS = 1_725_148_800_000;
const DAY_MS = 24 * 60 * 60 * 1000;

describe('rangeStartMs (§5.3)', () => {
  it.each([
    ['1D', 1],
    ['1W', 7],
    ['1M', 31],
    ['3M', 93],
    ['6M', 186],
    ['1Y', 366],
    ['5Y', 1830],
  ] as const)('subtracts the documented %s lookback', (range, lookbackDays) => {
    expect(rangeStartMs(END_MS, range)).toBe(END_MS - lookbackDays * DAY_MS);
  });

  it('returns the Unix epoch for MAX regardless of the supplied end timestamp', () => {
    expect(rangeStartMs(END_MS, 'MAX')).toBe(0);
    expect(rangeStartMs(-1, 'MAX')).toBe(0);
  });
});
