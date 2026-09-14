import { describe, expect, it } from 'vitest';

import { clientSeriesTwrCagrPct, trimZeroValueEdges } from './clientSeries';

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

describe('clientSeriesTwrCagrPct', () => {
  it('annualises the vault’s own time-weighted curve over the window it is given', () => {
    // +21 % across 366 elapsed days (2024 is a leap year) — just under the 21 %
    // a whole-year window would state.
    expect(
      clientSeriesTwrCagrPct([
        { date: '2024-01-01', pct: 0 },
        { date: '2025-01-01', pct: 21 },
      ]),
    ).toBeCloseTo(20.95, 2);
  });

  it('rebases a since-inception curve onto the sliced window', () => {
    // The 3Y control trims a 5Y envelope locally, so the slice it hands over
    // starts mid-curve: +10 % of its own, not the +120 % the curve carries.
    expect(
      clientSeriesTwrCagrPct([
        { date: '2024-01-01', pct: 100 },
        { date: '2025-01-01', pct: 120 },
      ]),
    ).toBeCloseTo(9.98, 2);
  });

  it('is null when the window cannot carry a rate', () => {
    expect(clientSeriesTwrCagrPct([])).toBeNull();
    // A real window with no elapsed time states a total, but no annual rate.
    expect(clientSeriesTwrCagrPct([{ date: '2024-01-01', pct: 0 }])).toBeNull();
  });
});
