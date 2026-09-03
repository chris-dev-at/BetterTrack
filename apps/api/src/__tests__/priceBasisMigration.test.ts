import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { describe, expect, it } from 'vitest';

/**
 * Migration `0110` is a DATA migration (V5-P5, #1694, §16 2026-09-03): it labels
 * what is already on disk so the value engine can tell raw closes from adjusted
 * ones — on BOTH layers that hold money.
 *
 *  - `price_history.basis`: every pre-existing upstream row is `adjusted`
 *    (written from `adjclose`), while custom-asset value marks stay `unadjusted`
 *    (no issuer, no dividend, no split — they were never adjusted).
 *  - `portfolio_snapshot_state.price_basis`: every pre-existing state row is
 *    `adjusted`, because its snapshot rows are stored VALUES computed from those
 *    adjusted closes. Relabelling prices does nothing for them; the read path
 *    refuses to serve a row whose recorded basis is not the valuation basis and
 *    rewrites the series instead.
 *
 * The shared harness always replays every migration onto an empty database,
 * which can never exercise a backfill — so this suite boots a throwaway PGlite,
 * applies everything UP TO 0110, seeds real pre-rule rows, then applies 0110
 * exactly like the drizzle migrator would and asserts the labelling.
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
const UPSTREAM = '019756a0-0000-7000-8000-000000000021';
const CUSTOM = '019756a0-0000-7000-8000-000000000022';

describe('migration 0110_price_history_basis — labelling what is already on disk', () => {
  it('marks upstream prices adjusted, keeps custom-asset marks raw, and distrusts every existing snapshot state', async () => {
    const client = new PGlite({ extensions: { pg_trgm } });
    try {
      const tags = migrationTags();
      const target = '0110_price_history_basis';
      expect(tags).toContain(target);

      for (const tag of tags) {
        if (tag === target) break;
        await applyMigration(client, tag);
      }

      // Pre-rule state: an upstream asset priced from `adjclose`, a custom asset
      // whose value marks are the user's own raw numbers, and a portfolio whose
      // snapshot rows were computed from the upstream (adjusted) series.
      await client.exec(`
        INSERT INTO "users" ("id", "email", "username", "password_hash")
        VALUES ('${U1}', 'basis@bettertrack.test', 'basisuser', 'x');
        INSERT INTO "portfolios" ("id", "user_id", "name") VALUES ('${P1}', '${U1}', 'Main');
        INSERT INTO "assets"
          ("id", "provider_id", "provider_ref", "type", "symbol", "name", "currency") VALUES
          ('${UPSTREAM}', 'yahoo', 'BAYN.DE', 'stock', 'BAYN.DE', 'Bayer AG', 'EUR');
        INSERT INTO "assets"
          ("id", "owner_id", "provider_id", "provider_ref", "type", "symbol", "name", "currency")
          VALUES
          ('${CUSTOM}', '${U1}', 'manual', 'custom:car', 'custom', 'CAR', 'Car', 'EUR');
        INSERT INTO "price_history" ("asset_id", "date", "close") VALUES
          ('${UPSTREAM}', '2026-01-05', 24.1),
          ('${UPSTREAM}', '2026-01-06', 24.4),
          ('${CUSTOM}', '2026-01-05', 12000);
        INSERT INTO "portfolio_daily_snapshots"
          ("portfolio_id", "date", "value_eur", "cost_basis_eur", "pl_eur", "flow_eur",
           "cash_by_source", "asset_values") VALUES
          ('${P1}', '2026-01-05', 241, 250, -9, 0, '{}', '{}'),
          ('${P1}', '2026-01-06', 244, 250, -6, 0, '{}', '{}');
        INSERT INTO "portfolio_snapshot_state" ("portfolio_id", "computed_through", "dirty_from")
        VALUES ('${P1}', '2026-01-06', NULL);
      `);

      await applyMigration(client, target);

      const prices = await client.query<{ asset_id: string; date: string; basis: string }>(
        `SELECT "asset_id", "date"::text AS date, "basis" FROM "price_history"
         ORDER BY "asset_id", "date"`,
      );
      expect(prices.rows).toHaveLength(3);
      for (const row of prices.rows) {
        expect(row.basis).toBe(row.asset_id === CUSTOM ? 'unadjusted' : 'adjusted');
      }

      // The derived layer: the state row is untrusted, and — this is the point —
      // its snapshot rows are left INTACT. The migration does not delete money;
      // the label is what stops it being served, and the next computation
      // rewrites the rows in place.
      const state = await client.query<{ price_basis: string; dirty_from: string | null }>(
        `SELECT "price_basis", "dirty_from"::text AS dirty_from FROM "portfolio_snapshot_state"`,
      );
      expect(state.rows).toHaveLength(1);
      expect(state.rows[0]?.price_basis).toBe('adjusted');
      expect(state.rows[0]?.dirty_from).toBeNull();
      const rows = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM "portfolio_daily_snapshots"`,
      );
      expect(rows.rows[0]?.n).toBe(2);

      // Post-migration writers: a price row defaults to the raw basis (every
      // writer that exists after this migration produces raw values), while a
      // state row defaults to `adjusted` — the pre-rule basis — so anything
      // written by an image that predates the rule is rebuilt, not trusted.
      await client.exec(`
        INSERT INTO "price_history" ("asset_id", "date", "close")
        VALUES ('${UPSTREAM}', '2026-01-07', 24.9);
        INSERT INTO "portfolios" ("id", "user_id", "name")
        VALUES ('019756a0-0000-7000-8000-000000000012', '${U1}', 'Second');
        INSERT INTO "portfolio_snapshot_state" ("portfolio_id", "computed_through")
        VALUES ('019756a0-0000-7000-8000-000000000012', '2026-01-07');
      `);
      const fresh = await client.query<{ basis: string }>(
        `SELECT "basis" FROM "price_history" WHERE "date" = '2026-01-07'`,
      );
      expect(fresh.rows[0]?.basis).toBe('unadjusted');
      const freshState = await client.query<{ price_basis: string }>(
        `SELECT "price_basis" FROM "portfolio_snapshot_state"
         WHERE "portfolio_id" = '019756a0-0000-7000-8000-000000000012'`,
      );
      expect(freshState.rows[0]?.price_basis).toBe('adjusted');
    } finally {
      await client.close();
    }
  });
});
