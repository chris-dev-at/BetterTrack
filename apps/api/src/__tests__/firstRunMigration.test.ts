import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { describe, expect, it } from 'vitest';

/**
 * 0074 carries a DATA migration: every account that already exists predates the
 * setup wizard, so it must be marked complete — otherwise the first deploy sends
 * the entire user base back through onboarding.
 *
 * The shared harness always replays ALL migrations onto an empty database, which
 * can never exercise a backfill. So this suite boots a throwaway PGlite, applies
 * everything UP TO 0074, seeds real pre-migration users, then applies 0074 the
 * way the drizzle migrator would (statement chunks, one transaction).
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

const U1 = '019756a0-0000-7000-8000-0000000f0001';
const U2 = '019756a0-0000-7000-8000-0000000f0002';

describe('migration 0074_first_run_completion — established accounts are not re-onboarded', () => {
  it('backfills every pre-existing account from its created_at, leaving no nulls', async () => {
    const client = new PGlite({ extensions: { pg_trgm } });
    try {
      const tags = migrationTags();
      const target = '0074_first_run_completion';
      expect(tags).toContain(target);

      for (const tag of tags) {
        if (tag === target) break;
        await applyMigration(client, tag);
      }

      // Two accounts that existed before the wizard shipped, with distinct
      // creation times so the backfill's per-row copy is observable.
      await client.exec(`
        INSERT INTO "users" ("id", "email", "username", "password_hash", "created_at") VALUES
          ('${U1}', 'old1@bettertrack.test', 'olduser1', 'x', '2026-01-05T09:00:00Z'),
          ('${U2}', 'old2@bettertrack.test', 'olduser2', 'x', '2026-03-11T17:30:00Z');
      `);

      await applyMigration(client, target);

      const rows = await client.query<{
        id: string;
        first_run_completed_at: string | null;
        created_at: string;
      }>(`SELECT "id", "first_run_completed_at", "created_at" FROM "users" ORDER BY "created_at"`);
      expect(rows.rows).toHaveLength(2);
      // Marked complete, and specifically from each row's OWN created_at — not a
      // single "now" for everybody.
      for (const row of rows.rows) {
        expect(row.first_run_completed_at).not.toBeNull();
        expect(new Date(row.first_run_completed_at as string).toISOString()).toBe(
          new Date(row.created_at).toISOString(),
        );
      }

      const nulls = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM "users" WHERE "first_run_completed_at" IS NULL`,
      );
      expect(nulls.rows[0]?.n).toBe(0);

      // And an account created AFTER the migration starts null — the column has
      // no default, which is what makes new users reach the wizard.
      await client.exec(`
        INSERT INTO "users" ("id", "email", "username", "password_hash")
        VALUES (gen_random_uuid(), 'new@bettertrack.test', 'newuser', 'x');
      `);
      const fresh = await client.query<{ first_run_completed_at: string | null }>(
        `SELECT "first_run_completed_at" FROM "users" WHERE "username" = 'newuser'`,
      );
      expect(fresh.rows[0]?.first_run_completed_at).toBeNull();
    } finally {
      await client.close();
    }
  }, 60_000);
});
