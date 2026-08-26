import { describe, expect, it } from 'vitest';

import type { PortfolioSummary } from '@bettertrack/contracts';

import { hasUnsafeAggregateMember } from './aggregateSafety';

const PLAIN: PortfolioSummary = {
  id: 'plain',
  name: 'Plain',
  visibility: 'private',
  sortOrder: 0,
  isDefault: true,
  defaultPayFromCash: false,
  archivedAt: null,
};

describe('Home aggregate result completeness', () => {
  it('treats an offline-paused member as unavailable instead of zero', () => {
    expect(
      hasUnsafeAggregateMember([PLAIN], [{ isError: false, isPending: true, isFetching: false }]),
    ).toBe(true);
  });

  it('leaves an active initial fetch to the widget loading state', () => {
    expect(
      hasUnsafeAggregateMember([PLAIN], [{ isError: false, isPending: true, isFetching: true }]),
    ).toBe(false);
  });

  it('rejects a capped result list that omits an authoritative member', () => {
    expect(
      hasUnsafeAggregateMember(
        [PLAIN, { ...PLAIN, id: 'second' }],
        [{ isError: false, isPending: false, isFetching: false }],
      ),
    ).toBe(true);
  });

  it('accepts only one settled successful result per plain member', () => {
    expect(
      hasUnsafeAggregateMember([PLAIN], [{ isError: false, isPending: false, isFetching: false }]),
    ).toBe(false);
  });
});
