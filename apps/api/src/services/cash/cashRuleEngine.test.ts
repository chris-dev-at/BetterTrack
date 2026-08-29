import { describe, expect, it } from 'vitest';

import { cashRuleMatches, isSupportedCashRuleRegex, tagsByRules } from './cashRuleEngine';

/**
 * THE COMPILED-PATTERN MEMO (#964).
 *
 * `cashRuleEngine` is pure and I/O-free except for ONE piece of hidden state: a
 * bounded FIFO map of compiled RE2 patterns, added so that staging a 5000-row
 * import costs R compilations instead of N×R. A cache is the classic place for a
 * correctness regression to hide behind a performance win — a wrong key, a
 * poisoned entry, a stale hit after eviction all produce a FASTER engine that
 * answers the wrong question — so the properties below are about identity, not
 * about speed.
 *
 * The cache is module-level and deliberately not reset between cases: that is
 * how it behaves in a live process, where one long-lived worker serves rules
 * from every account it touches, and a per-test reset would hide exactly the
 * cross-contamination these tests exist to refuse.
 */
describe('cashRuleEngine compiled-pattern cache', () => {
  /**
   * THE KEY IS THE WHOLE PATTERN.
   *
   * Two patterns sharing a long prefix are two different regexes, and a cache
   * keyed on anything less than the whole string would serve the first one's
   * compilation for the second — silently tagging a movement by a rule that
   * does not match it. The prefix below is deliberately long and identical for
   * the first 24 characters; the patterns differ only near the end.
   */
  it('never lets two patterns with a long shared prefix collide on one entry', () => {
    const shared = '^einzahlung sepa gehalt ';
    const acme = `${shared}acme gmbh$`;
    const globex = `${shared}globex gmbh$`;

    // Each compiles and matches its OWN memo …
    expect(cashRuleMatches('regex', acme, 'Einzahlung SEPA Gehalt ACME GmbH')).toBe(true);
    expect(cashRuleMatches('regex', globex, 'Einzahlung SEPA Gehalt Globex GmbH')).toBe(true);

    // … and, now that both are cached, refuses the other's — in both
    // directions, so neither insertion order can be the one that happens to
    // work.
    expect(cashRuleMatches('regex', acme, 'Einzahlung SEPA Gehalt Globex GmbH')).toBe(false);
    expect(cashRuleMatches('regex', globex, 'Einzahlung SEPA Gehalt ACME GmbH')).toBe(false);
  });

  /**
   * A rule set is walked first-match-wins, so a collision between two rules'
   * patterns would not merely mis-answer one comparison — it would hand the
   * WRONG RULE's whole tag set to the movement. Same property as above, stated
   * where it actually costs a user something.
   */
  it('keeps two colliding-prefix RULES assigning their own tag sets', () => {
    const rules = [
      {
        matchType: 'regex' as const,
        pattern: '^auszahlung sepa miete wohnung wien$',
        enabled: true,
        tagIds: ['tag-rent-wien'],
      },
      {
        matchType: 'regex' as const,
        pattern: '^auszahlung sepa miete wohnung graz$',
        enabled: true,
        tagIds: ['tag-rent-graz'],
      },
    ];

    expect(tagsByRules('Auszahlung SEPA MIETE Wohnung Wien', rules)).toEqual(['tag-rent-wien']);
    expect(tagsByRules('Auszahlung SEPA MIETE Wohnung Graz', rules)).toEqual(['tag-rent-graz']);
    expect(tagsByRules('Auszahlung SEPA MIETE Wohnung Linz', rules)).toEqual([]);
  });

  /**
   * The cache is bounded (512, FIFO) because its key space is user-controlled:
   * patterns arrive from `cash_rules` rows across every account this process
   * serves. Eviction must therefore be a pure performance event — an evicted
   * pattern recompiles on its next use and answers identically.
   */
  it('recompiles an evicted pattern and answers identically', () => {
    const victim = '^evictme (alpha|beta) [0-9]+$';
    expect(cashRuleMatches('regex', victim, 'EVICTME alpha 42')).toBe(true);

    // Push strictly more than the cap through the cache, so the entry above is
    // certainly gone (the cap is 512; these are 600 distinct patterns).
    for (let i = 0; i < 600; i += 1) {
      expect(cashRuleMatches('regex', `^filler-${i}-[0-9]+$`, `filler-${i}-7`)).toBe(true);
    }

    // Re-entry: identical verdicts, on a match and on a non-match.
    expect(cashRuleMatches('regex', victim, 'EVICTME alpha 42')).toBe(true);
    expect(cashRuleMatches('regex', victim, 'EVICTME gamma 42')).toBe(false);
  });

  /**
   * A malformed or RE2-unsupported pattern is a deterministic answer too, so it
   * is cached as `null` rather than re-thrown-and-swallowed on every row. The
   * property that matters: the cached failure stays INERT — it is never
   * confused with "absent" (which would re-compile forever) and never with a
   * successful compilation (which would make it match something).
   */
  it('caches an unsupported pattern as a reusable failure that stays inert', () => {
    // A lookahead: syntactically fine for JS, refused by RE2 by design.
    const unsupported = '^(?=cachedfailure)cachedfailure$';
    expect(isSupportedCashRuleRegex(unsupported)).toBe(false);
    // Second call reads the cached `null` and must reach the same verdict.
    expect(isSupportedCashRuleRegex(unsupported)).toBe(false);
    // And an inert pattern matches nothing — not even the string it describes.
    expect(cashRuleMatches('regex', unsupported, 'cachedfailure')).toBe(false);
    expect(cashRuleMatches('regex', unsupported, 'anything else')).toBe(false);

    // A rule carrying it therefore assigns nothing, and the NEXT rule still gets
    // its turn — an unparseable pattern must not swallow the rest of the walk.
    expect(
      tagsByRules('cachedfailure', [
        { matchType: 'regex', pattern: unsupported, enabled: true, tagIds: ['tag-broken'] },
        { matchType: 'contains', pattern: 'cachedfailure', enabled: true, tagIds: ['tag-plain'] },
      ]),
    ).toEqual(['tag-plain']);
  });

  /**
   * Only `regex` consults the cache. The other three match types treat the
   * pattern as a literal, so a string first seen as a `contains` needle must not
   * leave anything behind that changes what it means as a regex later — nor the
   * reverse.
   */
  it('does not let a `contains` needle poison the same string used as a regex', () => {
    // `a.c` is a literal for `contains` and a wildcard for `regex`.
    const pattern = 'zqx.cache-probe';

    // Seen first as a literal: matches only the literal, wildcard or not.
    expect(cashRuleMatches('contains', pattern, 'memo zqx.cache-probe tail')).toBe(true);
    expect(cashRuleMatches('contains', pattern, 'memo zqxYcache-probe tail')).toBe(false);

    // The same string as a regex still means what a regex means.
    expect(cashRuleMatches('regex', pattern, 'memo zqxYcache-probe tail')).toBe(true);

    // …and going back to `contains` is unaffected by the compilation above.
    expect(cashRuleMatches('contains', pattern, 'memo zqxYcache-probe tail')).toBe(false);
    expect(cashRuleMatches('contains', pattern, 'memo zqx.cache-probe tail')).toBe(true);
  });

  /**
   * Every match type is case-insensitive (bank memos are wildly cased), and for
   * `regex` that insensitivity lives in the COMPILATION — `new RE2(pattern,
   * 'i')`. A cache that dropped the flag, or that stored a case-sensitive
   * compilation under the same key, would make the second occurrence of a
   * pattern behave differently from the first.
   */
  it('keeps case-insensitivity across the cold and the cached call', () => {
    const pattern = '^ueberweisung büro möbel';

    // Cold: compiled here.
    expect(cashRuleMatches('regex', pattern, 'Ueberweisung BÜRO Möbel Rückzahlung')).toBe(true);
    // Cached: same verdict, and for the other casings too.
    expect(cashRuleMatches('regex', pattern, 'ueberweisung büro möbel rückzahlung')).toBe(true);
    expect(cashRuleMatches('regex', pattern, 'UEBERWEISUNG BÜRO MÖBEL RÜCKZAHLUNG')).toBe(true);
    // The anchor still holds — insensitivity is the only thing the flag buys.
    expect(cashRuleMatches('regex', pattern, 'Sammel Ueberweisung BÜRO Möbel')).toBe(false);
  });
});
