import { describe, expect, it } from 'vitest';

import type { ExpenseRuleMatchType } from '@bettertrack/contracts';

import type { ExpenseRuleRecord } from '../../../data/repositories/expenseRepository';
import { categorizeByRules, ruleMatches } from '../ruleEngine';

/**
 * Auto-categorization rule engine (PROJECTPLAN.md §13.5 V5-P9, issue 2/3): all
 * four match types are case-insensitive, an invalid regex is inert (never throws),
 * rules run in the given (priority) order with first-match-wins, and disabled
 * rules are skipped.
 */

let seq = 0;
function rule(
  categoryId: string,
  matchType: ExpenseRuleMatchType,
  pattern: string,
  overrides: Partial<Pick<ExpenseRuleRecord, 'enabled' | 'priority'>> = {},
): ExpenseRuleRecord {
  seq += 1;
  return {
    id: `rule-${seq}`,
    userId: 'user-1',
    categoryId,
    matchType,
    pattern,
    priority: overrides.priority ?? 0,
    enabled: overrides.enabled ?? true,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
  };
}

describe('ruleMatches', () => {
  it('matches contains / equals / starts_with case-insensitively', () => {
    expect(ruleMatches('contains', 'billa', 'KARTENZAHLUNG BILLA 1234')).toBe(true);
    expect(ruleMatches('contains', 'BILLA', 'billa dankt')).toBe(true);
    expect(ruleMatches('equals', 'spotify ab', 'SPOTIFY AB')).toBe(true);
    expect(ruleMatches('equals', 'spotify', 'SPOTIFY AB')).toBe(false);
    expect(ruleMatches('starts_with', 'miete', 'MIETE JAENNER')).toBe(true);
    expect(ruleMatches('starts_with', 'jaenner', 'MIETE JAENNER')).toBe(false);
  });

  it('applies a regex case-insensitively and treats an invalid pattern as inert', () => {
    expect(ruleMatches('regex', 'net(flix|gear)', 'NETFLIX Monthly')).toBe(true);
    expect(ruleMatches('regex', '^oebb', 'ÖBB Ticket')).toBe(false);
    // An unbalanced group never throws — it just does not match.
    expect(ruleMatches('regex', '([a-z', 'anything')).toBe(false);
  });

  it('never matches an empty pattern', () => {
    expect(ruleMatches('contains', '   ', 'anything')).toBe(false);
  });
});

describe('categorizeByRules', () => {
  it('returns the first matching rule’s category (evaluation order wins)', () => {
    const rules = [
      rule('cat-groceries', 'contains', 'billa', { priority: 0 }),
      rule('cat-shopping', 'contains', 'dankt', { priority: 1 }),
    ];
    // Both rules match "BILLA DANKT"; the first in order (groceries) wins.
    expect(categorizeByRules('BILLA DANKT 1234', rules)).toBe('cat-groceries');
  });

  it('skips disabled rules', () => {
    const rules = [
      rule('cat-groceries', 'contains', 'billa', { enabled: false }),
      rule('cat-shopping', 'contains', 'billa'),
    ];
    expect(categorizeByRules('BILLA', rules)).toBe('cat-shopping');
  });

  it('returns null when nothing matches', () => {
    expect(categorizeByRules('UNKNOWN MERCHANT', [rule('cat-x', 'contains', 'billa')])).toBeNull();
    expect(categorizeByRules('anything', [])).toBeNull();
  });
});
