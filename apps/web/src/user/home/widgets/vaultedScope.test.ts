import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { PortfolioSummary } from '@bettertrack/contracts';

import type { WidgetType } from '../config';
import { portfoliosVisibleToWidget } from '../homeData';
import { WIDGET_REGISTRY } from './index';
import type { WidgetDefinition } from './types';

/**
 * The scope half of the §14 "no silent zero" boundary (PARANOID-E6, #1416).
 *
 * `aggregateSafety.test.ts` proves a widget FAILS CLOSED once a vaulted member
 * reaches it, and `HomePage.test.tsx` proves the qualifier and the unavailable
 * outcome actually render. Neither notices if a vaulted portfolio never arrives
 * in the first place — which was the original defect: Home filtered every vault
 * out before any widget could see it, so the composition layer's coverage was
 * permanently `complete` and its qualifier was unreachable.
 *
 * These tests pin the declaration itself, in both directions.
 */

const PLAIN: PortfolioSummary = {
  id: 'plain',
  name: 'Plain',
  visibility: 'private',
  sortOrder: 0,
  isDefault: true,
  defaultPayFromCash: false,
  archivedAt: null,
};

const VAULTED: PortfolioSummary = {
  ...PLAIN,
  id: 'vaulted',
  name: 'Vaulted',
  isDefault: false,
  vaultId: '00000000-0000-4000-8000-000000000001',
  vaultAlias: 'Private',
};

const HERE = dirname(fileURLToPath(import.meta.url));

const definitions = Object.values(WIDGET_REGISTRY) as readonly WidgetDefinition[];

/**
 * The reviewed opt-in set. A widget joins this list only once it can say "and N
 * more I cannot see" — so adding one is a deliberate review step, not a default
 * a new widget inherits by accident.
 */
const HANDLES_VAULTED_PORTFOLIOS: readonly WidgetType[] = [
  // Qualify the total through the composition boundary (`useRollup`).
  'net-worth',
  'today-change',
  // Fail closed to `UnavailableHomeAggregate` (`hasUnsafeAggregateMember`).
  'allocation',
  'cash-balances',
  'cashflow-chart',
  'concentration',
  'liquidity',
  'net-worth-history',
  'performance-chart',
  'top-movers',
  // Itemise: one row per locked stub plus an explicit count, and no
  // scope-spanning figure that a sealed vault could silently shrink.
  'portfolio-cards',
];

/**
 * The three sanctioned ways to account for a member the server cannot read.
 * A widget that shows none of these markers is claiming a capability it has not
 * implemented, which is worse than not claiming it at all.
 */
const MECHANISMS = ['useRollup', 'aggregateSafety', 'lockedPortfolioCount'] as const;

describe('vaulted-portfolio widget scope', () => {
  it('keeps the opt-in set frozen so a new widget must decide deliberately', () => {
    const declared = definitions
      .filter((definition) => definition.handlesVaultedPortfolios === true)
      .map((definition) => definition.type)
      .sort();
    expect(declared).toEqual([...HANDLES_VAULTED_PORTFOLIOS].sort());
  });

  it('backs every opt-in with a real completeness mechanism in its component', () => {
    const unbacked = definitions
      .filter((definition) => definition.handlesVaultedPortfolios === true)
      .map((definition) => {
        const file = join(HERE, `${definition.Component.name}.tsx`);
        const source = readFileSync(file, 'utf8');
        return {
          type: definition.type,
          backed: MECHANISMS.some((mechanism) => source.includes(mechanism)),
        };
      })
      .filter((entry) => !entry.backed)
      .map((entry) => entry.type);
    expect(unbacked).toEqual([]);
  });

  it('hides vaulted portfolios from every widget that has not opted in', () => {
    for (const definition of definitions) {
      if (definition.handlesVaultedPortfolios === true) continue;
      expect(portfoliosVisibleToWidget([PLAIN, VAULTED], definition)).toEqual([PLAIN]);
    }
  });

  it('passes vaulted portfolios through to a widget that has opted in', () => {
    expect(portfoliosVisibleToWidget([PLAIN, VAULTED], { handlesVaultedPortfolios: true })).toEqual(
      [PLAIN, VAULTED],
    );
  });

  it('never drops a vaulted portfolio silently — it is hidden or it is carried', () => {
    // The one outcome that must not exist: a widget that receives a shortened
    // list AND believes it is complete. Either the vault is out of scope (so the
    // widget's own total is honestly whole), or it is in scope and the widget
    // owns the qualifier. There is no third state.
    for (const definition of definitions) {
      const visible = portfoliosVisibleToWidget([PLAIN, VAULTED], definition);
      const carriesVault = visible.some((portfolio) => portfolio.vaultId != null);
      expect(carriesVault).toBe(definition.handlesVaultedPortfolios === true);
    }
  });
});
