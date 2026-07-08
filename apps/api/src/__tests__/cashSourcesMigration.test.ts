import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { describe, expect, it } from 'vitest';

/**
 * The 0019 cash-sources migration is a DATA migration (V3-P3, issue #326): it
 * must convert existing V2 single-ledger cash data losslessly into a per-
 * portfolio **Main** source. The shared test harness always replays ALL
 * migrations onto an empty database, which can never exercise the backfill —
 * so this suite boots a throwaway PGlite, applies everything UP TO 0019, seeds
 * real V2 rows, then applies 0019 exactly like the drizzle migrator would (one
 * transaction) and asserts the conversion.
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

const U1 = '019756a0-0000-7000-8000-000000000001';
const P1 = '019756a0-0000-7000-8000-000000000011';
const P2 = '019756a0-0000-7000-8000-000000000012';

describe('migration 0019_cash_sources — lossless V2 → Main conversion', () => {
  it('creates one Main per portfolio, attaches every movement, balances identical', async () => {
    const client = new PGlite({ extensions: { pg_trgm } });
    try {
      const tags = migrationTags();
      const target = '0019_cash_sources';
      expect(tags).toContain(target);

      // Everything before 0019 — the schema V2 data really lived in.
      for (const tag of tags) {
        if (tag === target) break;
        await applyMigration(client, tag);
      }

      // Seed V2 state: one user, two portfolios, a mixed single-ledger history
      // on the first (deposit / withdrawal / sell_proceeds; sub-cent-free per
      // the #322 invariant) and an untouched second portfolio.
      await client.exec(`
        INSERT INTO "users" ("id", "email", "username", "password_hash")
        VALUES ('${U1}', 'v2@bettertrack.test', 'v2user', 'x');
        INSERT INTO "portfolios" ("id", "user_id", "name") VALUES
          ('${P1}', '${U1}', 'Main'),
          ('${P2}', '${U1}', 'Second');
        INSERT INTO "portfolio_cash_movements"
          ("id", "portfolio_id", "kind", "amount_eur", "executed_at") VALUES
          (gen_random_uuid(), '${P1}', 'deposit',        1000.50, '2026-01-05T09:00:00Z'),
          (gen_random_uuid(), '${P1}', 'withdrawal',     -200.25, '2026-01-06T09:00:00Z'),
          (gen_random_uuid(), '${P1}', 'sell_proceeds',   150.75, '2026-01-07T09:00:00Z');
      `);

      const before = await client.query<{ portfolio_id: string; balance: string; n: number }>(
        `SELECT "portfolio_id", SUM("amount_eur")::text AS balance, COUNT(*)::int AS n
         FROM "portfolio_cash_movements" GROUP BY "portfolio_id"`,
      );
      expect(before.rows).toHaveLength(1);
      expect(Number(before.rows[0]?.balance)).toBe(951);

      // The migration under test, transactional like the real migrator (this
      // also proves the enum-recreate dance works mid-transaction).
      await applyMigration(client, target);

      // Exactly one Main per portfolio — including the movement-less one.
      const sources = await client.query<{
        id: string;
        portfolio_id: string;
        name: string;
        type: string;
        is_main: boolean;
        archived_at: string | null;
      }>(`SELECT * FROM "portfolio_cash_sources" ORDER BY "portfolio_id"`);
      expect(sources.rows).toHaveLength(2);
      for (const source of sources.rows) {
        expect(source.name).toBe('Main');
        expect(source.type).toBe('cash');
        expect(source.is_main).toBe(true);
        expect(source.archived_at).toBeNull();
      }
      expect(sources.rows.map((s) => s.portfolio_id).sort()).toEqual([P1, P2].sort());

      // Every movement is attached to ITS portfolio's Main; count preserved.
      const p1Main = sources.rows.find((s) => s.portfolio_id === P1)!;
      const movements = await client.query<{ source_id: string }>(
        `SELECT "source_id" FROM "portfolio_cash_movements"`,
      );
      expect(movements.rows).toHaveLength(3);
      for (const movement of movements.rows) {
        expect(movement.source_id).toBe(p1Main.id);
      }

      // Balances before/after are identical — per source AND rolled up.
      const after = await client.query<{ source_id: string; balance: string }>(
        `SELECT "source_id", SUM("amount_eur")::text AS balance
         FROM "portfolio_cash_movements" GROUP BY "source_id"`,
      );
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0]?.balance).toBe(before.rows[0]?.balance);

      // The NOT NULL backstop holds for post-migration writes…
      await expect(
        client.query(
          `INSERT INTO "portfolio_cash_movements"
             ("id", "portfolio_id", "kind", "amount_eur", "executed_at")
           VALUES (gen_random_uuid(), '${P1}', 'deposit', 10, '2026-02-01T09:00:00Z')`,
        ),
      ).rejects.toThrow(/source_id|not-null/i);

      // …and the recreated enum + CHECKs accept a well-formed transfer pair.
      await client.query(
        `INSERT INTO "portfolio_cash_movements"
           ("id", "portfolio_id", "source_id", "kind", "amount_eur", "executed_at",
            "transfer_id", "counterpart_source_id") VALUES
           (gen_random_uuid(), '${P1}', '${p1Main.id}', 'transfer_out', -1,
            '2026-02-01T09:00:00Z', '019756a0-0000-7000-8000-0000000000aa', '${p1Main.id}'),
           (gen_random_uuid(), '${P1}', '${p1Main.id}', 'transfer_in', 1,
            '2026-02-01T09:00:00Z', '019756a0-0000-7000-8000-0000000000aa', '${p1Main.id}')`,
      );
      const rolledUp = await client.query<{ balance: string }>(
        `SELECT SUM("amount_eur")::text AS balance FROM "portfolio_cash_movements"
         WHERE "portfolio_id" = '${P1}'`,
      );
      expect(Number(rolledUp.rows[0]?.balance)).toBe(951); // the pair cancels
    } finally {
      await client.close();
    }
  });
});
