import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { describe, expect, it } from 'vitest';

/**
 * The 0022 custom-asset-categories migration is a DATA migration (V3-P2, issue
 * #325). The old CUSTOM taxonomy (real_estate / vehicle / …) has no clean map
 * onto the new catalog taxonomy, so every pre-existing custom asset is re-mapped
 * to `other` and flagged for the one-time re-categorize banner. The shared test
 * harness always replays ALL migrations onto an empty DB (never any pre-existing
 * custom asset), so this suite boots a throwaway PGlite, applies everything UP TO
 * 0022, seeds legacy custom + market assets, then applies 0022 exactly like the
 * drizzle migrator would and asserts the mapping.
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

const U1 = '019756a0-1111-7000-8000-000000000001';
const CUSTOM_A = '019756a0-1111-7000-8000-0000000000a1';
const CUSTOM_B = '019756a0-1111-7000-8000-0000000000a2';
const MARKET = '019756a0-1111-7000-8000-0000000000b1';

describe('migration 0022_custom_asset_categories — legacy custom assets → other + flag', () => {
  it('remaps every custom asset to other with a re-categorize flag, leaving market assets untouched', async () => {
    const client = new PGlite({ extensions: { pg_trgm } });
    try {
      const tags = migrationTags();
      const target = '0022_custom_asset_categories';
      expect(tags).toContain(target);

      for (const tag of tags) {
        if (tag === target) break;
        await applyMigration(client, tag);
      }

      // Seed legacy state: a user with two custom (manual) assets carrying the
      // OLD taxonomy, and one market asset that must be left alone.
      await client.exec(`
        INSERT INTO "users" ("id", "email", "username", "password_hash")
        VALUES ('${U1}', 'legacy@bettertrack.test', 'legacy', 'x');
        INSERT INTO "assets"
          ("id", "provider_id", "provider_ref", "owner_id", "type", "symbol", "name", "currency", "meta") VALUES
          ('${CUSTOM_A}', 'manual', '${CUSTOM_A}', '${U1}', 'custom', 'House', 'House', 'EUR', '{"category":"real_estate"}'::jsonb),
          ('${CUSTOM_B}', 'manual', '${CUSTOM_B}', '${U1}', 'custom', 'Car',   'Car',   'EUR', '{"category":"vehicle"}'::jsonb),
          ('${MARKET}',  'yahoo',  'AAPL',        NULL,     'stock',  'AAPL',  'Apple', 'USD', NULL);
      `);

      await applyMigration(client, target);

      const customs = await client.query<{ id: string; meta: Record<string, unknown> }>(
        `SELECT "id", "meta" FROM "assets" WHERE "provider_id" = 'manual' ORDER BY "id"`,
      );
      expect(customs.rows).toHaveLength(2);
      for (const row of customs.rows) {
        expect(row.meta.category).toBe('other');
        expect(row.meta.recategorize).toBe(true);
      }

      // The market asset's meta is untouched (still NULL — no flag leaked in).
      const market = await client.query<{ meta: Record<string, unknown> | null }>(
        `SELECT "meta" FROM "assets" WHERE "id" = '${MARKET}'`,
      );
      expect(market.rows[0]?.meta).toBeNull();
    } finally {
      await client.close();
    }
  });
});
