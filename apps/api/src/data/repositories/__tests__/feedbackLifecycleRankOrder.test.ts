import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createTestApp } from '../../../testing/createTestApp';
import { buildRankOrder } from '../feedbackRepository';

/**
 * The lifecycle sort's ranks must be INTEGERS in the statement Postgres runs,
 * not the text they silently become when every arm of the `CASE` is an
 * unknown-typed bind parameter. `adminSupportInbox.test.ts` cannot see the
 * difference: the live partition has six statuses, and `'0'`…`'5'` sort
 * identically as text and as int, so that suite stays green either way.
 *
 * So this file drives `buildRankOrder` directly with TWELVE ranks — the first
 * length at which the two typings disagree, because text puts `'10'` and `'11'`
 * between `'1'` and `'2'`. A text-typed arm produces a visibly different row
 * order here and fails, which is the whole point of the file.
 */
const RANKED_KEYS = [
  'rank-00',
  'rank-01',
  'rank-02',
  'rank-03',
  'rank-04',
  'rank-05',
  'rank-06',
  'rank-07',
  'rank-08',
  'rank-09',
  'rank-10',
  'rank-11',
] as const;

/**
 * One extra key the ranked list does not mention, so the `else` arm — which
 * production's exhaustive enum partition never reaches — is exercised here. It
 * carries rank 12 and must sort LAST; under text typing `'12'` lands between
 * `'11'` and `'2'` instead, a second way this test refuses a mis-typed arm.
 */
const UNRANKED_KEY = 'rank-zz-unranked';

/**
 * Feed the keys in an order that is neither the rank order nor the alphabetical
 * one, so neither a missing `ORDER BY` nor the `k` tiebreak can fake a pass.
 */
const FEED_ORDER = [
  UNRANKED_KEY,
  'rank-02',
  'rank-11',
  'rank-00',
  'rank-09',
  'rank-01',
  'rank-10',
  'rank-05',
  'rank-03',
  'rank-08',
  'rank-04',
  'rank-07',
  'rank-06',
] as const;

/**
 * PGlite hands `execute()` back a `{ rows }` envelope and postgres-js hands
 * back a bare array — this file is meant to run on both engines, so unwrap the
 * same way the account-deletion suite does.
 */
function rowsOf<T>(result: unknown): T[] {
  const envelope = result as { rows?: T[] };
  return (envelope.rows ?? (result as T[])) as T[];
}

const rowsSource = sql.join(
  FEED_ORDER.map((key) => sql`(${key})`),
  sql`, `,
);

describe('lifecycle rank order is an integer expression', () => {
  it('sorts twelve ranks numerically, not lexicographically, and types the CASE as integer', async () => {
    const harness = await createTestApp();
    try {
      const rank = buildRankOrder(sql`t.k`, RANKED_KEYS);

      const ordered = await harness.db.execute(
        sql`select t.k as "k" from (values ${rowsSource}) as t(k) order by ${rank}, t.k`,
      );
      const keys = rowsOf<{ k: string }>(ordered).map((row) => row.k);

      // Numeric rank order: 0,1,2,…,11, then the unranked key on the else arm.
      expect(keys).toEqual([...RANKED_KEYS, UNRANKED_KEY]);

      // …and the order a text-typed arm would have produced instead, spelled
      // out so the failure message names the actual bug rather than a diff.
      const lexicographic = [
        'rank-00',
        'rank-01',
        'rank-10',
        'rank-11',
        UNRANKED_KEY, // rank 12
        'rank-02',
        'rank-03',
        'rank-04',
        'rank-05',
        'rank-06',
        'rank-07',
        'rank-08',
        'rank-09',
      ];
      expect(keys).not.toEqual(lexicographic);

      // The direct statement of the invariant: ask Postgres what the key's type
      // actually is. `text` here is the untyped bug; `integer` is the cast.
      const typed = await harness.db.execute(
        sql`select distinct pg_typeof(${rank})::text as "t" from (values ${rowsSource}) as t(k)`,
      );
      expect(rowsOf<{ t: string }>(typed).map((row) => row.t)).toEqual(['integer']);
    } finally {
      await harness.dispose();
    }
  });
});
