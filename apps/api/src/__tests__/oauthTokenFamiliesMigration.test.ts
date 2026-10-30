import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * 0119_oauth_token_families — the per-install token-family table, the NULLABLE
 * `family_id` columns and the legacy-family backfill (§16 2026-10-29).
 *
 * The shared harness only ever replays migrations onto an EMPTY database, so —
 * like the 0029/0076 data-migration suites — this boots a throwaway database,
 * applies everything BEFORE 0119, seeds the production-shaped pre-state (two
 * users, an active grant with a rotated chain, a REVOKED grant with tokens, a
 * grant with no tokens at all), then applies 0119 exactly as drizzle's migrator
 * does (its statement chunks, one transaction). The same scenarios run on
 * PGlite in the fast suite and, when `TEST_DATABASE_URL` is set (CI's
 * integration job, `vitest.config.integration.ts`), on a real Postgres 17
 * database created for this file and dropped afterwards.
 */

const drizzleDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const TARGET = '0119_oauth_token_families';
const REAL_DATABASE_URL = process.env.TEST_DATABASE_URL;

const U1 = '019a0119-0000-7000-8000-000000000001';
const U2 = '019a0119-0000-7000-8000-000000000002';
const C1 = '019a0119-0000-7000-8000-0000000000c1';
const C2 = '019a0119-0000-7000-8000-0000000000c2';
/** Active grant with a rotated refresh chain and two access tokens. */
const G_ACTIVE = '019a0119-0000-7000-8000-0000000000a1';
/** Revoked grant that still has rows — it gets a family too (the grant flag keeps them dead). */
const G_REVOKED = '019a0119-0000-7000-8000-0000000000a2';
/** Grant with no token rows at all. */
const G_EMPTY = '019a0119-0000-7000-8000-0000000000a3';
const R_CONSUMED = '019a0119-0000-7000-8000-0000000000b1';
const R_LIVE = '019a0119-0000-7000-8000-0000000000b2';
const R_REVOKED_GRANT = '019a0119-0000-7000-8000-0000000000b3';
const A_OLD = '019a0119-0000-7000-8000-0000000000d1';
const A_LIVE = '019a0119-0000-7000-8000-0000000000d2';
const A_REVOKED_GRANT = '019a0119-0000-7000-8000-0000000000d3';

/** The minimal surface both engines provide for this file. */
interface Engine {
  exec(statement: string): Promise<void>;
  rows<T>(statement: string): Promise<T[]>;
  /** Apply one migration file the way drizzle does: its chunks, one transaction. */
  apply(tag: string): Promise<void>;
  close(): Promise<void>;
}

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

function migrationChunks(tag: string): string[] {
  return readFileSync(path.join(drizzleDir, `${tag}.sql`), 'utf8')
    .split(/-->\s*statement-breakpoint\s*/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

async function pgliteEngine(): Promise<Engine> {
  const client = new PGlite({ extensions: { pg_trgm } });
  return {
    exec: async (statement) => {
      await client.exec(statement);
    },
    rows: async <T>(statement: string) => (await client.query<T>(statement)).rows,
    apply: async (tag) => {
      await client.exec('BEGIN');
      try {
        for (const chunk of migrationChunks(tag)) await client.exec(chunk);
        await client.exec('COMMIT');
      } catch (err) {
        await client.exec('ROLLBACK');
        throw err;
      }
    },
    close: () => client.close(),
  };
}

/** A throwaway database on the CI Postgres (the `bt` role is its superuser). */
async function realPostgresEngine(baseUrl: string): Promise<Engine> {
  const name = `bt_mig_0119_${randomBytes(6).toString('hex')}`;
  const admin = postgres(baseUrl, { max: 1, onnotice: () => {} });
  // `name` is built above from a fixed prefix and hex — never user input.
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const client = postgres(url.toString(), { max: 1, onnotice: () => {} });
  return {
    exec: async (statement) => {
      await client.unsafe(statement);
    },
    rows: async <T>(statement: string) => (await client.unsafe(statement)) as unknown as T[],
    apply: async (tag) => {
      await client.begin(async (tx) => {
        for (const chunk of migrationChunks(tag)) await tx.unsafe(chunk);
      });
    },
    close: async () => {
      await client.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
}

/** Replay every migration BEFORE the target — the state prod is in when 0119 runs. */
async function bootBefore0119(engine: Engine): Promise<void> {
  const tags = migrationTags();
  expect(tags).toContain(TARGET);
  for (const tag of tags) {
    if (tag === TARGET) break;
    await engine.apply(tag);
  }
}

/** The production-shaped pre-state, written with the pre-0119 column set. */
async function seedPreState(engine: Engine): Promise<void> {
  const future = "now() + interval '30 days'";
  await engine.exec(`
    INSERT INTO "users" ("id", "email", "username", "password_hash") VALUES
      ('${U1}', 'families1@bettertrack.test', 'families1', 'x'),
      ('${U2}', 'families2@bettertrack.test', 'families2', 'x');
    INSERT INTO "oauth_clients" ("id", "user_id", "client_id", "name", "redirect_uris", "scopes", "is_public") VALUES
      ('${C1}', '${U1}', 'btc_families_one', 'One', ARRAY['https://one.example/cb'], ARRAY['portfolio:read'], true),
      ('${C2}', '${U1}', 'btc_families_two', 'Two', ARRAY['https://two.example/cb'], ARRAY['portfolio:read'], true);
    INSERT INTO "oauth_grants" ("id", "client_id", "user_id", "scopes", "created_at", "last_used_at", "revoked_at") VALUES
      ('${G_ACTIVE}',  '${C1}', '${U1}', ARRAY['portfolio:read'], '2026-05-01T08:00:00Z', '2026-10-20T12:00:00Z', NULL),
      ('${G_REVOKED}', '${C1}', '${U2}', ARRAY['portfolio:read'], '2026-06-01T08:00:00Z', NULL, '2026-07-01T08:00:00Z'),
      ('${G_EMPTY}',   '${C2}', '${U2}', ARRAY['portfolio:read'], '2026-07-15T08:00:00Z', NULL, NULL);
    INSERT INTO "oauth_refresh_tokens" ("id", "grant_id", "token_hash", "expires_at", "consumed_at") VALUES
      ('${R_LIVE}',          '${G_ACTIVE}',  'hash-r-live',     ${future}, NULL),
      ('${R_CONSUMED}',      '${G_ACTIVE}',  'hash-r-consumed', ${future}, now() - interval '1 day'),
      ('${R_REVOKED_GRANT}', '${G_REVOKED}', 'hash-r-revoked',  ${future}, NULL);
    UPDATE "oauth_refresh_tokens" SET "successor_id" = '${R_LIVE}' WHERE "id" = '${R_CONSUMED}';
    INSERT INTO "oauth_access_tokens" ("id", "grant_id", "token_hash", "scopes", "expires_at") VALUES
      ('${A_OLD}',           '${G_ACTIVE}',  'hash-a-old',     ARRAY['portfolio:read'], now() - interval '1 day'),
      ('${A_LIVE}',          '${G_ACTIVE}',  'hash-a-live',    ARRAY['portfolio:read'], now() + interval '1 hour'),
      ('${A_REVOKED_GRANT}', '${G_REVOKED}', 'hash-a-revoked', ARRAY['portfolio:read'], now() + interval '1 hour');
  `);
}

interface FamilyRow {
  id: string;
  grant_id: string;
  instance_id: string | null;
  created_at: Date | string;
  last_used_at: Date | string | null;
  revoked_at: Date | string | null;
  revoked_reason: string | null;
}

interface TokenFamilyRow {
  id: string;
  grant_id: string;
  family_id: string | null;
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

async function families(engine: Engine): Promise<FamilyRow[]> {
  return engine.rows<FamilyRow>(
    `SELECT "id", "grant_id", "instance_id", "created_at", "last_used_at", "revoked_at", "revoked_reason"
     FROM "oauth_token_families" ORDER BY "grant_id", "id"`,
  );
}

async function tokenFamilies(engine: Engine, table: string): Promise<TokenFamilyRow[]> {
  // `table` is one of the two literal token-table names passed below.
  return engine.rows<TokenFamilyRow>(
    `SELECT "id", "grant_id", "family_id" FROM "${table}" ORDER BY "id"`,
  );
}

/** The scenario list, run once per engine. */
function migrationScenarios(open: () => Promise<Engine>) {
  let engine: Engine;

  beforeAll(async () => {
    engine = await open();
    await bootBefore0119(engine);
    await seedPreState(engine);
    await engine.apply(TARGET);
  }, 240_000);

  afterAll(async () => {
    await engine?.close();
  });

  it('gives EVERY grant — revoked and token-less ones included — exactly one legacy family', async () => {
    const rows = await families(engine);
    expect(rows.map((row) => row.grant_id).sort()).toEqual([G_ACTIVE, G_REVOKED, G_EMPTY].sort());
    const byGrant = new Map(rows.map((row) => [row.grant_id, row]));
    // created_at / last_used_at are copied from the grant; nothing is revoked or
    // instance-bound — the grant flag alone keeps G_REVOKED's tokens dead.
    expect(iso(byGrant.get(G_ACTIVE)!.created_at)).toBe('2026-05-01T08:00:00.000Z');
    expect(iso(byGrant.get(G_ACTIVE)!.last_used_at)).toBe('2026-10-20T12:00:00.000Z');
    expect(iso(byGrant.get(G_REVOKED)!.created_at)).toBe('2026-06-01T08:00:00.000Z');
    for (const row of rows) {
      expect(row.instance_id).toBeNull();
      expect(row.revoked_at).toBeNull();
      expect(row.revoked_reason).toBeNull();
    }
  });

  it("attaches every refresh and access token to its OWN grant's family", async () => {
    const familyOf = new Map((await families(engine)).map((row) => [row.grant_id, row.id]));
    const refresh = await tokenFamilies(engine, 'oauth_refresh_tokens');
    const access = await tokenFamilies(engine, 'oauth_access_tokens');
    expect(refresh.map((row) => row.id).sort()).toEqual(
      [R_CONSUMED, R_LIVE, R_REVOKED_GRANT].sort(),
    );
    expect(access.map((row) => row.id).sort()).toEqual([A_OLD, A_LIVE, A_REVOKED_GRANT].sort());
    for (const row of [...refresh, ...access]) {
      expect(row.family_id, row.id).toBe(familyOf.get(row.grant_id));
    }
    // A consumed row and its live successor share one family (one legacy chain).
    const byId = new Map(refresh.map((row) => [row.id, row.family_id]));
    expect(byId.get(R_CONSUMED)).toBe(byId.get(R_LIVE));
  });

  it('leaves family_id NULLABLE so the still-serving old code can insert (no deploy gap)', async () => {
    const columns = await engine.rows<{ table_name: string; is_nullable: string }>(
      `SELECT "table_name", "is_nullable" FROM information_schema.columns
       WHERE "column_name" = 'family_id'
         AND "table_name" IN ('oauth_refresh_tokens', 'oauth_access_tokens')
       ORDER BY "table_name"`,
    );
    expect(columns).toEqual([
      { table_name: 'oauth_access_tokens', is_nullable: 'YES' },
      { table_name: 'oauth_refresh_tokens', is_nullable: 'YES' },
    ]);
    // Exactly the old code's insert: no family column at all.
    await engine.exec(`
      INSERT INTO "oauth_refresh_tokens" ("grant_id", "id", "token_hash", "expires_at")
      VALUES ('${G_ACTIVE}', '019a0119-0000-7000-8000-0000000000e1', 'hash-old-code', now() + interval '30 days');
    `);
    const [row] = await engine.rows<{ family_id: string | null }>(
      `SELECT "family_id" FROM "oauth_refresh_tokens" WHERE "id" = '019a0119-0000-7000-8000-0000000000e1'`,
    );
    expect(row!.family_id).toBeNull();
    await engine.exec(
      `DELETE FROM "oauth_refresh_tokens" WHERE "id" = '019a0119-0000-7000-8000-0000000000e1'`,
    );
  });

  it('is a no-op when re-run: same families, same attachments', async () => {
    const familiesBefore = await families(engine);
    const refreshBefore = await tokenFamilies(engine, 'oauth_refresh_tokens');
    const accessBefore = await tokenFamilies(engine, 'oauth_access_tokens');

    await engine.apply(TARGET);
    await engine.apply(TARGET);

    expect(await families(engine)).toEqual(familiesBefore);
    expect(await tokenFamilies(engine, 'oauth_refresh_tokens')).toEqual(refreshBefore);
    expect(await tokenFamilies(engine, 'oauth_access_tokens')).toEqual(accessBefore);
  });

  it('enforces the instance-id shape, the closed reason list and revoked_at ⇔ revoked_reason', async () => {
    const insertFamily = (columns: string, values: string) =>
      engine.exec(
        `INSERT INTO "oauth_token_families" ("id", "grant_id"${columns}) VALUES (gen_random_uuid(), '${G_ACTIVE}'${values})`,
      );
    await expect(insertFamily(', "instance_id"', ", 'too-short'")).rejects.toThrow(
      /oauth_token_families_instance_id_shape/,
    );
    await expect(insertFamily(', "instance_id"', ", 'has a space in it!!!!'")).rejects.toThrow(
      /oauth_token_families_instance_id_shape/,
    );
    await expect(
      insertFamily(', "revoked_at", "revoked_reason"', ", now(), 'concurrent'"),
    ).rejects.toThrow(/oauth_token_families_revoked_reason_known/);
    await expect(insertFamily(', "revoked_at"', ', now()')).rejects.toThrow(
      /oauth_token_families_revocation_complete/,
    );
    await expect(insertFamily(', "revoked_reason"', ", 'logout'")).rejects.toThrow(
      /oauth_token_families_revocation_complete/,
    );
  });

  it('holds at most ONE live family per (grant, instance_id); a revoked one frees the slot', async () => {
    const instance = 'install-0119-abcdefgh';
    await engine.exec(
      `INSERT INTO "oauth_token_families" ("id", "grant_id", "instance_id") VALUES
         ('019a0119-0000-7000-8000-0000000000f1', '${G_ACTIVE}', '${instance}')`,
    );
    await expect(
      engine.exec(
        `INSERT INTO "oauth_token_families" ("id", "grant_id", "instance_id") VALUES
           ('019a0119-0000-7000-8000-0000000000f2', '${G_ACTIVE}', '${instance}')`,
      ),
    ).rejects.toThrow(/oauth_token_families_live_instance_unique/);
    // The same instance on ANOTHER grant is a different install slot.
    await engine.exec(
      `INSERT INTO "oauth_token_families" ("id", "grant_id", "instance_id") VALUES
         ('019a0119-0000-7000-8000-0000000000f3', '${G_EMPTY}', '${instance}')`,
    );
    await engine.exec(
      `UPDATE "oauth_token_families" SET "revoked_at" = now(), "revoked_reason" = 'relogin'
       WHERE "id" = '019a0119-0000-7000-8000-0000000000f1'`,
    );
    await engine.exec(
      `INSERT INTO "oauth_token_families" ("id", "grant_id", "instance_id") VALUES
         ('019a0119-0000-7000-8000-0000000000f2', '${G_ACTIVE}', '${instance}')`,
    );
  });

  it('cascades a grant delete through its families to their token rows', async () => {
    await engine.exec(`DELETE FROM "oauth_grants" WHERE "id" = '${G_REVOKED}'`);
    expect((await families(engine)).filter((row) => row.grant_id === G_REVOKED)).toHaveLength(0);
    const [orphans] = await engine.rows<{ n: number | string }>(
      `SELECT count(*) AS n FROM "oauth_refresh_tokens" WHERE "id" = '${R_REVOKED_GRANT}'`,
    );
    expect(Number(orphans!.n)).toBe(0);
  });
}

describe('0119 oauth token families migration (PGlite)', () => {
  migrationScenarios(pgliteEngine);
});

describe.skipIf(!REAL_DATABASE_URL)('0119 oauth token families migration (real Postgres)', () => {
  migrationScenarios(() => realPostgresEngine(REAL_DATABASE_URL!));
});
