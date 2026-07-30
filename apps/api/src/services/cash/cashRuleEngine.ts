import RE2 from 're2';

import type { CashRuleMatchType } from '@bettertrack/contracts';

import type { CashRuleRecord } from '../../data/repositories/cashRuleRepository';

/**
 * Cash auto-tagging rule engine (V5 cash fusion). Pure, no I/O — a movement note
 * in, a set of tag ids out — so every matcher is directly unit-testable.
 *
 * FIRST MATCH WINS, carried over from `expense_rules` unchanged: rules run in
 * ascending `priority` then age (the repository already returns them so), disabled
 * rules are skipped, and the first matching rule applies its WHOLE tag set and
 * evaluation stops.
 *
 * Multi-tag rules make "union every matching rule" tempting; it was rejected in
 * phase 1 and stays rejected. Under a union no single rule wins, so a user cannot
 * explain, undo or reorder a result, and `priority` becomes decorative. Multiple
 * tags per rule already cover the real case ("REWE → Food + Groceries").
 *
 * All four match types are **case-insensitive** — bank memos are wildly cased
 * ("BILLA DANKT", "spotify") and a user tagging "billa" expects both to hit. A
 * `regex` always runs through RE2, whose matching time is linear rather than
 * backtracking, so a legacy user-supplied pattern cannot stall an import; a
 * malformed or unsupported pattern is inert rather than throwing.
 */

/**
 * Compile with the linear-time regex engine used for every cash-rule match. RE2
 * rejects syntax that would need backtracking (lookarounds, backreferences) as
 * well as malformed patterns.
 */
function compileRegex(pattern: string): RE2 | null {
  try {
    return new RE2(pattern, 'i');
  } catch {
    return null;
  }
}

/** Whether a regex-rule pattern can be saved for RE2 evaluation. */
export function isSupportedCashRuleRegex(pattern: string): boolean {
  return compileRegex(pattern) !== null;
}

/** Whether `note` matches a single rule's `matchType` + `pattern`. */
export function cashRuleMatches(
  matchType: CashRuleMatchType,
  pattern: string,
  note: string,
): boolean {
  const haystack = note.toLowerCase();
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
      // Compile each stored pattern with RE2: rows persisted before write-time
      // validation are deliberately not trusted to be safe.
      return compileRegex(pattern)?.test(note) ?? false;
    default: {
      // Exhaustiveness guard: a new match type must be handled here.
      const _never: never = matchType;
      return _never;
    }
  }
}

/**
 * The tags the enabled rules assign to `note`, or an empty array when none
 * matches (→ the movement stays untagged, exactly the "uncategorized" state a
 * NULL category used to mean).
 *
 * `rules` MUST already be in evaluation order — the repository's `listForOwner`
 * returns them so, and this function deliberately does not re-sort, so there is
 * one place where evaluation order is decided.
 */
export function tagsByRules(note: string, rules: readonly CashRuleRecord[]): string[] {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.tagIds.length === 0) continue;
    if (cashRuleMatches(rule.matchType, rule.pattern, note)) return [...rule.tagIds];
  }
  return [];
}
