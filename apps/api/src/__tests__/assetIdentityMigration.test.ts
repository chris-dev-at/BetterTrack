import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { describe, expect, it } from 'vitest';

const drizzleDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const TARGET = '0071_asset_identities';

interface JournalEntry {
  idx: number;
  tag: string;
}

function migrationTags(): string[] {
  const journal = JSON.parse(readFileSync(path.join(drizzleDir, 'meta/_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };
  return journal.entries.sort((a, b) => a.idx - b.idx).map((entry) => entry.tag);
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

async function clientBeforeTarget(): Promise<PGlite> {
  const client = new PGlite({ extensions: { pg_trgm } });
  for (const tag of migrationTags()) {
    if (tag === TARGET) break;
    await applyMigration(client, tag);
  }
  return client;
}

async function clientAtTarget(): Promise<PGlite> {
  const client = await clientBeforeTarget();
  await applyMigration(client, TARGET);
  return client;
}

const USER_ID = '019756a0-1111-7000-8000-000000000001';
const ASSET_ID = '019756a0-1111-7000-8000-0000000000a1';
const WATCHLIST_ID = '019756a0-1111-7000-8000-0000000000b1';
const WORKBOARD_ID = '019756a0-1111-7000-8000-0000000000c1';
const CONGLOMERATE_ID = '019756a0-1111-7000-8000-0000000000d1';
const POSITION_ID = '019756a0-1111-7000-8000-0000000000e1';
const ALERT_ID = '019756a0-1111-7000-8000-0000000000f1';

async function rowJson(client: PGlite, table: string, id: string): Promise<unknown> {
  const result = await client.query<{ row: unknown }>(
    `SELECT to_jsonb(t) AS "row" FROM "${table}" t WHERE "id" = '${id}'`,
  );
  return result.rows[0]?.row;
}

async function countById(client: PGlite, table: string, id: string): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::int AS "count" FROM "${table}" WHERE "id" = '${id}'`,
  );
  return result.rows[0]?.count ?? 0;
}

describe('migration 0071_asset_identities', () => {
  it('backfills and validates populated FKs before enabling detach, reconnect, and normal cascade', async () => {
    const client = await clientBeforeTarget();
    try {
      await client.exec(`
        INSERT INTO "users" ("id", "email", "username", "password_hash")
        VALUES ('${USER_ID}', 'identity@bettertrack.test', 'identity', 'x');
        INSERT INTO "watchlists" ("id", "user_id", "name", "is_default")
        VALUES ('${WATCHLIST_ID}', '${USER_ID}', 'General', true);
        INSERT INTO "assets"
          ("id", "provider_id", "provider_ref", "owner_id", "type", "symbol", "name", "currency", "meta")
        VALUES
          ('${ASSET_ID}', 'manual', '${ASSET_ID}', '${USER_ID}', 'custom', 'HOME', 'House', 'EUR',
           '{"category":"other","smoothing":false}'::jsonb);
        INSERT INTO "price_history" ("asset_id", "date", "close")
        VALUES ('${ASSET_ID}', '2026-07-25', '250000');
        INSERT INTO "workboard_items"
          ("id", "user_id", "watchlist_id", "asset_id", "sort_order", "note")
        VALUES ('${WORKBOARD_ID}', '${USER_ID}', '${WATCHLIST_ID}', '${ASSET_ID}', 3, 'keep exactly');
        INSERT INTO "conglomerates" ("id", "owner_id", "name", "status")
        VALUES ('${CONGLOMERATE_ID}', '${USER_ID}', 'Dream basket', 'active');
        INSERT INTO "conglomerate_positions"
          ("id", "conglomerate_id", "asset_id", "weight_pct", "sort_order")
        VALUES ('${POSITION_ID}', '${CONGLOMERATE_ID}', '${ASSET_ID}', '12.500', 4);
        INSERT INTO "alerts"
          ("id", "user_id", "asset_id", "kind", "threshold", "ref_price", "repeat", "status")
        VALUES ('${ALERT_ID}', '${USER_ID}', '${ASSET_ID}', 'price_above', '300000', '250000',
                true, 'active');
      `);

      const keptBefore = {
        workboard: await rowJson(client, 'workboard_items', WORKBOARD_ID),
        position: await rowJson(client, 'conglomerate_positions', POSITION_ID),
        alert: await rowJson(client, 'alerts', ALERT_ID),
      };

      await applyMigration(client, TARGET);

      expect(await countById(client, 'asset_identities', ASSET_ID)).toBe(1);
      const columns = await client.query<{
        columnName: string;
        dataType: string;
        nullable: string;
      }>(`
        SELECT column_name AS "columnName", data_type AS "dataType", is_nullable AS "nullable"
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'asset_identities'
        ORDER BY ordinal_position
      `);
      expect(columns.rows).toEqual([{ columnName: 'id', dataType: 'uuid', nullable: 'NO' }]);

      const replacementNames = [
        'workboard_items_asset_id_asset_identities_id_fk',
        'conglomerate_positions_asset_id_asset_identities_id_fk',
        'alerts_asset_id_asset_identities_id_fk',
      ];
      const constraints = await client.query<{
        name: string;
        source: string;
        target: string;
        validated: boolean;
        deleteAction: string;
      }>(`
        SELECT c.conname AS "name", source.relname AS "source", target.relname AS "target",
               c.convalidated AS "validated", c.confdeltype::text AS "deleteAction"
        FROM pg_constraint c
        JOIN pg_class source ON source.oid = c.conrelid
        JOIN pg_class target ON target.oid = c.confrelid
        WHERE c.conname = ANY (ARRAY[
          'workboard_items_asset_id_asset_identities_id_fk',
          'conglomerate_positions_asset_id_asset_identities_id_fk',
          'alerts_asset_id_asset_identities_id_fk'
        ])
        ORDER BY c.conname
      `);
      expect(constraints.rows).toHaveLength(3);
      expect(constraints.rows.map((row) => row.name).sort()).toEqual([...replacementNames].sort());
      for (const constraint of constraints.rows) {
        expect(constraint.target).toBe('asset_identities');
        expect(constraint.validated).toBe(true);
        expect(constraint.deleteAction).toBe('c');
      }
      const retired = await client.query<{ count: number }>(`
        SELECT count(*)::int AS "count"
        FROM pg_constraint
        WHERE conname = ANY (ARRAY[
          'workboard_items_asset_id_assets_id_fk',
          'conglomerate_positions_asset_id_assets_id_fk',
          'alerts_asset_id_assets_id_fk'
        ])
      `);
      expect(retired.rows[0]?.count).toBe(0);

      const detached = await client.query<{ detached: boolean }>(`
        SELECT bettertrack_detach_owned_asset_data(
          '${ASSET_ID}'::uuid,
          '${USER_ID}'::uuid
        ) AS "detached"
      `);
      expect(detached.rows[0]?.detached).toBe(true);
      expect(await countById(client, 'assets', ASSET_ID)).toBe(0);
      expect(await countById(client, 'asset_identities', ASSET_ID)).toBe(1);
      expect(
        (
          await client.query<{ count: number }>(
            `SELECT count(*)::int AS "count" FROM "price_history" WHERE "asset_id" = '${ASSET_ID}'`,
          )
        ).rows[0]?.count,
      ).toBe(0);
      expect({
        workboard: await rowJson(client, 'workboard_items', WORKBOARD_ID),
        position: await rowJson(client, 'conglomerate_positions', POSITION_ID),
        alert: await rowJson(client, 'alerts', ALERT_ID),
      }).toEqual(keptBefore);

      // Strict restore carries the original UUID. The insert trigger reuses the
      // retained identity, reconnecting all three rows without rewriting them.
      await client.exec(`
        INSERT INTO "assets"
          ("id", "provider_id", "provider_ref", "owner_id", "type", "symbol", "name", "currency", "meta")
        VALUES
          ('${ASSET_ID}', 'manual', '${ASSET_ID}', '${USER_ID}', 'custom', 'HOME', 'House', 'EUR',
           '{"category":"other","smoothing":false}'::jsonb)
      `);
      expect(await countById(client, 'asset_identities', ASSET_ID)).toBe(1);
      expect({
        workboard: await rowJson(client, 'workboard_items', WORKBOARD_ID),
        position: await rowJson(client, 'conglomerate_positions', POSITION_ID),
        alert: await rowJson(client, 'alerts', ALERT_ID),
      }).toEqual(keptBefore);

      // A direct normal delete intentionally bypasses customAssetRepository:
      // the shared DB lifecycle trigger still deletes all three consumers.
      await client.exec(`DELETE FROM "assets" WHERE "id" = '${ASSET_ID}'`);
      expect(await countById(client, 'assets', ASSET_ID)).toBe(0);
      expect(await countById(client, 'asset_identities', ASSET_ID)).toBe(0);
      expect(await countById(client, 'workboard_items', WORKBOARD_ID)).toBe(0);
      expect(await countById(client, 'conglomerate_positions', POSITION_ID)).toBe(0);
      expect(await countById(client, 'alerts', ALERT_ID)).toBe(0);
    } finally {
      await client.close();
    }
  });

  it('covers every SQL writer atomically and preserves global/account deletion behavior', async () => {
    const client = await clientAtTarget();
    const globalId = '019756a0-2222-7000-8000-000000000001';
    const skippedId = '019756a0-2222-7000-8000-000000000002';
    const invalidId = '019756a0-2222-7000-8000-000000000003';
    const customId = '019756a0-2222-7000-8000-000000000004';
    const keptAlertId = '019756a0-2222-7000-8000-000000000005';
    const missingOwner = '019756a0-2222-7000-8000-000000000099';
    try {
      const triggers = await client.query<{ name: string }>(`
        SELECT t.tgname AS "name"
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = 'assets' AND NOT t.tgisinternal
        ORDER BY t.tgname
      `);
      expect(triggers.rows.map((row) => row.name)).toEqual([
        'assets_identity_after_delete',
        'assets_identity_after_insert',
      ]);

      await client.exec(`
        INSERT INTO "users" ("id", "email", "username", "password_hash")
        VALUES ('${USER_ID}', 'writer@bettertrack.test', 'writer', 'x');
        INSERT INTO "assets"
          ("id", "provider_id", "provider_ref", "type", "symbol", "name", "currency")
        VALUES ('${globalId}', 'yahoo', 'AAPL', 'stock', 'AAPL', 'Apple', 'USD');
      `);
      expect(await countById(client, 'asset_identities', globalId)).toBe(1);
      await expect(
        client.exec(`DELETE FROM "asset_identities" WHERE "id" = '${globalId}'`),
      ).rejects.toThrow();
      expect(await countById(client, 'assets', globalId)).toBe(1);
      expect(await countById(client, 'asset_identities', globalId)).toBe(1);

      // The catalog's ON CONFLICT path skips the candidate. AFTER INSERT does
      // not fire, so no key-only orphan can commit for the losing UUID.
      await client.exec(`
        INSERT INTO "assets"
          ("id", "provider_id", "provider_ref", "type", "symbol", "name", "currency")
        VALUES ('${skippedId}', 'yahoo', 'AAPL', 'stock', 'AAPL', 'Duplicate', 'USD')
        ON CONFLICT DO NOTHING
      `);
      expect(await countById(client, 'assets', skippedId)).toBe(0);
      expect(await countById(client, 'asset_identities', skippedId)).toBe(0);

      // Failure after the row trigger (the owner FK rejects the asset) rolls
      // back the trigger's identity insert with the same statement.
      await expect(
        client.exec(`
          INSERT INTO "assets"
            ("id", "provider_id", "provider_ref", "owner_id", "type", "symbol", "name", "currency")
          VALUES
            ('${invalidId}', 'manual', '${invalidId}', '${missingOwner}', 'custom', 'BAD', 'Bad', 'EUR')
        `),
      ).rejects.toThrow();
      expect(await countById(client, 'assets', invalidId)).toBe(0);
      expect(await countById(client, 'asset_identities', invalidId)).toBe(0);

      await client.exec(`
        INSERT INTO "assets"
          ("id", "provider_id", "provider_ref", "owner_id", "type", "symbol", "name", "currency")
        VALUES
          ('${customId}', 'manual', '${customId}', '${USER_ID}', 'custom', 'CAR', 'Car', 'EUR');
        INSERT INTO "alerts"
          ("id", "user_id", "asset_id", "kind", "threshold", "status")
        VALUES
          ('${keptAlertId}', '${USER_ID}', '${customId}', 'price_above', '50000', 'active');
        SELECT bettertrack_detach_owned_asset_data('${customId}'::uuid, '${USER_ID}'::uuid);
      `);
      expect(await countById(client, 'assets', customId)).toBe(0);
      expect(await countById(client, 'asset_identities', customId)).toBe(1);
      await client.exec(`
        DELETE FROM "users" WHERE "id" = '${USER_ID}';
      `);
      expect(await countById(client, 'assets', customId)).toBe(0);
      expect(await countById(client, 'asset_identities', customId)).toBe(0);
      expect(await countById(client, 'assets', globalId)).toBe(1);
      expect(await countById(client, 'asset_identities', globalId)).toBe(1);

      await client.exec(`DELETE FROM "assets" WHERE "id" = '${globalId}'`);
      expect(await countById(client, 'asset_identities', globalId)).toBe(0);
    } finally {
      await client.close();
    }
  });
});
