import { describe, expect, it } from 'vitest';

import { clientSeriesCagrPct, trimZeroValueEdges } from './clientSeries';

/** Two years of steady growth after a leading stretch the portfolio held nothing. */
const WITH_ZERO_EDGES = [
  { date: '2023-12-30', valueEur: 0 },
  { date: '2023-12-31', valueEur: 0 },
  { date: '2024-01-01', valueEur: 100 },
  { date: '2025-01-01', valueEur: 121 },
  { date: '2026-01-01', valueEur: 0 },
];

describe('trimZeroValueEdges', () => {
  it('drops leading and trailing non-positive points and keeps the middle intact', () => {
    expect(trimZeroValueEdges(WITH_ZERO_EDGES)).toEqual([
      { date: '2024-01-01', valueEur: 100 },
      { date: '2025-01-01', valueEur: 121 },
    ]);
  });

  it('keeps an interior zero — a portfolio really can be emptied and refilled', () => {
    const points = [
      { date: '2024-01-01', valueEur: 100 },
      { date: '2024-06-01', valueEur: 0 },
      { date: '2025-01-01', valueEur: 50 },
    ];
    expect(trimZeroValueEdges(points)).toEqual(points);
  });

  it('collapses a series that never held value to nothing', () => {
    expect(trimZeroValueEdges([{ date: '2024-01-01', valueEur: 0 }])).toEqual([]);
  });
});

describe('clientSeriesCagrPct', () => {
  it('states the annualised return from the first day the portfolio held value', () => {
    // 100 → 121 over 366 elapsed days (2024 is a leap year), so just under the
    // 21 % a whole-year window would state. Without the trim the window starts
    // at 0 and no CAGR can be stated at all.
    expect(clientSeriesCagrPct(WITH_ZERO_EDGES)).toBeCloseTo(20.95, 2);
  });

  it('is null when the trimmed window cannot carry a rate', () => {
    expect(clientSeriesCagrPct([])).toBeNull();
    expect(clientSeriesCagrPct([{ date: '2024-01-01', valueEur: 0 }])).toBeNull();
    expect(clientSeriesCagrPct([{ date: '2024-01-01', valueEur: 100 }])).toBeNull();
  });
});
