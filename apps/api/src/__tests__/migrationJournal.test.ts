import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Migration-journal invariants (#417 P1 follow-up, "Idempotency-Key header
 * 500s on prod").
 *
 * drizzle's migrator does NOT track applied migrations by name. It reads the
 * single max `created_at` from `__drizzle_migrations` and applies exactly the
 * journal entries whose `when` is GREATER than it. So a journal entry whose
 * `when` is not greater than every earlier entry's `when` is a latent
 * production no-op: any database that already applied the later-stamped
 * neighbour in a previous deploy skips it SILENTLY, while every fresh database
 * (unit PGlite, integration postgres, CI, new dev machines) starts empty and
 * applies everything — so all tests stay green while prod diverges.
 *
 * That exact failure shipped as 0034_idempotency_keys: 0033 carried a
 * hand-rounded future `when` (2026-07-12T23:46:40Z), 0034 a real earlier one,
 * so production — already past 0033 — never created `idempotency_keys`, and
 * every request with an `Idempotency-Key` header 500ed
 * (`relation "idempotency_keys" does not exist`). 0036 re-applies the DDL
 * idempotently; this test makes the ordering violation a PR-time failure so
 * the class cannot ship again.
 *
 * NOTE while hand-rounded FUTURE stamps exist in the journal (0033/0035): a
 * freshly generated migration gets `when = Date.now()`, which is BELOW those
 * stamps until real time passes them — so this test will fail on it, exactly
 * as intended. Bump the new entry's `when` above the current journal max
 * (as 0036 did) instead of weakening the assertion.
 */

const drizzleDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const journalPath = path.join(drizzleDir, 'meta/_journal.json');

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: JournalEntry[] };
const { entries } = journal;

/**
 * Entries that shipped BEFORE this invariant existed and are misordered but
 * neutralized (their DDL is re-applied by a later, correctly-ordered
 * migration). Frozen: adding to this list requires a superseding migration,
 * never just an exemption.
 */
const NEUTRALIZED_MISORDERED = new Map<number, string>([
  [34, '0034_idempotency_keys — skipped on prod, re-applied idempotently by 0036'],
]);

describe('drizzle migration journal', () => {
  it('has contiguous idx values in array order', () => {
    entries.forEach((entry, i) => {
      expect(entry.idx, `entry at position ${i}`).toBe(i);
    });
  });

  it('has a .sql file for every entry and an entry for every .sql file', () => {
    const tags = entries.map((e) => e.tag).sort();
    const files = readdirSync(drizzleDir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''))
      .sort();
    expect(files).toEqual(tags);
  });

  it('every entry `when` exceeds the max `when` of all earlier entries (drizzle apply rule)', () => {
    let maxSoFar = -Infinity;
    let maxTag = '(none)';
    for (const entry of entries) {
      if (!NEUTRALIZED_MISORDERED.has(entry.idx)) {
        expect(
          entry.when,
          `${entry.tag}: \`when\` (${entry.when}) must be > the max of all earlier entries ` +
            `(${maxSoFar} from ${maxTag}); otherwise drizzle silently skips it on any database ` +
            `that already applied ${maxTag} — bump this entry's \`when\` above the journal max`,
        ).toBeGreaterThan(maxSoFar);
      }
      if (entry.when > maxSoFar) {
        maxSoFar = entry.when;
        maxTag = entry.tag;
      }
    }
  });

  it('neutralized-misordered allowlist matches the journal exactly', () => {
    // Every allowlisted idx must exist and actually be misordered — a stale
    // allowlist entry would quietly disable the invariant for that idx.
    let maxSoFar = -Infinity;
    const misordered = new Set<number>();
    for (const entry of entries) {
      if (entry.when <= maxSoFar) misordered.add(entry.idx);
      maxSoFar = Math.max(maxSoFar, entry.when);
    }
    expect([...misordered].sort((a, b) => a - b)).toEqual(
      [...NEUTRALIZED_MISORDERED.keys()].sort((a, b) => a - b),
    );
  });
});

// 0121 runs while the old API still serves (review round 2, S1): it must bound
// its wait for ACCESS EXCLUSIVE on the hot token tables, and take them in the
// app's own lock order (families before access tokens, as every rotation and
// code exchange does) so an in-flight token transaction cannot deadlock with it.
describe('0121_oauth_access_first_used on a live database', () => {
  const statements = readFileSync(path.join(drizzleDir, '0121_oauth_access_first_used.sql'), 'utf8')
    .split('--> statement-breakpoint')
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join(' ')
        .trim(),
    )
    .filter((chunk) => chunk.length > 0);

  it('bounds its lock wait first, then locks oauth_token_families before oauth_access_tokens', () => {
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '10s';");
    const first = (table: string) => statements.findIndex((sql) => sql.includes(`"${table}"`));
    expect(first('oauth_token_families')).toBe(1);
    expect(first('oauth_access_tokens')).toBeGreaterThan(first('oauth_token_families'));
    const lastFamilies = statements.reduce(
      (last, sql, i) => (sql.includes('"oauth_token_families"') ? i : last),
      -1,
    );
    expect(lastFamilies).toBeLessThan(first('oauth_access_tokens'));
  });
});
