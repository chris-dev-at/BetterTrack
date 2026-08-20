import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { describe, expect, it } from 'vitest';

const drizzleDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const TARGET = '0093_living_tax_years';
const LEGACY_TABLE = ['tax', 'year', 'unlocks'].join('_');
const USER_ID = '0198cb38-1111-7000-8000-000000000001';

interface JournalEntry {
  idx: number;
  tag: string;
}

function migrationTags(): string[] {
  const journal = JSON.parse(readFileSync(path.join(drizzleDir, 'meta/_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };
  return journal.entries.sort((left, right) => left.idx - right.idx).map((entry) => entry.tag);
}

async function applyMigration(client: PGlite, tag: string): Promise<void> {
  const migration = readFileSync(path.join(drizzleDir, `${tag}.sql`), 'utf8');
  const chunks = migration
    .split(/-->\s*statement-breakpoint\s*/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
  await client.exec('BEGIN');
  try {
    for (const chunk of chunks) await client.exec(chunk);
    await client.exec('COMMIT');
  } catch (error) {
    await client.exec('ROLLBACK');
    throw error;
  }
}

describe('migration 0093 living tax years', () => {
  it('drops populated ceremony state and creates the durable documentation clock', async () => {
    const client = new PGlite({ extensions: { pg_trgm } });
    try {
      for (const tag of migrationTags()) {
        if (tag === TARGET) break;
        await applyMigration(client, tag);
      }
      await client.exec(`
        INSERT INTO "users" ("id", "email", "username", "password_hash")
        VALUES ('${USER_ID}', 'living-years@bettertrack.test', 'living_years', 'x');
        INSERT INTO "${LEGACY_TABLE}" ("user_id", "year") VALUES ('${USER_ID}', 2024);
      `);

      await applyMigration(client, TARGET);

      const legacy = await client.query<{ relation: string | null }>(
        `SELECT to_regclass('public.${LEGACY_TABLE}')::text AS relation`,
      );
      const marker = await client.query<{ relation: string | null }>(
        "SELECT to_regclass('public.tax_year_changes')::text AS relation",
      );
      expect(legacy.rows[0]?.relation).toBeNull();
      expect(marker.rows[0]?.relation).toBe('tax_year_changes');
    } finally {
      await client.close();
    }
  });
});
