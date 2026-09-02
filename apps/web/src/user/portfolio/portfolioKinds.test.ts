import { beforeEach, describe, expect, test, vi } from 'vitest';

import { PORTFOLIO_KINDS as CONTRACT_KINDS } from '@bettertrack/contracts';

import {
  DEFAULT_PORTFOLIO_KIND,
  PORTFOLIO_KINDS,
  isGroupPortfolio,
  PORTFOLIO_KIND_ICONS,
  portfolioIconName,
  portfolioIconTint,
  portfolioKindsFor,
  resetPortfolioKindCache,
  type PortfolioKind,
} from './portfolioKinds';

const STORAGE_KEY = 'bt.portfolio.kinds';

/** A portfolio row as the kind resolver sees it. */
const row = (id: string, kind: PortfolioKind | null = null) => ({ id, kind });

beforeEach(() => {
  localStorage.clear();
  resetPortfolioKindCache();
  vi.restoreAllMocks();
});

describe('the kind enum is the wire contract', () => {
  test('the tokens, their order and the default are the contract, verbatim', () => {
    // Board #69: the mobile app ported these five tokens AND their hues off this
    // module before it graduated. Renaming, renumbering or reordering them —
    // here or in contracts — silently repaints or blanks icons on a shipped
    // client, so both ends are pinned to one literal list.
    expect(PORTFOLIO_KINDS).toEqual(['private', 'family', 'business', 'savings', 'property']);
    expect(PORTFOLIO_KINDS).toEqual(CONTRACT_KINDS);
    expect(DEFAULT_PORTFOLIO_KIND).toBe('private');
    expect(PORTFOLIO_KINDS).toContain(DEFAULT_PORTFOLIO_KIND);
  });

  test('every kind has an icon and no two kinds share one', () => {
    const icons = PORTFOLIO_KINDS.map((kind) => PORTFOLIO_KIND_ICONS[kind]);
    expect(icons).toHaveLength(PORTFOLIO_KINDS.length);
    expect(new Set(icons).size).toBe(PORTFOLIO_KINDS.length);
  });
});

describe('portfolioKindsFor — server value, legacy fallback', () => {
  test('the server value is the kind', () => {
    expect(portfolioKindsFor([row('p1', 'business'), row('p2', 'property')])).toEqual({
      p1: 'business',
      p2: 'property',
    });
  });

  test('an unclassified portfolio is absent, so callers land on the default', () => {
    expect(portfolioKindsFor([row('p1')])).toEqual({});
  });

  test('a pre-#69 local kind fills in until the server carries one', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ p1: 'family' }));
    resetPortfolioKindCache();

    expect(portfolioKindsFor([row('p1'), row('p2')])).toEqual({ p1: 'family' });
  });

  test('the server value wins over a stale local one', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ p1: 'family' }));
    resetPortfolioKindCache();

    expect(portfolioKindsFor([row('p1', 'savings')])).toEqual({ p1: 'savings' });
  });

  test('a local kind for a portfolio that is not in the list is not invented', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ghost: 'family' }));
    resetPortfolioKindCache();

    expect(portfolioKindsFor([row('p1')])).toEqual({});
  });

  // ── Hostile storage: the fallback is garnish, never a crash ────────────────

  test('corrupt JSON degrades to the server value instead of throwing', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    resetPortfolioKindCache();

    expect(portfolioKindsFor([row('p1'), row('p2', 'savings')])).toEqual({ p2: 'savings' });
  });

  test('a non-object payload is ignored', () => {
    localStorage.setItem(STORAGE_KEY, '["family"]');
    resetPortfolioKindCache();

    expect(portfolioKindsFor([row('p1')])).toEqual({});
  });

  test('unknown local tokens are dropped, valid neighbours survive', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ p1: 'yacht', p2: 'savings', p3: 7 }));
    resetPortfolioKindCache();

    expect(portfolioKindsFor([row('p1'), row('p2'), row('p3')])).toEqual({ p2: 'savings' });
  });

  test('storage that throws on read degrades instead of breaking the switcher', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    resetPortfolioKindCache();

    expect(portfolioKindsFor([row('p1'), row('p2', 'family')])).toEqual({ p2: 'family' });
  });

  test('the legacy map is never written back — the server owns kinds now', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem');
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ p1: 'family' }));
    resetPortfolioKindCache();
    write.mockClear();

    portfolioKindsFor([row('p1'), row('p2', 'savings')]);

    expect(write).not.toHaveBeenCalled();
  });
});

describe('portfolioIconName', () => {
  test('uses the kind icon on a normal portfolio', () => {
    expect(portfolioIconName({ mirror: undefined }, 'business')).toBe('briefcase');
    expect(portfolioIconName({ mirror: undefined }, 'private')).toBe('user-lock');
  });

  test('a synced chain copy keeps its own kind glyph — the marker carries "shared"', () => {
    const mirror = {
      chainId: 'c1',
      chainName: 'Household',
      role: 'owner' as const,
      memberCount: 3,
      sync: { appliedSeq: 1, lastSeq: 1, percent: 100, synced: true, stalled: false },
    };
    // Forcing the group glyph made the Icon setting a no-op for exactly the
    // portfolios people most want to tell apart (owner), so being shared is
    // carried by the chip's corner marker instead.
    for (const kind of PORTFOLIO_KINDS) {
      expect(portfolioIconName({ mirror }, kind)).toBe(PORTFOLIO_KIND_ICONS[kind]);
      expect(isGroupPortfolio({ mirror })).toBe(true);
    }
    expect(isGroupPortfolio({ mirror: undefined })).toBe(false);
  });
});

describe('portfolioIconTint', () => {
  test('a normal portfolio is tinted by its kind', () => {
    for (const kind of PORTFOLIO_KINDS) {
      expect(portfolioIconTint({ mirror: undefined }, kind)).toBe(kind);
    }
  });

  test("a synced chain copy keeps its kind hue — the group hue is the marker's", () => {
    const mirror = {
      chainId: 'c1',
      chainName: 'Household',
      role: 'owner' as const,
      memberCount: 3,
      sync: { appliedSeq: 1, lastSeq: 1, percent: 100, synced: true, stalled: false },
    };
    for (const kind of PORTFOLIO_KINDS) {
      expect(portfolioIconTint({ mirror }, kind)).toBe(kind);
    }
  });
});
