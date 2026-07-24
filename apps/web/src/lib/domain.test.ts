import { describe, expect, it } from 'vitest';

import { computeSeriesStats } from '@bettertrack/domain';

describe('@bettertrack/domain', () => {
  it('resolves the shared money-math package', () => {
    expect(
      computeSeriesStats([
        { date: '2026-01-01', value: 100 },
        { date: '2026-01-02', value: 110 },
      ]).totalReturnPct,
    ).toBeCloseTo(10, 12);
  });
});
