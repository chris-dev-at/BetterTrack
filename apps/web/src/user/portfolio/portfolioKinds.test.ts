import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  DEFAULT_PORTFOLIO_KIND,
  PORTFOLIO_KINDS,
  PORTFOLIO_KIND_ICONS,
  getPortfolioKind,
  getPortfolioKinds,
  portfolioIconName,
  resetPortfolioKindCache,
  setPortfolioKind,
} from './portfolioKinds';

const STORAGE_KEY = 'bt.portfolio.kinds';

beforeEach(() => {
  localStorage.clear();
  resetPortfolioKindCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('portfolio kind storage', () => {
  test('an unclassified portfolio is private', () => {
    expect(getPortfolioKind('p1')).toBe(DEFAULT_PORTFOLIO_KIND);
    expect(DEFAULT_PORTFOLIO_KIND).toBe('private');
  });

  test('a set kind round-trips through localStorage', () => {
    setPortfolioKind('p1', 'business');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({ p1: 'business' });

    resetPortfolioKindCache(); // force a re-read from storage
    expect(getPortfolioKind('p1')).toBe('business');
  });

  test('kinds are per portfolio and merge rather than replace', () => {
    setPortfolioKind('p1', 'family');
    setPortfolioKind('p2', 'property');

    expect(getPortfolioKinds()).toEqual({ p1: 'family', p2: 'property' });
    expect(getPortfolioKind('p3')).toBe('private');
  });

  test('every kind has an icon and no two kinds share one', () => {
    const icons = PORTFOLIO_KINDS.map((kind) => PORTFOLIO_KIND_ICONS[kind]);
    expect(icons).toHaveLength(PORTFOLIO_KINDS.length);
    expect(new Set(icons).size).toBe(PORTFOLIO_KINDS.length);
  });

  // ── Hostile storage: kinds are garnish, never a crash ──────────────────────

  test('corrupt JSON degrades to the default instead of throwing', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    resetPortfolioKindCache();

    expect(getPortfolioKind('p1')).toBe('private');
    expect(getPortfolioKinds()).toEqual({});
  });

  test('a non-object payload is ignored', () => {
    localStorage.setItem(STORAGE_KEY, '["family"]');
    resetPortfolioKindCache();

    expect(getPortfolioKinds()).toEqual({});
  });

  test('unknown kind tokens are dropped, valid neighbours survive', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ p1: 'yacht', p2: 'savings', p3: 7 }));
    resetPortfolioKindCache();

    expect(getPortfolioKinds()).toEqual({ p2: 'savings' });
    expect(getPortfolioKind('p1')).toBe('private');
  });

  test('a write that throws still updates the session in memory', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(() => setPortfolioKind('p1', 'savings')).not.toThrow();
    expect(getPortfolioKind('p1')).toBe('savings');
  });
});

describe('portfolioIconName', () => {
  test('uses the kind icon on a normal portfolio', () => {
    expect(portfolioIconName({ mirror: undefined }, 'business')).toBe('briefcase');
    expect(portfolioIconName({ mirror: undefined }, 'private')).toBe('user-lock');
  });

  test('a synced chain copy shows the group icon whatever its kind', () => {
    const mirror = {
      chainId: 'c1',
      chainName: 'Household',
      role: 'owner' as const,
      memberCount: 3,
      sync: { appliedSeq: 1, lastSeq: 1, percent: 100, synced: true },
    };
    for (const kind of PORTFOLIO_KINDS) {
      expect(portfolioIconName({ mirror }, kind)).toBe('users');
    }
  });
});
