import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { describe, expect, it } from 'vitest';

/**
 * The 0024 share-audiences migration is a DATA migration (V3-P5, #332): it must
 * convert existing V2 sharing losslessly into the unified audience model, and
 * fold every implicit `workboard_items` row into each user's new default
 * **General** watchlist — WITHOUT any sharing relationship silently widening or
 * vanishing. The shared harness only ever replays migrations onto an empty DB,
 * so this suite boots a throwaway PGlite, applies everything UP TO 0024, seeds
 * real V2 rows, then applies 0024 exactly like the drizzle migrator would and
 * asserts the conversion.
 */

const drizzleDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

function migrationTags(): string[] {
  const journal = JSON.parse(readFileSync(path.join(drizzleDir, 'meta/_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string }[];
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
    for (const chunk of chunks) await client.exec(chunk);
    await client.exec('COMMIT');
  } catch (err) {
    await client.exec('ROLLBACK');
    throw err;
  }
}

// Two users: one sharing (all three kinds), one sharing nothing but with items.
const SHARER = '019756a0-0000-7000-8000-000000000001';
const QUIET = '019756a0-0000-7000-8000-000000000002';
const ASSET = '019756a0-0000-7000-8000-0000000000a1';
const P_SHARED = '019756a0-0000-7000-8000-000000000011';
const P_PRIVATE = '019756a0-0000-7000-8000-000000000012';
const P_QUIET = '019756a0-0000-7000-8000-000000000013';
const CONG = '019756a0-0000-7000-8000-000000000021';

describe('migration 0024_share_audiences — lossless V2 → audience conversion', () => {
  it('folds items into General and mirrors every V2 share into an audience row', async () => {
    const client = new PGlite({ extensions: { pg_trgm } });
    try {
      const tags = migrationTags();
      const target = '0024_share_audiences';
      expect(tags).toContain(target);

      for (const tag of tags) {
        if (tag === target) break;
        await applyMigration(client, tag);
      }

      // Seed V2 state:
      //  - SHARER: default portfolio visibility=friends, a private 2nd portfolio,
      //    a friends-visible conglomerate, watchlist_visibility=friends, 1 item.
      //  - QUIET: everything private, but 1 watched item (must still get General).
      await client.exec(`
        INSERT INTO "users" ("id","email","username","password_hash","watchlist_visibility") VALUES
          ('${SHARER}','sharer@bt.test','sharer','x','friends'),
          ('${QUIET}','quiet@bt.test','quiet','x','private');
        INSERT INTO "assets" ("id","provider_id","provider_ref","type","symbol","name","currency")
          VALUES ('${ASSET}','yahoo','AAPL','stock','AAPL','Apple','USD');
        INSERT INTO "portfolios" ("id","user_id","name","visibility") VALUES
          ('${P_SHARED}','${SHARER}','Main','friends'),
          ('${P_PRIVATE}','${SHARER}','Trading','private'),
          ('${P_QUIET}','${QUIET}','Main','private');
        INSERT INTO "conglomerates" ("id","owner_id","name","status","visibility")
          VALUES ('${CONG}','${SHARER}','Basket','active','friends');
        INSERT INTO "workboard_items" ("id","user_id","asset_id","sort_order") VALUES
          (gen_random_uuid(),'${SHARER}','${ASSET}',0),
          (gen_random_uuid(),'${QUIET}','${ASSET}',0);
      `);

      await applyMigration(client, target);

      // One General (default) list per user — including the quiet one.
      const lists = await client.query<{
        user_id: string;
        name: string;
        is_default: boolean;
      }>(`SELECT "user_id","name","is_default" FROM "watchlists" ORDER BY "user_id"`);
      expect(lists.rows).toHaveLength(2);
      for (const row of lists.rows) {
        expect(row.name).toBe('General');
        expect(row.is_default).toBe(true);
      }

      // Every workboard item is now attached to ITS owner's General list.
      const items = await client.query<{ user_id: string; watchlist_id: string }>(
        `SELECT wi."user_id", wi."watchlist_id" FROM "workboard_items" wi`,
      );
      expect(items.rows).toHaveLength(2);
      for (const item of items.rows) {
        const general = lists.rows.find((l) => l.user_id === item.user_id)!;
        expect(item.watchlist_id).toBe(
          (
            await client.query<{ id: string }>(
              `SELECT "id" FROM "watchlists" WHERE "user_id"='${item.user_id}'`,
            )
          ).rows[0]!.id,
        );
        expect(general).toBeTruthy();
      }

      // Audience rows: the shared portfolio, the shared conglomerate, and the
      // sharer's General watchlist are all `all_friends`; NOTHING else exists.
      const aud = await client.query<{ kind: string; subject_id: string; audience: string }>(
        `SELECT "kind","subject_id","audience" FROM "share_audiences" ORDER BY "kind"`,
      );
      expect(aud.rows).toHaveLength(3);

      const portfolioAud = aud.rows.find((a) => a.kind === 'portfolio')!;
      expect(portfolioAud.subject_id).toBe(P_SHARED);
      expect(portfolioAud.audience).toBe('all_friends');

      const congAud = aud.rows.find((a) => a.kind === 'conglomerate')!;
      expect(congAud.subject_id).toBe(CONG);
      expect(congAud.audience).toBe('all_friends');

      const watchAud = aud.rows.find((a) => a.kind === 'watchlist')!;
      expect(watchAud.audience).toBe('all_friends');
      const sharerGeneral = await client.query<{ id: string }>(
        `SELECT "id" FROM "watchlists" WHERE "user_id"='${SHARER}'`,
      );
      expect(watchAud.subject_id).toBe(sharerGeneral.rows[0]!.id);

      // The private 2nd portfolio and the quiet user's private state produced NO
      // audience row — private stays private, nothing silently widened.
      expect(aud.rows.some((a) => a.subject_id === P_PRIVATE)).toBe(false);
      expect(aud.rows.some((a) => a.subject_id === P_QUIET)).toBe(false);
      expect(aud.rows.some((a) => a.subject_id === QUIET)).toBe(false);
    } finally {
      await client.close();
    }
  });
});
