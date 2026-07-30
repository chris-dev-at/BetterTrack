import { describe, expect, test } from 'vitest';

import type { PortfolioSummary } from '@bettertrack/contracts';

import { SCOPE_ALL, SCOPE_SELECTED } from './config';
import { resolveScope, resolveWidgetScope } from './homeData';

/**
 * Scope resolution: the rule that turns a *stored* scope into the portfolios a
 * widget actually reads.
 *
 * Worth testing directly because every scoped widget inherits its behaviour from
 * here — the roll-up widgets never look at `settings.scope` themselves, they just
 * consume `scopedPortfolios`. A bug in this function silently mis-scopes the whole
 * board at once, and it does so *plausibly*: a widget showing the wrong subset
 * still renders perfectly good-looking numbers.
 */

function portfolio(id: string, name: string, isDefault = false): PortfolioSummary {
  return {
    id,
    name,
    visibility: 'private',
    sortOrder: 0,
    isDefault,
    defaultPayFromCash: false,
    archivedAt: null,
  };
}

const MAIN = portfolio('p-main', 'Main', true);
const SAVINGS = portfolio('p-savings', 'Savings');
const PENSION = portfolio('p-pension', 'Pension');
const ALL = [MAIN, SAVINGS, PENSION];

const names = (result: { portfolios: readonly PortfolioSummary[] }) =>
  result.portfolios.map((entry) => entry.name);

describe('resolveScope — the three forms', () => {
  test('undefined and "all" both take every portfolio', () => {
    for (const scope of [undefined, SCOPE_ALL]) {
      const result = resolveScope(ALL, scope);
      expect(names(result)).toEqual(['Main', 'Savings', 'Pension']);
      expect(result.single).toBeNull();
      expect(result.mode).toBe('all');
    }
  });

  test('a bare id takes exactly that portfolio', () => {
    const result = resolveScope(ALL, SAVINGS.id);
    expect(names(result)).toEqual(['Savings']);
    expect(result.single).toBe(SAVINGS);
    expect(result.mode).toBe('single');
  });

  test('a chosen set takes exactly its members', () => {
    const result = resolveScope(ALL, SCOPE_SELECTED, [PENSION.id, MAIN.id]);
    expect(names(result)).toEqual(['Main', 'Pension']);
    expect(result.mode).toBe('subset');
    // Two portfolios ⇒ no single, so nothing downstream mistakes it for a pin.
    expect(result.single).toBeNull();
  });

  test('a set is rendered in the app’s portfolio order, not the stored order', () => {
    // Otherwise two widgets over the same set could list it differently, and the
    // order would silently depend on the sequence the user happened to click in.
    expect(names(resolveScope(ALL, SCOPE_SELECTED, [PENSION.id, MAIN.id, SAVINGS.id]))).toEqual([
      'Main',
      'Savings',
      'Pension',
    ]);
  });

  test('a one-member set exposes its member as the single portfolio', () => {
    const result = resolveScope(ALL, SCOPE_SELECTED, [SAVINGS.id]);
    expect(result.single).toBe(SAVINGS);
    // Still `subset`, because it is a *fixed* set: a new portfolio must not join it.
    expect(result.mode).toBe('subset');
  });
});

describe('resolveScope — stale ids degrade, they never blank the widget', () => {
  test('a dead single scope falls back to all portfolios', () => {
    const result = resolveScope(ALL, 'p-deleted');
    expect(names(result)).toEqual(['Main', 'Savings', 'Pension']);
    expect(result.mode).toBe('all');
  });

  test('a set drops the ids that died and keeps the rest', () => {
    const result = resolveScope(ALL, SCOPE_SELECTED, [MAIN.id, 'p-deleted', PENSION.id]);
    expect(names(result)).toEqual(['Main', 'Pension']);
    expect(result.mode).toBe('subset');
  });

  test('a set whose every id died falls back to all, not to nothing', () => {
    const result = resolveScope(ALL, SCOPE_SELECTED, ['p-gone', 'p-also-gone']);
    expect(names(result)).toEqual(['Main', 'Savings', 'Pension']);
    expect(result.mode).toBe('all');
  });

  test.each([
    ['an absent list', undefined],
    ['an empty list', [] as string[]],
  ])('"selected" with %s falls back to all', (_label, scopeIds) => {
    expect(resolveScope(ALL, SCOPE_SELECTED, scopeIds).mode).toBe('all');
  });

  test('an id the caller no longer owns cannot leak another account’s portfolio in', () => {
    // The live list is the only source of portfolios; a stored id is never more
    // than a filter over it.
    const result = resolveScope([MAIN], SCOPE_SELECTED, [MAIN.id, SAVINGS.id]);
    expect(names(result)).toEqual(['Main']);
  });

  test('resolving never mutates the caller’s list', () => {
    const live = [...ALL];
    resolveScope(live, SCOPE_SELECTED, [MAIN.id]);
    expect(live).toEqual(ALL);
  });
});

describe('resolveWidgetScope — what the widget type allows', () => {
  const SCOPED = { supportsScope: true, allowsAll: true };
  const UNSCOPED = { supportsScope: false, allowsAll: true };
  const SINGLE_ONLY = { supportsScope: true, allowsAll: false };

  test('an unscoped type spans everything, whatever is stored', () => {
    const result = resolveWidgetScope(
      ALL,
      { scope: SCOPE_SELECTED, scopeIds: [MAIN.id] },
      UNSCOPED,
    );
    expect(names(result)).toEqual(['Main', 'Savings', 'Pension']);
    expect(result.mode).toBe('all');
  });

  test('a scoped type honours a chosen set', () => {
    const result = resolveWidgetScope(
      ALL,
      { scope: SCOPE_SELECTED, scopeIds: [SAVINGS.id, PENSION.id] },
      SCOPED,
    );
    expect(names(result)).toEqual(['Savings', 'Pension']);
  });

  test('a type that cannot aggregate collapses a set to its first live member', () => {
    const result = resolveWidgetScope(
      ALL,
      { scope: SCOPE_SELECTED, scopeIds: ['p-dead', PENSION.id, SAVINGS.id] },
      SINGLE_ONLY,
    );
    expect(result.single).toBe(PENSION);
    expect(names(result)).toEqual(['Pension']);
  });

  test('a type that cannot aggregate still prefers the default portfolio over the first', () => {
    const result = resolveWidgetScope([SAVINGS, MAIN], {}, SINGLE_ONLY);
    expect(result.single).toBe(MAIN);
  });

  test('no portfolios at all resolves to an empty read, not a crash', () => {
    expect(resolveWidgetScope([], { scope: SCOPE_SELECTED, scopeIds: [MAIN.id] }, SCOPED)).toEqual({
      portfolios: [],
      single: null,
      mode: 'all',
    });
    expect(resolveWidgetScope([], {}, SINGLE_ONLY).single).toBeNull();
  });
});

describe('a subset roll-up is exactly what its members sum to', () => {
  /**
   * The arithmetic guarantee behind every money widget: scoping to a set must give
   * the same total as adding those portfolios up by hand. The widgets do their own
   * summing over `scopedPortfolios`, so what this pins down is that resolution hands
   * them *precisely* the chosen members — no duplicates, no extras, nothing dropped.
   */
  const value = { [MAIN.id]: 10_000, [SAVINGS.id]: 4_000, [PENSION.id]: 2_500 };
  const sumOf = (result: { portfolios: readonly PortfolioSummary[] }) =>
    result.portfolios.reduce((total, entry) => total + (value[entry.id] ?? 0), 0);

  test.each([
    [[MAIN.id], 10_000],
    [[MAIN.id, SAVINGS.id], 14_000],
    [[SAVINGS.id, PENSION.id], 6_500],
    [[MAIN.id, SAVINGS.id, PENSION.id], 16_500],
  ])('%s sums to %i', (scopeIds, expected) => {
    expect(sumOf(resolveScope(ALL, SCOPE_SELECTED, scopeIds))).toBe(expected);
  });

  test('the parts add up to the whole', () => {
    const whole = sumOf(resolveScope(ALL, SCOPE_ALL));
    const first = sumOf(resolveScope(ALL, SCOPE_SELECTED, [MAIN.id]));
    const rest = sumOf(resolveScope(ALL, SCOPE_SELECTED, [SAVINGS.id, PENSION.id]));
    expect(first + rest).toBe(whole);
  });

  test('a duplicated id is counted once', () => {
    // The parser de-duplicates, but resolution must not depend on that having run.
    expect(sumOf(resolveScope(ALL, SCOPE_SELECTED, [MAIN.id, MAIN.id]))).toBe(10_000);
  });
});
