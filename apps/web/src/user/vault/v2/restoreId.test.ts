import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearRestoreId, pendingRestoreIds, restoreIdFor } from './restoreId';
import { FIXTURE_PORTFOLIO_A, FIXTURE_PORTFOLIO_B } from './testSupport';

const STORAGE_KEY = 'bettertrack.vault2.restoreIds';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('leave restore ids', () => {
  it('mints once and returns the SAME id on every retry', () => {
    let minted = 0;
    const mint = () => `id-${(minted += 1)}`;

    const first = restoreIdFor(FIXTURE_PORTFOLIO_A, mint);
    const retry = restoreIdFor(FIXTURE_PORTFOLIO_A, mint);

    expect(first).toBe('id-1');
    expect(retry).toBe('id-1');
    expect(minted).toBe(1);
  });

  it('survives a reload, which is the failure the receipt exists for', () => {
    const original = restoreIdFor(FIXTURE_PORTFOLIO_A);
    // A reload keeps localStorage but drops every module-level cache.
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({
      [FIXTURE_PORTFOLIO_A]: original,
    });
    expect(restoreIdFor(FIXTURE_PORTFOLIO_A)).toBe(original);
  });

  it('keeps one id per portfolio', () => {
    const a = restoreIdFor(FIXTURE_PORTFOLIO_A);
    const b = restoreIdFor(FIXTURE_PORTFOLIO_B);
    expect(a).not.toBe(b);
    expect(pendingRestoreIds()).toEqual({
      [FIXTURE_PORTFOLIO_A]: a,
      [FIXTURE_PORTFOLIO_B]: b,
    });
  });

  it('mints a new id only after the server acknowledged the last one', () => {
    const first = restoreIdFor(FIXTURE_PORTFOLIO_A);
    clearRestoreId(FIXTURE_PORTFOLIO_A);
    expect(pendingRestoreIds()).toEqual({});
    expect(restoreIdFor(FIXTURE_PORTFOLIO_A)).not.toBe(first);
  });

  it('clearing an unknown portfolio is a no-op', () => {
    const other = restoreIdFor(FIXTURE_PORTFOLIO_B);
    clearRestoreId(FIXTURE_PORTFOLIO_A);
    expect(pendingRestoreIds()).toEqual({ [FIXTURE_PORTFOLIO_B]: other });
  });

  it('recovers from a corrupt store instead of blocking the move-out', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    expect(() => restoreIdFor(FIXTURE_PORTFOLIO_A)).not.toThrow();
    expect(pendingRestoreIds()[FIXTURE_PORTFOLIO_A]).toBeDefined();
  });

  it('ignores non-string entries left by another writer', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ [FIXTURE_PORTFOLIO_A]: 42 }));
    const minted = restoreIdFor(FIXTURE_PORTFOLIO_A, () => 'fresh');
    expect(minted).toBe('fresh');
  });

  it('still returns an id when storage throws (private mode)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(restoreIdFor(FIXTURE_PORTFOLIO_A, () => 'fresh')).toBe('fresh');
  });
});
