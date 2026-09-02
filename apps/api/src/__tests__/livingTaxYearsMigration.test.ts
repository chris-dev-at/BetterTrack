import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { describe, expect, it } from 'vitest';

import type { Database } from '../data/db';
import { createPortfolioSettingsRepository } from '../data/repositories/portfolioSettingsRepository';
import {
  createTaxRepository,
  type UserTaxSettingsRecord,
} from '../data/repositories/taxRepository';
import * as schema from '../data/schema';

const drizzleDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const TARGET = '0093_living_tax_years';
const GUARD_TARGET = '0099_living_tax_year_touch_guards';
const FANOUT_TARGET = '0105_living_tax_year_correction_fanout';
const LEGACY_TABLE = ['tax', 'year', 'unlocks'].join('_');
const USER_ID = '0198cb38-1111-7000-8000-000000000001';
const PORTFOLIO_2024_ID = '0198cb38-1111-7000-8000-000000000002';
const PORTFOLIO_2025_ID = '0198cb38-1111-7000-8000-000000000003';
const ASSET_ID = '0198cb38-1111-7000-8000-000000000004';
const CASH_SOURCE_ID = '0198cb38-1111-7000-8000-000000000007';
const CORRECTION_ID = '0198cb38-1111-7000-8000-000000000008';
const ATTACHED_TAX_ID = '0198cb38-1111-7000-8000-000000000009';
const TX_2023_ID = '0198cb38-1111-7000-8000-00000000000a';
const TX_2024_ID = '0198cb38-1111-7000-8000-00000000000b';
const TX_2025_ID = '0198cb38-1111-7000-8000-00000000000c';
const BASELINE = new Date('2000-01-01T00:00:00.000Z');

const NONE_SETTINGS: UserTaxSettingsRecord = {
  mode: 'none',
  country: null,
  manualDefaultAmountEur: null,
  manualDefaultRatePct: null,
  customParams: null,
};

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

async function bootUpTo(stopTag: string): Promise<PGlite> {
  const client = new PGlite({ extensions: { pg_trgm } });
  const tags = migrationTags();
  expect(tags).toContain(stopTag);
  for (const tag of tags) {
    if (tag === stopTag) break;
    await applyMigration(client, tag);
  }
  return client;
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

describe(`migration ${GUARD_TARGET}`, () => {
  it('ignores identical settings upserts and touches only years affected by real changes', async () => {
    const client = await bootUpTo(GUARD_TARGET);
    try {
      await client.exec(`
        INSERT INTO "users" ("id", "email", "username", "password_hash")
        VALUES ('${USER_ID}', 'touch-guards@bettertrack.test', 'touch_guards', 'x');
        INSERT INTO "portfolios" ("id", "user_id", "name") VALUES
          ('${PORTFOLIO_2024_ID}', '${USER_ID}', '2024 source'),
          ('${PORTFOLIO_2025_ID}', '${USER_ID}', '2025 source');
        INSERT INTO "assets" (
          "id", "provider_id", "provider_ref", "type", "symbol", "name", "currency"
        ) VALUES ('${ASSET_ID}', 'yahoo', 'TOUCH-GUARD', 'stock', 'TG', 'Touch Guard', 'EUR');
        INSERT INTO "transactions" (
          "id", "portfolio_id", "asset_id", "side", "quantity", "price", "executed_at"
        ) VALUES
          ('0198cb38-1111-7000-8000-000000000005', '${PORTFOLIO_2024_ID}', '${ASSET_ID}', 'buy', 1, 10, '2024-06-01T12:00:00Z'),
          ('0198cb38-1111-7000-8000-000000000006', '${PORTFOLIO_2025_ID}', '${ASSET_ID}', 'buy', 1, 10, '2025-06-01T12:00:00Z');
      `);
      await applyMigration(client, GUARD_TARGET);

      const db = drizzlePglite(client, { schema }) as unknown as Database;
      const taxRepository = createTaxRepository(db);
      const portfolioSettingsRepository = createPortfolioSettingsRepository(db);
      const portfolioOverride = { mode: 'none' };

      await taxRepository.setUserTaxSettings(USER_ID, NONE_SETTINGS);
      await portfolioSettingsRepository.setSetting(PORTFOLIO_2024_ID, 'tax', portfolioOverride);
      await client.exec(`
        UPDATE "user_tax_settings" SET "updated_at" = '2001-01-01T00:00:00Z'
        WHERE "user_id" = '${USER_ID}';
        UPDATE "portfolio_settings" SET "updated_at" = '2001-01-01T00:00:00Z'
        WHERE "portfolio_id" = '${PORTFOLIO_2024_ID}' AND "key" = 'tax';
        UPDATE "tax_year_changes" SET "last_changed_at" = '${BASELINE.toISOString()}'
        WHERE "user_id" = '${USER_ID}';
      `);

      await taxRepository.setUserTaxSettings(USER_ID, NONE_SETTINGS);
      await portfolioSettingsRepository.setSetting(PORTFOLIO_2024_ID, 'tax', portfolioOverride);

      const afterIdentical = await taxRepository.listTaxYearChanges(USER_ID);
      expect(afterIdentical).toEqual([
        { year: 2024, lastChangedAt: BASELINE },
        { year: 2025, lastChangedAt: BASELINE },
      ]);

      await taxRepository.setUserTaxSettings(USER_ID, {
        ...NONE_SETTINGS,
        mode: 'manual_per_trade',
      });
      const afterUserChange = await taxRepository.listTaxYearChanges(USER_ID);
      expect(afterUserChange.map(({ year }) => year)).toEqual([2024, 2025]);
      expect(afterUserChange.every(({ lastChangedAt }) => lastChangedAt! > BASELINE)).toBe(true);

      await client.exec(`
        UPDATE "tax_year_changes" SET "last_changed_at" = '${BASELINE.toISOString()}'
        WHERE "user_id" = '${USER_ID}';
      `);
      await portfolioSettingsRepository.setSetting(PORTFOLIO_2024_ID, 'tax', {
        mode: 'manual_per_trade',
      });

      const afterPortfolioChange = await taxRepository.listTaxYearChanges(USER_ID);
      expect(afterPortfolioChange[0]).toMatchObject({ year: 2024 });
      expect(afterPortfolioChange[0]!.lastChangedAt!.getTime()).toBeGreaterThan(BASELINE.getTime());
      expect(afterPortfolioChange[1]).toEqual({ year: 2025, lastChangedAt: BASELINE });
    } finally {
      await client.close();
    }
  });
});

describe(`migration ${FANOUT_TARGET}`, () => {
  it('attributes a cash correction to the year it documents and leaves the other years untouched', async () => {
    const client = await bootUpTo(FANOUT_TARGET);
    try {
      // Rows, triggers and markers from 0093/0099 already exist when the
      // fan-out migration lands — it must apply cleanly on top of them.
      await client.exec(`
        INSERT INTO "users" ("id", "email", "username", "password_hash")
        VALUES ('${USER_ID}', 'correction-fanout@bettertrack.test', 'correction_fanout', 'x');
        INSERT INTO "portfolios" ("id", "user_id", "name")
        VALUES ('${PORTFOLIO_2024_ID}', '${USER_ID}', 'Fan-out source');
        INSERT INTO "assets" (
          "id", "provider_id", "provider_ref", "type", "symbol", "name", "currency"
        ) VALUES ('${ASSET_ID}', 'yahoo', 'FAN-OUT', 'stock', 'FO', 'Fan Out', 'EUR');
        INSERT INTO "portfolio_cash_sources" ("id", "portfolio_id", "name", "type", "is_main")
        VALUES ('${CASH_SOURCE_ID}', '${PORTFOLIO_2024_ID}', 'Main', 'cash', true);
        INSERT INTO "transactions" (
          "id", "portfolio_id", "asset_id", "side", "quantity", "price", "executed_at"
        ) VALUES
          ('${TX_2023_ID}', '${PORTFOLIO_2024_ID}', '${ASSET_ID}', 'buy', 1, 10, '2023-06-01T12:00:00Z'),
          ('${TX_2024_ID}', '${PORTFOLIO_2024_ID}', '${ASSET_ID}', 'buy', 1, 10, '2024-06-01T12:00:00Z'),
          ('${TX_2025_ID}', '${PORTFOLIO_2024_ID}', '${ASSET_ID}', 'buy', 1, 10, '2025-06-01T12:00:00Z');
      `);
      await applyMigration(client, FANOUT_TARGET);

      const db = drizzlePglite(client, { schema }) as unknown as Database;
      const taxRepository = createTaxRepository(db);
      const rebaseline = () =>
        client.exec(`
          UPDATE "tax_year_changes" SET "last_changed_at" = '${BASELINE.toISOString()}'
          WHERE "user_id" = '${USER_ID}';
        `);
      const atBaseline = (years: number[]) =>
        years.map((year) => ({ year, lastChangedAt: BASELINE }));

      await rebaseline();
      expect(await taxRepository.listTaxYearChanges(USER_ID)).toEqual(
        atBaseline([2023, 2024, 2025]),
      );

      // A correction posted in January 2025 settles tax year 2024: it marks the
      // year it BELONGS to, never the year it was posted in.
      await client.exec(`
        INSERT INTO "portfolio_cash_movements" (
          "id", "portfolio_id", "source_id", "kind", "amount_eur", "tax_year", "executed_at"
        ) VALUES (
          '${CORRECTION_ID}', '${PORTFOLIO_2024_ID}', '${CASH_SOURCE_ID}',
          'tax_refund', 5, 2024, '2025-01-15T12:00:00Z'
        );
      `);
      const afterCorrection = await taxRepository.listTaxYearChanges(USER_ID);
      expect(afterCorrection.filter(({ year }) => year !== 2024)).toEqual(atBaseline([2023, 2025]));
      expect(
        afterCorrection.find(({ year }) => year === 2024)!.lastChangedAt!.getTime(),
      ).toBeGreaterThan(BASELINE.getTime());

      // A tax leg attached to its parent row stays excluded — the parent's own
      // trigger marks that year.
      await rebaseline();
      await client.exec(`
        INSERT INTO "portfolio_cash_movements" (
          "id", "portfolio_id", "source_id", "kind", "amount_eur",
          "transaction_id", "tax_year", "executed_at"
        ) VALUES (
          '${ATTACHED_TAX_ID}', '${PORTFOLIO_2024_ID}', '${CASH_SOURCE_ID}',
          'tax_withholding', -5, '${TX_2023_ID}', 2023, '2023-06-01T12:00:00Z'
        );
      `);
      expect(await taxRepository.listTaxYearChanges(USER_ID)).toEqual(
        atBaseline([2023, 2024, 2025]),
      );

      // A no-op UPDATE still marks nothing (0099's guard, carried through).
      await client.exec(`
        UPDATE "portfolio_cash_movements" SET "tax_year" = 2024 WHERE "id" = '${CORRECTION_ID}';
      `);
      expect(await taxRepository.listTaxYearChanges(USER_ID)).toEqual(
        atBaseline([2023, 2024, 2025]),
      );

      // Re-attributing a correction marks BOTH sides (OLD 2024, NEW 2023) — and
      // neither is 2025, the year the row is posted in.
      await client.exec(`
        UPDATE "portfolio_cash_movements" SET "tax_year" = 2023 WHERE "id" = '${CORRECTION_ID}';
      `);
      const afterReattribution = await taxRepository.listTaxYearChanges(USER_ID);
      expect(afterReattribution.filter(({ year }) => year === 2025)).toEqual(atBaseline([2025]));
      expect(
        afterReattribution
          .filter(({ year }) => year !== 2025)
          .map(({ year, lastChangedAt }) => [year, lastChangedAt! > BASELINE]),
      ).toEqual([
        [2023, true],
        [2024, true],
      ]);
    } finally {
      await client.close();
    }
  });
});
