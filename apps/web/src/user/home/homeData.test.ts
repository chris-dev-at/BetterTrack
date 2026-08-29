import { describe, expect, test } from 'vitest';

import type { PortfolioSummary, PortfolioTotals } from '@bettertrack/contracts';

import { SCOPE_ALL, SCOPE_SELECTED } from './config';
import {
  composeHomeRollup,
  homePortfolioRead,
  resolveScope,
  resolveWidgetScope,
  type HomePortfolioRead,
} from './homeData';

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

const TOTALS: PortfolioTotals = {
  marketValueEur: 900.02,
  investedEur: 800.01,
  unrealizedPnlEur: 100.01,
  unrealizedPnlPct: 12.5,
  dayChangeEur: 10.01,
  dayChangePct: 1.1,
  cashEur: 100.03,
  totalValueEur: 1000.05,
};

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

describe('Home money roll-up coverage', () => {
  test('a settled error wins over stale cached totals', () => {
    expect(homePortfolioRead(MAIN, { isError: true, data: { totals: TOTALS } })).toEqual({
      state: 'error',
    });
  });

  test('a pre-move cached API response cannot make a vaulted stub visible', () => {
    const vaulted = {
      ...SAVINGS,
      vaultId: '00000000-0000-4000-8000-000000000001',
      vaultAlias: 'Private',
    };

    expect(homePortfolioRead(vaulted, { isError: false, data: { totals: TOTALS } })).toEqual({
      state: 'error',
    });
  });

  /**
   * PARANOID-E6 residual (#1416): the resolver-backed client read.
   *
   * The stub-only classification above is what a LOCKED vault still gets. When
   * the vault is unlocked on this device the client engine can serve the same
   * portfolio, and that read arrives here as an explicit third argument — never
   * as the server query result, which stays disabled for every vaulted member.
   */
  test('an unlocked client read is what makes a vaulted member readable', () => {
    const vaulted = {
      ...SAVINGS,
      vaultId: '00000000-0000-4000-8000-000000000001',
      vaultAlias: 'Private',
    };
    const clientRead = {
      state: 'success',
      provenance: {
        kind: 'vaulted-unlocked',
        vaultId: vaulted.vaultId,
        snapshotId: 'vault-document-set-v1',
        isCurrent: () => true,
      },
      totals: TOTALS,
    } satisfies HomePortfolioRead;

    // The disabled server query is still what the second argument carries.
    expect(homePortfolioRead(vaulted, { isError: false }, clientRead)).toBe(clientRead);
    // And it never becomes the answer for a portfolio the resolver did not open.
    expect(homePortfolioRead(vaulted, { isError: false })).toEqual({ state: 'error' });
  });

  test('a client read still cannot overrule a settled server read for a PLAIN portfolio', () => {
    const clientRead = {
      state: 'success',
      provenance: {
        kind: 'vaulted-unlocked',
        vaultId: '00000000-0000-4000-8000-000000000001',
        snapshotId: 'vault-document-set-v1',
        isCurrent: () => true,
      },
      totals: TOTALS,
    } satisfies HomePortfolioRead;

    expect(
      homePortfolioRead(MAIN, { isError: false, data: { totals: TOTALS } }, clientRead),
    ).toEqual({ state: 'success', provenance: { kind: 'plain' }, totals: TOTALS });
  });

  test('plain-only successful figures compose as complete server-shaped totals', () => {
    const rollup = composeHomeRollup(
      [MAIN, SAVINGS],
      [
        { state: 'success', provenance: { kind: 'plain' }, totals: TOTALS },
        {
          state: 'success',
          provenance: { kind: 'plain' },
          totals: {
            ...TOTALS,
            marketValueEur: 99.98,
            investedEur: 49.99,
            unrealizedPnlEur: 49.99,
            dayChangeEur: -0.01,
            cashEur: 0.02,
            totalValueEur: 100,
          },
        },
      ],
    );

    expect(rollup).toMatchObject({
      status: 'ready',
      totalValue: { valueEur: 1100.05, coverage: { kind: 'complete' } },
      invested: { valueEur: 850, coverage: { kind: 'complete' } },
      cash: { valueEur: 100.05, coverage: { kind: 'complete' } },
      dayChange: { valueEur: 10, coverage: { kind: 'complete' } },
      dayChangePct: { coverage: { kind: 'complete' } },
    });
  });

  test('a vaulted 403/error can only produce a qualified partial figure, never a bare total', () => {
    const vaulted = {
      ...SAVINGS,
      vaultId: '00000000-0000-4000-8000-000000000001',
      vaultAlias: 'Private',
    };
    const rollup = composeHomeRollup(
      [MAIN, vaulted],
      [{ state: 'success', provenance: { kind: 'plain' }, totals: TOTALS }, { state: 'error' }],
    );

    expect(rollup.status).toBe('ready');
    if (rollup.status !== 'ready') throw new Error('Expected a qualified partial roll-up.');
    expect(rollup.totalValue.valueEur).toBe(TOTALS.totalValueEur);
    for (const figure of [
      rollup.totalValue,
      rollup.invested,
      rollup.cash,
      rollup.dayChange,
      rollup.dayChangePct,
    ]) {
      expect(figure.coverage).toEqual({
        kind: 'partial',
        visiblePortfolioCount: 1,
        lockedPortfolioCount: 1,
        qualifier: {
          kind: 'locked-portfolios',
          count: 1,
          messageKey: 'vaultComposition.lockedPortfoliosQualifierOne',
        },
      });
    }
  });

  test('an explicitly authenticated unlocked-vault result composes as visible', () => {
    const vaulted = {
      ...SAVINGS,
      vaultId: '00000000-0000-4000-8000-000000000001',
      vaultAlias: 'Private',
    };
    const rollup = composeHomeRollup(
      [MAIN, vaulted],
      [
        { state: 'success', provenance: { kind: 'plain' }, totals: TOTALS },
        {
          state: 'success',
          provenance: {
            kind: 'vaulted-unlocked',
            vaultId: vaulted.vaultId,
            snapshotId: 'vault-version:write-id',
            isCurrent: () => true,
          },
          totals: TOTALS,
        },
      ],
    );

    expect(rollup.status).toBe('ready');
    if (rollup.status !== 'ready') throw new Error('Expected a complete mixed roll-up.');
    expect(rollup.totalValue).toEqual({
      valueEur: TOTALS.totalValueEur * 2,
      coverage: {
        kind: 'complete',
        visiblePortfolioCount: 2,
        lockedPortfolioCount: 0,
        qualifier: null,
      },
    });
  });

  test.each([
    [
      'a mismatched vault',
      {
        kind: 'vaulted-unlocked' as const,
        vaultId: '00000000-0000-4000-8000-000000000002',
        snapshotId: 'vault-version:write-id',
        isCurrent: () => true,
      },
    ],
    [
      'a stale document set',
      {
        kind: 'vaulted-unlocked' as const,
        vaultId: '00000000-0000-4000-8000-000000000001',
        snapshotId: 'vault-version:write-id',
        isCurrent: () => false,
      },
    ],
    [
      'a revoked session check',
      {
        kind: 'vaulted-unlocked' as const,
        vaultId: '00000000-0000-4000-8000-000000000001',
        snapshotId: 'vault-version:write-id',
        isCurrent: () => {
          throw new Error('revoked');
        },
      },
    ],
  ])('%s is classified as locked at composition time', (_label, provenance) => {
    const vaulted = {
      ...SAVINGS,
      vaultId: '00000000-0000-4000-8000-000000000001',
      vaultAlias: 'Private',
    };
    const rollup = composeHomeRollup(
      [MAIN, vaulted],
      [
        { state: 'success', provenance: { kind: 'plain' }, totals: TOTALS },
        { state: 'success', provenance, totals: TOTALS },
      ],
    );

    expect(rollup.status).toBe('ready');
    if (rollup.status !== 'ready') throw new Error('Expected a qualified partial roll-up.');
    expect(rollup.totalValue).toMatchObject({
      valueEur: TOTALS.totalValueEur,
      coverage: {
        kind: 'partial',
        lockedPortfolioCount: 1,
        qualifier: { count: 1 },
      },
    });
  });

  test('an errored plain member exposes no numeric fallback', () => {
    const rollup = composeHomeRollup(
      [MAIN, SAVINGS],
      [{ state: 'success', provenance: { kind: 'plain' }, totals: TOTALS }, { state: 'error' }],
    );

    expect(rollup).toEqual({
      status: 'unavailable',
      rows: [
        { portfolio: MAIN, totals: TOTALS },
        { portfolio: SAVINGS, totals: null },
      ],
      totalValue: null,
      invested: null,
      cash: null,
      dayChange: null,
      dayChangePct: null,
      loading: false,
      coverage: { kind: 'unavailable', unavailablePortfolioCount: 1 },
    });
  });

  test('an all-locked scope is unavailable, not a 0 total wearing a qualifier', () => {
    // With no visible member there is nothing for the qualifier to qualify: the
    // composed figures would be 0 only because none of them could be read.
    const vaulted = { ...SAVINGS, vaultId: '00000000-0000-4000-8000-000000000001' };

    const rollup = composeHomeRollup([vaulted], [{ state: 'error' }]);

    expect(rollup).toMatchObject({
      status: 'unavailable',
      totalValue: null,
      invested: null,
      cash: null,
      dayChange: null,
      dayChangePct: null,
      coverage: { kind: 'unavailable', unavailablePortfolioCount: 1 },
    });
  });

  test('a mixed scope still composes its readable subtotal with the qualifier', () => {
    // The counterpart to the rule above: one readable member IS a basis, so the
    // total is real and the qualifier does its job rather than suppressing it.
    const vaulted = { ...SAVINGS, vaultId: '00000000-0000-4000-8000-000000000001' };

    const rollup = composeHomeRollup(
      [MAIN, vaulted],
      [{ state: 'success', provenance: { kind: 'plain' }, totals: TOTALS }, { state: 'error' }],
    );

    expect(rollup.status).toBe('ready');
    expect(rollup.totalValue?.coverage).toMatchObject({ kind: 'partial' });
  });
});
