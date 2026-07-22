import type { ExpenseRuleMatchType } from '@bettertrack/contracts';

import type { ExpenseRuleRecord } from '../../data/repositories/expenseRepository';

/**
 * Auto-categorization rule engine (PROJECTPLAN.md §13.5 V5-P9, issue 2/3). Pure,
 * no I/O — a transaction description in, a category id (or null) out — so every
 * matcher is directly unit-testable. Issue 1/3 stored the rule shape; this
 * evaluates it: rules run in ascending `priority` then age (the repository
 * already returns them so), disabled rules are skipped, and the FIRST match wins.
 *
 * All four match types are **case-insensitive** — bank memos are wildly cased
 * ("BILLA DANKT", "spotify") and a user categorizing "billa" expects both to hit.
 * A `regex` whose pattern is invalid never throws: it simply does not match, so a
 * fat-fingered rule can never crash an import.
 */

/** Whether `description` matches a single rule's `matchType` + `pattern`. */
export function ruleMatches(
  matchType: ExpenseRuleMatchType,
  pattern: string,
  description: string,
): boolean {
  const haystack = description.toLowerCase();
  const needle = pattern.trim().toLowerCase();
  if (needle === '') return false;
  switch (matchType) {
    case 'contains':
      return haystack.includes(needle);
    case 'equals':
      return haystack.trim() === needle;
    case 'starts_with':
      return haystack.trimStart().startsWith(needle);
    case 'regex':
      try {
        return new RegExp(pattern, 'i').test(description);
      } catch {
        // An invalid pattern is inert — never a thrown import.
        return false;
      }
    default: {
      // Exhaustiveness guard: a new match type must be handled here.
      const _never: never = matchType;
      return _never;
    }
  }
}

/**
 * The category id the enabled rules assign to `description`, or null when none
 * matches (→ the transaction imports uncategorized). `rules` MUST already be in
 * evaluation order (ascending priority, then age) — the repository's
 * `listForOwner` returns them so.
 */
export function categorizeByRules(
  description: string,
  rules: readonly ExpenseRuleRecord[],
): string | null {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (ruleMatches(rule.matchType, rule.pattern, description)) return rule.categoryId;
  }
  return null;
}
