import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CASH_SYSTEM_TAGS } from '@bettertrack/contracts';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Migration 0075 (V5 cash fusion) is a DATA migration: the user-scoped
 * `expense_*` island moves onto the portfolio cash ledger as movements + flat
 * multi-tags + portfolio-scoped budgets + tag-assigning rules. The shared test
 * harness only ever replays migrations onto an EMPTY database, which can never
 * exercise a backfill — so this suite boots a throwaway PGlite, applies
 * everything up to 0075, seeds real V5-P9 expense rows, then applies 0075
 * exactly like the drizzle migrator does (statement chunks, one transaction) and
 * asserts the conversion.
 *
 * The money assertion is the point: the signed sum of the migrated movements
 * must equal the signed sum of the source expense rows to the cent, per user.
 */

const drizzleDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const TARGET = '0076_cash_fusion';

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

/** The statement chunks of a migration, exactly as drizzle's migrator splits them. */
function chunks(tag: string): string[] {
  return readFileSync(path.join(drizzleDir, `${tag}.sql`), 'utf8')
    .split(/-->\s*statement-breakpoint\s*/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

/** Apply chunks the way the migrator does: one statement each, one transaction. */
async function applyChunks(client: PGlite, statements: readonly string[]): Promise<void> {
  await client.exec('BEGIN');
  try {
    for (const statement of statements) await client.exec(statement);
    await client.exec('COMMIT');
  } catch (err) {
    await client.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Only the DATA half of 0075 — from the statement that creates the deterministic
 * id helper onwards. The DDL half is not re-runnable (nor is any migration's:
 * drizzle never replays a recorded entry), but the backfill must be, so this is
 * what the "re-running changes nothing" case replays.
 */
function dataChunks(): string[] {
  const all = chunks(TARGET);
  const start = all.findIndex((c) => c.includes('CREATE FUNCTION "bt_cash_fusion_uuid"'));
  expect(start, 'data-migration marker not found in 0075').toBeGreaterThan(0);
  return all.slice(start);
}

const U_MAIN = '019756a0-0075-7000-8000-000000000001';
const U_EMPTY = '019756a0-0075-7000-8000-000000000002';
const U_TAKEN = '019756a0-0075-7000-8000-000000000003';
const C_FOOD = '019756a0-0075-7000-8000-0000000000a1';
const C_FOOD_LOWER = '019756a0-0075-7000-8000-0000000000a2';
const C_SALARY = '019756a0-0075-7000-8000-0000000000a3';
const X_REWE = '019756a0-0075-7000-8000-0000000000b1';
const X_BILLA = '019756a0-0075-7000-8000-0000000000b2';
const X_SALARY = '019756a0-0075-7000-8000-0000000000b3';
const X_USD = '019756a0-0075-7000-8000-0000000000b4';
const X_TAKEN = '019756a0-0075-7000-8000-0000000000b5';
const B_FOOD = '019756a0-0075-7000-8000-0000000000c1';
const B_FOOD_LOWER = '019756a0-0075-7000-8000-0000000000c2';
const R_REWE = '019756a0-0075-7000-8000-0000000000d1';
const P_TAKEN = '019756a0-0075-7000-8000-0000000000e1';

/**
 * The verification query shipped with the migration, as a standalone probe: it
 * returns ONE ROW PER USER whose migrated movements do not reconcile with their
 * source expense rows (count, signed sum, and owning account). An EMPTY result
 * is the proof.
 */
const VERIFICATION_QUERY = `
  SELECT
    x."user_id",
    count(*)                                AS "expense_rows",
    count(p."id")                           AS "migrated_rows",
    sum(CASE x."direction" WHEN 'income' THEN x."amount" ELSE -x."amount" END)::text AS "expected_net",
    coalesce(sum(pm."amount_eur"), 0)::text AS "migrated_net"
  FROM "expense_transactions" x
  LEFT JOIN "portfolio_cash_movements" pm ON pm."id" = x."id"
  LEFT JOIN "portfolios" p ON p."id" = pm."portfolio_id" AND p."user_id" = x."user_id"
  GROUP BY x."user_id"
  HAVING count(*) <> count(p."id")
     OR sum(CASE x."direction" WHEN 'income' THEN x."amount" ELSE -x."amount" END)
        <> coalesce(sum(pm."amount_eur"), 0)
`;

/** Seeded V5-P9 state: three users covering the interesting shapes. */
const SEED = `
  INSERT INTO "users" ("id", "email", "username", "password_hash") VALUES
    ('${U_MAIN}',  'fuse@bettertrack.test',  'fuseuser',  'x'),
    ('${U_EMPTY}', 'empty@bettertrack.test', 'emptyuser', 'x'),
    ('${U_TAKEN}', 'taken@bettertrack.test', 'takenuser', 'x');

  -- U_TAKEN already owns a portfolio literally named "Spending".
  INSERT INTO "portfolios" ("id", "user_id", "name", "sort_order")
    VALUES ('${P_TAKEN}', '${U_TAKEN}', 'Spending', 3);

  -- "Food" and "food" differ only in case: one flat tag, two categories.
  INSERT INTO "expense_categories" ("id", "user_id", "name", "direction", "color", "created_at") VALUES
    ('${C_FOOD}',       '${U_MAIN}', 'Food',   'expense', '#ff0000', '2026-01-01T00:00:00Z'),
    ('${C_FOOD_LOWER}', '${U_MAIN}', 'food',   'expense', '#00ff00', '2026-01-02T00:00:00Z'),
    ('${C_SALARY}',     '${U_MAIN}', 'Salary', 'income',  '#0000ff', '2026-01-03T00:00:00Z');

  INSERT INTO "expense_transactions"
    ("id", "user_id", "category_id", "direction", "amount", "currency", "booked_on", "description", "source", "dedup_hash") VALUES
    ('${X_REWE}',   '${U_MAIN}', '${C_FOOD}',       'expense',   12.34, 'EUR', '2026-01-05', 'REWE Wien',   'manual',       NULL),
    ('${X_BILLA}',  '${U_MAIN}', '${C_FOOD_LOWER}', 'expense',    7.66, 'EUR', '2026-01-06', 'BILLA',       'import:n26',   'hash-billa'),
    ('${X_SALARY}', '${U_MAIN}', '${C_SALARY}',     'income',  2500.00, 'EUR', '2026-01-31', 'Salary Jan',  'manual',       NULL),
    ('${X_USD}',    '${U_MAIN}', NULL,              'expense',   45.00, 'USD', '2026-02-01', 'Amazon US',   'import:n26',   'hash-usd'),
    ('${X_TAKEN}',  '${U_TAKEN}', NULL,             'expense',    9.99, 'EUR', '2026-03-01', 'Kiosk',       'manual',       NULL);

  -- Both budgets target the merged tag; the larger ceiling must survive.
  INSERT INTO "expense_budgets" ("id", "user_id", "category_id", "amount", "currency") VALUES
    ('${B_FOOD}',       '${U_MAIN}', '${C_FOOD}',       300.00, 'EUR'),
    ('${B_FOOD_LOWER}', '${U_MAIN}', '${C_FOOD_LOWER}', 250.00, 'EUR');

  INSERT INTO "expense_budget_fires" ("id", "budget_id", "period_key")
    VALUES (gen_random_uuid(), '${B_FOOD}', '2026-01');

  INSERT INTO "expense_rules" ("id", "user_id", "category_id", "match_type", "pattern", "priority")
    VALUES ('${R_REWE}', '${U_MAIN}', '${C_FOOD}', 'contains', 'REWE', 5);
`;

/** Signed net of U_MAIN's five seeded magnitudes: -12.34 -7.66 +2500.00 -45.00. */
const U_MAIN_NET = 2435;

describe('migration 0076_cash_fusion — expenses become portfolio cash', () => {
  let client: PGlite;

  beforeAll(async () => {
    client = new PGlite({ extensions: { pg_trgm } });
    const tags = migrationTags();
    expect(tags).toContain(TARGET);
    for (const tag of tags) {
      if (tag === TARGET) break;
      await applyChunks(client, chunks(tag));
    }
    await client.exec(SEED);
    await applyChunks(client, chunks(TARGET));
  }, 120_000);

  it('reconciles every user to the cent (the shipped verification query returns nothing)', async () => {
    const mismatches = await client.query(VERIFICATION_QUERY);
    expect(mismatches.rows).toEqual([]);
  });

  it('creates exactly one cash-only Spending portfolio per user with expense rows', async () => {
    const rows = await client.query<{ user_id: string; name: string; sort_order: number }>(
      `SELECT "user_id", "name", "sort_order" FROM "portfolios" WHERE "id" <> '${P_TAKEN}' ORDER BY "user_id"`,
    );
    expect(rows.rows).toEqual([
      { user_id: U_MAIN, name: 'Spending', sort_order: 1 },
      // U_TAKEN's own "Spending" is untouched; the migration takes the next free name.
      { user_id: U_TAKEN, name: 'Spending 2', sort_order: 4 },
    ]);
  });

  it('gives a user with no expense rows no Spending portfolio at all', async () => {
    const rows = await client.query(
      `SELECT 1 FROM "portfolios" WHERE "user_id" = '${U_EMPTY}'
       UNION ALL SELECT 1 FROM "portfolio_cash_movements" pm
         JOIN "portfolios" p ON p."id" = pm."portfolio_id" WHERE p."user_id" = '${U_EMPTY}'`,
    );
    expect(rows.rows).toEqual([]);
  });

  it('provisions the Spending portfolio with its own Main cash source', async () => {
    const rows = await client.query<{ name: string; type: string; is_main: boolean }>(
      `SELECT s."name", s."type", s."is_main" FROM "portfolio_cash_sources" s
       JOIN "portfolios" p ON p."id" = s."portfolio_id" WHERE p."user_id" = '${U_MAIN}'`,
    );
    expect(rows.rows).toEqual([{ name: 'Main', type: 'cash', is_main: true }]);
  });

  it('maps direction onto the ledger sign convention and keeps the balance exact', async () => {
    const rows = await client.query<{
      id: string;
      kind: string;
      amount_eur: string;
      executed_at: string;
      note: string;
      source: string;
      dedup_hash: string | null;
      original_currency: string | null;
    }>(
      `SELECT pm."id", pm."kind", pm."amount_eur"::text, pm."executed_at"::text,
              pm."note", pm."source", pm."dedup_hash", pm."original_currency"
       FROM "portfolio_cash_movements" pm
       JOIN "portfolios" p ON p."id" = pm."portfolio_id"
       WHERE p."user_id" = '${U_MAIN}' ORDER BY pm."executed_at"`,
    );
    expect(rows.rows).toEqual([
      {
        id: X_REWE,
        kind: 'withdrawal',
        amount_eur: '-12.340000',
        executed_at: '2026-01-05 00:00:00+00',
        note: 'REWE Wien',
        source: 'manual',
        dedup_hash: null,
        original_currency: null,
      },
      {
        id: X_BILLA,
        kind: 'withdrawal',
        amount_eur: '-7.660000',
        executed_at: '2026-01-06 00:00:00+00',
        note: 'BILLA',
        source: 'import:n26',
        dedup_hash: 'hash-billa',
        original_currency: null,
      },
      {
        id: X_SALARY,
        kind: 'deposit',
        amount_eur: '2500.000000',
        executed_at: '2026-01-31 00:00:00+00',
        note: 'Salary Jan',
        source: 'manual',
        dedup_hash: null,
        original_currency: null,
      },
      {
        id: X_USD,
        kind: 'withdrawal',
        amount_eur: '-45.000000',
        executed_at: '2026-02-01 00:00:00+00',
        note: 'Amazon US',
        source: 'import:n26',
        dedup_hash: 'hash-usd',
        // Carried 1:1 (the expense area never converted either) and marked for FX.
        original_currency: 'USD',
      },
    ]);
    const balance = await client.query<{ balance: string }>(
      `SELECT sum(pm."amount_eur")::text AS "balance" FROM "portfolio_cash_movements" pm
       JOIN "portfolios" p ON p."id" = pm."portfolio_id" WHERE p."user_id" = '${U_MAIN}'`,
    );
    expect(Number(balance.rows[0]?.balance)).toBe(U_MAIN_NET);
  });

  it('seeds the app-owned system tags for every user, exactly as the contract defines them', async () => {
    const rows = await client.query<{
      system_key: string;
      name: string;
      color: string;
      system: boolean;
    }>(
      `SELECT "system_key", "name", "color", "system" FROM "cash_tags"
       WHERE "user_id" = '${U_EMPTY}' ORDER BY "system_key"`,
    );
    // The contract's CASH_SYSTEM_TAGS is the single source of truth for both the
    // migration's seed and the tag service's; this is the drift guard between them.
    const expected = [...CASH_SYSTEM_TAGS]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((t) => ({ system_key: t.key, name: t.name, color: t.color, system: true }));
    expect(rows.rows).toEqual(expected);
    // Every user gets the same set, including the one with no expense rows at all.
    const counts = await client.query<{ user_id: string; n: number }>(
      `SELECT "user_id", count(*)::int AS "n" FROM "cash_tags" WHERE "system" GROUP BY "user_id"`,
    );
    expect(counts.rows).toHaveLength(3);
    expect(counts.rows.every((r) => r.n === CASH_SYSTEM_TAGS.length)).toBe(true);
  });

  it('collapses case-colliding categories into ONE flat tag, oldest wins', async () => {
    const rows = await client.query<{ id: string; name: string; color: string }>(
      `SELECT "id", "name", "color" FROM "cash_tags"
       WHERE "user_id" = '${U_MAIN}' AND NOT "system" ORDER BY "name"`,
    );
    expect(rows.rows).toEqual([
      // "food" (created later) merged into "Food"; its colour is the survivor's.
      { id: C_FOOD, name: 'Food', color: '#ff0000' },
      { id: C_SALARY, name: 'Salary', color: '#0000ff' },
    ]);
  });

  it('tags each migrated movement with its category, leaving null-category rows untagged', async () => {
    const rows = await client.query<{ movement_id: string; tag_id: string }>(
      `SELECT "movement_id", "tag_id" FROM "cash_movement_tags" ORDER BY "movement_id"`,
    );
    expect(rows.rows).toEqual([
      { movement_id: X_REWE, tag_id: C_FOOD },
      { movement_id: X_BILLA, tag_id: C_FOOD },
      { movement_id: X_SALARY, tag_id: C_SALARY },
    ]);
    // X_USD had no category and X_TAKEN none either — neither invents a tag.
    expect(rows.rows.some((r) => r.movement_id === X_USD)).toBe(false);
    expect(rows.rows.some((r) => r.movement_id === X_TAKEN)).toBe(false);
  });

  it('moves budgets into the Spending portfolio as recurring targets, larger ceiling winning', async () => {
    const rows = await client.query<{
      id: string;
      tag_id: string;
      period_key: string | null;
      amount: string;
      user_id: string;
    }>(
      `SELECT b."id", b."tag_id", b."period_key", b."amount"::text, p."user_id"
       FROM "cash_budgets" b JOIN "portfolios" p ON p."id" = b."portfolio_id"`,
    );
    expect(rows.rows).toEqual([
      {
        id: B_FOOD,
        tag_id: C_FOOD,
        // NULL period = the recurring monthly target `expense_budgets` always was.
        period_key: null,
        amount: '300.00',
        user_id: U_MAIN,
      },
    ]);
  });

  it('carries the per-period fired markers so no month re-alerts', async () => {
    const rows = await client.query<{ budget_id: string; period_key: string }>(
      `SELECT "budget_id", "period_key" FROM "cash_budget_fires"`,
    );
    expect(rows.rows).toEqual([{ budget_id: B_FOOD, period_key: '2026-01' }]);
  });

  it('moves rules with their priority and gives them their tag set', async () => {
    const rules = await client.query<{
      id: string;
      user_id: string;
      match_type: string;
      pattern: string;
      priority: number;
      enabled: boolean;
    }>(`SELECT "id", "user_id", "match_type", "pattern", "priority", "enabled" FROM "cash_rules"`);
    expect(rules.rows).toEqual([
      {
        id: R_REWE,
        user_id: U_MAIN,
        match_type: 'contains',
        pattern: 'REWE',
        priority: 5,
        enabled: true,
      },
    ]);
    const ruleTags = await client.query<{ rule_id: string; tag_id: string }>(
      `SELECT "rule_id", "tag_id" FROM "cash_rule_tags"`,
    );
    expect(ruleTags.rows).toEqual([{ rule_id: R_REWE, tag_id: C_FOOD }]);
  });

  it('leaves the expense_* tables completely untouched (the routes keep working)', async () => {
    const rows = await client.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM "expense_transactions")
            + (SELECT count(*) FROM "expense_categories")
            + (SELECT count(*) FROM "expense_budgets")
            + (SELECT count(*) FROM "expense_rules")
            + (SELECT count(*) FROM "expense_budget_fires") AS "n"`,
    );
    expect(Number(rows.rows[0]?.n)).toBe(5 + 3 + 2 + 1 + 1);
  });

  it('is idempotent — replaying the backfill changes not one row', async () => {
    const fingerprint = async (): Promise<string> => {
      const agg = (select: string, from: string): string =>
        `(SELECT coalesce(string_agg(t."x", '|' ORDER BY t."x"), '') FROM (SELECT ${select} AS "x" FROM ${from}) t)`;
      const r = await client.query<{ f: string }>(
        `SELECT ${[
          agg(
            `"id"::text || ':' || "portfolio_id"::text || ':' || "source_id"::text || ':' || "kind"
           || ':' || "amount_eur"::text || ':' || "executed_at"::text || ':' || coalesce("note", '-')
           || ':' || "source" || ':' || coalesce("dedup_hash", '-') || ':' || coalesce("original_currency", '-')`,
            '"portfolio_cash_movements"',
          ),
          agg(
            `"id"::text || ':' || "user_id"::text || ':' || "name" || ':' || "color" || ':' ||
           "system"::text || ':' || coalesce("system_key", '-')`,
            '"cash_tags"',
          ),
          agg(`"movement_id"::text || ':' || "tag_id"::text`, '"cash_movement_tags"'),
          agg(
            `"id"::text || ':' || "portfolio_id"::text || ':' || "tag_id"::text || ':' ||
           "amount"::text || ':' || coalesce("period_key", '-')`,
            '"cash_budgets"',
          ),
          agg(`"budget_id"::text || ':' || "period_key"`, '"cash_budget_fires"'),
          agg(
            `"id"::text || ':' || "user_id"::text || ':' || "pattern" || ':' || "priority"::text`,
            '"cash_rules"',
          ),
          agg(`"rule_id"::text || ':' || "tag_id"::text`, '"cash_rule_tags"'),
          agg(
            `"id"::text || ':' || "user_id"::text || ':' || "name" || ':' || "sort_order"::text`,
            '"portfolios"',
          ),
          agg(
            `"id"::text || ':' || "portfolio_id"::text || ':' || "name"`,
            '"portfolio_cash_sources"',
          ),
        ].join(` || '#' || `)} AS "f"`,
      );
      return r.rows[0]!.f;
    };

    const before = await fingerprint();
    await applyChunks(client, dataChunks());
    expect(await fingerprint()).toBe(before);
    // …and it still reconciles after the replay.
    expect((await client.query(VERIFICATION_QUERY)).rows).toEqual([]);
  });

  it('aborts instead of committing a sign error (the ledger CHECK is the backstop)', async () => {
    await expect(
      client.query(
        `INSERT INTO "portfolio_cash_movements"
           ("id", "portfolio_id", "source_id", "kind", "amount_eur", "executed_at")
         SELECT gen_random_uuid(), pm."portfolio_id", pm."source_id", 'withdrawal', 12.34, now()
         FROM "portfolio_cash_movements" pm WHERE pm."id" = '${X_REWE}'`,
      ),
    ).rejects.toThrow(/portfolio_cash_movements_sign/);
  });
});
