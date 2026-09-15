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

  it('rejects a payload missing the field instead of silently coercing it to false', () => {
    // `adminRoutes.ts` re-parses `overview()`'s own output through this same
    // schema before serving it. A required (non-defaulted) boolean is what
    // makes that a real guard: if the service ever regressed and stopped
    // producing the field, this parse must fail (→ 500) rather than quietly
    // supplying `false` and serving a payload that claims to be fresh.
    const { todayRollupStale: _omitted, ...withoutField } = { ...BASE, todayRollupStale: true };
    expect(usageAnalyticsResponseSchema.safeParse(withoutField).success).toBe(false);
  });
});
