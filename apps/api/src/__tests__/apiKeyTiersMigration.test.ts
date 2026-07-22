import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { describe, expect, it } from 'vitest';

/**
 * The 0066 API-key-tiers migration seeds exactly one `is_default` tier
 * (120 req / 60 s) so an existing key with no explicit tier resolves a sane
 * allowance unchanged (§13.5 V5-P10, issue 2/2). The shared harness truncates
 * every table on each boot, wiping the seed — so this suite boots a throwaway
 * PGlite, applies every migration in order, and asserts the seed row survives.
 */

const drizzleDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

interface JournalEntry {
  idx: number;
  tag: string;
}

function migrationTags(): string[] {
  const journal = JSON.parse(readFileSync(path.join(drizzleDir, 'meta/_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };
  return journal.entries.sort((a, b) => a.idx - b.idx).map((e) => e.tag);
}

/** Apply one migration file the way drizzle's migrator does: statement chunks, one transaction. */
async function applyMigration(client: PGlite, tag: string): Promise<void> {
  const sql = readFileSync(path.join(drizzleDir, `${tag}.sql`), 'utf8');
  const chunks = sql
    .split(/-->\s*statement-breakpoint\s*/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
  await client.exec('BEGIN');
  try {
    for (const chunk of chunks) {
      await client.exec(chunk);
    }
    await client.exec('COMMIT');
  } catch (err) {
    await client.exec('ROLLBACK');
    throw err;
  }
}

describe('migration 0066_api_key_rate_tiers — default tier seed', () => {
  it('seeds exactly one default tier at 120/60', async () => {
    const client = new PGlite({ extensions: { pg_trgm } });
    try {
      for (const tag of migrationTags()) {
        await applyMigration(client, tag);
      }
      const res = await client.query<{
        request_limit: number;
        window_sec: number;
        is_default: boolean;
      }>('SELECT request_limit, window_sec, is_default FROM api_key_tiers WHERE is_default = true');
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]!.request_limit).toBe(120);
      expect(res.rows[0]!.window_sec).toBe(60);
    } finally {
      await client.close();
    }
  });
});
