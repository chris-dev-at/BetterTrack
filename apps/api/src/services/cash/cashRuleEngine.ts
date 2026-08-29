import RE2 from 're2';

import type { CashRuleMatchType } from '@bettertrack/contracts';

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
 * Compiled-pattern memo, so evaluating N notes against R regex rules costs R
 * compilations rather than N×R.
 *
 * Book-time batches are small (one trade, one transfer pair) and never noticed
 * this. An IMPORT batch is not: staging a 5000-row statement runs the same
 * first-match walk once per cash row, and `new RE2(...)` is the one genuinely
 * expensive step in it — recompiling the same handful of user patterns 5000
 * times over is pure waste. The cache makes regex compilation a per-batch cost
 * (O(R)) instead of a per-row one (O(N×R)).
 *
 * Keyed by the pattern string, which is the whole compilation input (the `i`
 * flag is constant here). A `null` — an unsupported or malformed pattern — is
 * cached too: it is just as deterministic and just as worth not re-deriving.
 *
 * Bounded and FIFO-evicted because the key space is user-controlled: patterns
 * arrive from `cash_rules` rows across every account this process serves, so an
 * unbounded map would be a slow memory leak keyed by user input. The cap is far
 * above any real user's rule count, so eviction is a pathological-case backstop
 * rather than something a normal workload ever reaches.
 */
const REGEX_CACHE_MAX = 512;
const regexCache = new Map<string, RE2 | null>();

/**
 * Compile with the linear-time regex engine used for every cash-rule match. RE2
 * rejects syntax that would need backtracking (lookarounds, backreferences) as
 * well as malformed patterns.
 *
 * Memoized (see above); the result is identical to compiling every time, since
 * a pattern's compilation depends on nothing but the pattern.
 */
function compileRegex(pattern: string): RE2 | null {
  const cached = regexCache.get(pattern);
  // `undefined` means "absent"; a cached `null` is a real, reusable answer.
  if (cached !== undefined || regexCache.has(pattern)) return cached ?? null;
  let compiled: RE2 | null;
  try {
    compiled = new RE2(pattern, 'i');
  } catch {
    compiled = null;
  }
  if (regexCache.size >= REGEX_CACHE_MAX) {
    const oldest = regexCache.keys().next();
    if (!oldest.done) regexCache.delete(oldest.value);
  }
  regexCache.set(pattern, compiled);
  return compiled;
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
 * The four fields evaluating a rule actually needs.
 *
 * Structural on purpose: a full `CashRuleRecord` from the repository satisfies
 * it, and so does the leaner row the book-time path loads straight from SQL
 * (`cashRuleTagStamp.ts`) — which has no business inventing a `userId` and two
 * timestamps just to be allowed to ask what a note tags as.
 */
export interface EvaluableCashRule {
  matchType: CashRuleMatchType;
  pattern: string;
  enabled: boolean;
  tagIds: readonly string[];
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
export function tagsByRules(note: string, rules: readonly EvaluableCashRule[]): string[] {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.tagIds.length === 0) continue;
    if (cashRuleMatches(rule.matchType, rule.pattern, note)) return [...rule.tagIds];
  }
  return [];
}
