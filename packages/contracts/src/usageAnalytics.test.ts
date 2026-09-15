import { describe, expect, it } from 'vitest';

import { usageAnalyticsResponseSchema } from './usageAnalytics';

const BASE = {
  activeUsers: { daily: 1, weekly: 2, monthly: 3 },
  features: [],
  topAssets: [],
  funnel: [],
  series: [],
  windowDays: 30,
  generatedAt: '2026-07-18T00:00:00.000Z',
} as const;

describe('usageAnalyticsResponseSchema — todayRollupStale (#1906)', () => {
  it('parses a payload that carries the field, either way', () => {
    expect(
      usageAnalyticsResponseSchema.parse({ ...BASE, todayRollupStale: true }).todayRollupStale,
    ).toBe(true);
    expect(
      usageAnalyticsResponseSchema.parse({ ...BASE, todayRollupStale: false }).todayRollupStale,
    ).toBe(false);
  });

  it('defaults to false when an older API response omits the field', () => {
    const parsed = usageAnalyticsResponseSchema.parse({ ...BASE });
    expect(parsed.todayRollupStale).toBe(false);
  });
});
