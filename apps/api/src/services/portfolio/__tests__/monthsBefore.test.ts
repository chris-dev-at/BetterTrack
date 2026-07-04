import { describe, expect, it } from 'vitest';

import { monthsBefore } from '../portfolioService';

// Issue #218: a naive setUTCMonth rolls over when the target month is shorter
// (Mar 31 − 1M → Feb 31 → Mar 3), silently shortening the 1M/6M chart windows.
// The cutoff must clamp to the target month's last day.
describe('monthsBefore', () => {
  it('shifts a plain mid-month date without adjustment', () => {
    expect(monthsBefore('2026-07-04', 1)).toBe('2026-06-04');
    expect(monthsBefore('2026-07-15', 6)).toBe('2026-01-15');
  });

  it('clamps Mar 31 − 1M to the end of February, not Mar 3', () => {
    expect(monthsBefore('2026-03-31', 1)).toBe('2026-02-28');
  });

  it('clamps to Feb 29 in a leap year', () => {
    expect(monthsBefore('2024-03-31', 1)).toBe('2024-02-29');
  });

  it('clamps a 31st onto a 30-day target month', () => {
    expect(monthsBefore('2026-03-31', 6)).toBe('2025-09-30'); // across the year boundary
    expect(monthsBefore('2026-05-31', 1)).toBe('2026-04-30');
  });

  it('a leap-day anchor clamps when the target February is shorter', () => {
    expect(monthsBefore('2024-02-29', 12)).toBe('2023-02-28');
  });

  it('does not clamp when the target month is long enough', () => {
    expect(monthsBefore('2026-04-30', 1)).toBe('2026-03-30');
    expect(monthsBefore('2026-12-31', 2)).toBe('2026-10-31');
  });
});
