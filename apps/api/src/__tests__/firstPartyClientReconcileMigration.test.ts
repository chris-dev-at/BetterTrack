import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../data/db';
import { createOAuthRepository } from '../data/repositories/oauthRepository';
import * as schema from '../data/schema';
import { FIRST_PARTY_CLIENTS, seedFirstPartyClients } from '../services/oauth/firstPartyClients';

/**
 * The first-party-client reconcile migrations self-heal the BetterTrackMobile OAuth
 * client on EVERY deploy — prod's auto-updater runs migrate.js but never seed.js, so
 * the #398 boot-seed never fires there and a stale restore keeps the client behind
 * (#386, #395, #405). Each migration must reproduce the seed's union-only convergence
 * purely in SQL: never narrow, only widen toward the canonical ceiling.
 *
 *   - 0029 (`0029_first_party_client_reconcile`) create-if-missing at its frozen
 *     12-scope ceiling, else widen scopes/redirect URIs — heals prod's missing chat
 *     scopes.
 *   - 0030 (`0030_first_party_client_alerts_scopes`) unions the two #405 alerts
 *     scopes on top, because PR #423 added them to the code ceiling but the prod
 *     migrate-only updater would otherwise never carry them (seed re-copy pending).
 *
 * The shared harness only ever replays migrations onto an empty DB (and truncates),
 * so — exactly like the 0019 / 0024 data-migration suites — this boots a throwaway
 * PGlite, applies everything UP TO the target, seeds a pre-state, then applies the
 * target like the drizzle migrator would.
 */

const drizzleDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const TARGET_0029 = '0029_first_party_client_reconcile';
const TARGET_0030 = '0030_first_party_client_alerts_scopes';

const MOBILE = FIRST_PARTY_CLIENTS.find((c) => c.clientId === 'btc_IbT1mzw_7kBiPHPkGfaE0Q')!;
const CLIENT_ID = MOBILE.clientId;
const CEILING = [...MOBILE.scopeCeiling];
const CANONICAL_URI = MOBILE.redirectUris[0]!;

/**
 * The exact scope payload migration 0029 hard-codes — the canonical ceiling as of
 * #398, frozen in SQL. Scopes appended to the definition AFTER 0029 (alerts:read /
 * alerts:write, #405) are deliberately NOT carried by this historical migration:
 * migration 0030 carries them through the same migrate-only deploy channel (see
 * {@link ALERTS_SCOPES}). So 0029 converges a row to THIS set and 0030 does the last
 * mile — the two together reach the full live {@link CEILING} without ever fighting,
 * and the idempotent boot-seed is then a no-op. Kept as a literal (not derived from
 * the live definition) precisely so it stays pinned to what 0029 wrote.
 */
const RECONCILE_SCOPES = [
  'portfolio:read',
  'portfolio:write',
  'workboard:read',
  'workboard:write',
  'market:read',
  'social:read',
  'social:write',
  'notifications:read',
  'notifications:write',
  'chat:read',
  'chat:write',
  'account:security',
];

/**
 * The exact scopes migration 0030 unions on top of 0029's payload — the two #405
 * price-alerts scopes, frozen in SQL. Pinned as a literal (not derived) so the test
 * asserts what 0030 actually writes; the {@link CEILING} canary below proves the
 * migration chain (0029 ∪ 0030) still equals the full live definition.
 */
const ALERTS_SCOPES = ['alerts:read', 'alerts:write'];

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

/**
 * Boot a throwaway PGlite and replay every migration BEFORE `stopTag` (exclusive) —
 * the state a prod DB is in the moment before `stopTag` runs.
 */
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

interface ClientRow {
  id: string;
  user_id: string | null;
  client_id: string;
  name: string;
  client_secret_hash: string | null;
  redirect_uris: string[];
  scopes: string[];
  is_public: boolean;
  is_first_party: boolean;
  created_at: string;
}

async function readClient(client: PGlite, clientId: string): Promise<ClientRow | null> {
  const res = await client.query<ClientRow>(
    `SELECT "id","user_id","client_id","name","client_secret_hash","redirect_uris","scopes","is_public","is_first_party","created_at"
       FROM "oauth_clients" WHERE "client_id" = $1`,
    [clientId],
  );
  return res.rows[0] ?? null;
}

describe(`migration ${TARGET_0029} — first-party client reconcile (union-only)`, () => {
  let client: PGlite;

  beforeEach(async () => {
    // Replay every migration up to (not including) 0029 — the state a prod DB is in
    // the moment before this migration runs.
    client = await bootUpTo(TARGET_0029);
  });

  it('INSERTs the full canonical row when the client is missing (fresh/restored DB)', async () => {
    expect(await readClient(client, CLIENT_ID)).toBeNull();

    await applyMigration(client, TARGET_0029);

    const row = (await readClient(client, CLIENT_ID))!;
    expect(row).not.toBeNull();
    expect(row.name).toBe('BetterTrackMobile');
    expect(row.scopes).toEqual(RECONCILE_SCOPES); // 0029's frozen canonical payload
    expect(row.redirect_uris).toEqual([CANONICAL_URI]);
    expect(row.is_public).toBe(true); // public / PKCE
    expect(row.is_first_party).toBe(true);
    expect(row.client_secret_hash).toBeNull(); // no secret
    expect(row.user_id).toBeNull(); // system-owned
  });

  it('widens an existing NARROWER row to the ceiling without narrowing, preserving extras', async () => {
    // A stale prod-style row: pre-chat scopes, an admin-added extra scope outside
    // the ceiling, and only an admin-added redirect URI (missing the canonical).
    const existingScopes = ['portfolio:read', 'workboard:read', 'experimental:beta'];
    const adminUri = 'https://example.com/admin-added-cb';
    await client.exec(`
      INSERT INTO "oauth_clients"
        ("id","user_id","client_id","name","client_secret_hash","redirect_uris","scopes","is_public","is_first_party")
      VALUES (
        gen_random_uuid(), NULL, '${CLIENT_ID}', 'BetterTrackMobile', NULL,
        ARRAY['${adminUri}']::text[],
        ARRAY['${existingScopes.join("','")}']::text[],
        true, true
      );
    `);
    const before = (await readClient(client, CLIENT_ID))!;

    await applyMigration(client, TARGET_0029);

    const row = (await readClient(client, CLIENT_ID))!;
    // Never narrows: every scope 0029 carries is now present…
    for (const scope of RECONCILE_SCOPES) expect(row.scopes).toContain(scope);
    // …the admin extra survived…
    expect(row.scopes).toContain('experimental:beta');
    // …existing entries kept their positions (append-only union)…
    expect(row.scopes.slice(0, existingScopes.length)).toEqual(existingScopes);
    // …no duplicates…
    expect(new Set(row.scopes).size).toBe(row.scopes.length);
    // …redirect URIs union: admin's first, canonical appended.
    expect(row.redirect_uris).toEqual([adminUri, CANONICAL_URI]);
    // Identity + immutable fields untouched (never recreated, never rewritten).
    expect(row.id).toBe(before.id);
    expect(row.created_at).toEqual(before.created_at);
    expect(row.name).toBe('BetterTrackMobile');
    expect(row.is_public).toBe(true);
    expect(row.is_first_party).toBe(true);
    expect(row.client_secret_hash).toBeNull();
  });

  it('is a true no-op on the second run (idempotent)', async () => {
    await applyMigration(client, TARGET_0029); // INSERT path
    const first = (await readClient(client, CLIENT_ID))!;

    await applyMigration(client, TARGET_0029); // must change nothing
    const second = (await readClient(client, CLIENT_ID))!;

    expect(second.id).toBe(first.id); // not recreated
    expect(second.created_at).toEqual(first.created_at);
    expect(second.scopes).toEqual(first.scopes);
    expect(second.redirect_uris).toEqual(first.redirect_uris);

    // And exactly one row exists — the guard never duplicated the client.
    const count = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM "oauth_clients" WHERE "client_id" = $1`,
      [CLIENT_ID],
    );
    expect(count.rows[0]!.n).toBe(1);
  });
});

describe(`migration ${TARGET_0030} — first-party client alerts scopes (union-only)`, () => {
  let client: PGlite;

  beforeEach(async () => {
    // Replay through 0029 — the exact state a prod DB is in the moment before 0030
    // runs. 0029 has already create-if-missing'd the row at its frozen 12-scope
    // payload, so 0030 always meets an existing row (a pure additive UPDATE).
    client = await bootUpTo(TARGET_0030);
  });

  it('unions exactly the two #405 alerts scopes onto the 0029 row, reaching the canonical ceiling', async () => {
    const before = (await readClient(client, CLIENT_ID))!;
    expect(before.scopes).toEqual(RECONCILE_SCOPES); // 0029 left it at the frozen 12

    await applyMigration(client, TARGET_0030);

    const row = (await readClient(client, CLIENT_ID))!;
    // Exactly the two alerts scopes were appended, in canonical order…
    expect(row.scopes).toEqual([...RECONCILE_SCOPES, ...ALERTS_SCOPES]);
    // …which is precisely the full live FIRST_PARTY_CLIENTS ceiling.
    expect(row.scopes).toEqual(CEILING);
    expect(row.scopes.length).toBe(RECONCILE_SCOPES.length + ALERTS_SCOPES.length);
    // Nothing else widened: redirect URIs and identity/immutable fields untouched.
    expect(row.redirect_uris).toEqual([CANONICAL_URI]);
    expect(row.id).toBe(before.id); // same row, never recreated
    expect(row.created_at).toEqual(before.created_at);
    expect(row.name).toBe('BetterTrackMobile');
    expect(row.is_public).toBe(true);
    expect(row.is_first_party).toBe(true);
    expect(row.client_secret_hash).toBeNull();
    expect(row.user_id).toBeNull();
  });

  it('unions only the MISSING alerts scope, never narrowing or duplicating, preserving admin extras', async () => {
    // Fabricate a partially-granted, admin-customised pre-state: already holds
    // alerts:read plus an admin extra outside the ceiling, still missing alerts:write.
    await client.exec(`
      UPDATE "oauth_clients"
      SET "scopes" = ARRAY['portfolio:read','alerts:read','experimental:beta']::text[]
      WHERE "client_id" = '${CLIENT_ID}';
    `);

    await applyMigration(client, TARGET_0030);

    const row = (await readClient(client, CLIENT_ID))!;
    // Only the missing alerts:write was appended — alerts:read not duplicated,
    // the admin extra preserved, existing order kept (append-only union).
    expect(row.scopes).toEqual([
      'portfolio:read',
      'alerts:read',
      'experimental:beta',
      'alerts:write',
    ]);
    for (const scope of ALERTS_SCOPES) expect(row.scopes).toContain(scope);
    expect(row.scopes).toContain('experimental:beta');
    expect(new Set(row.scopes).size).toBe(row.scopes.length); // no duplicates
  });

  it('is a true no-op when the row already holds both alerts scopes (idempotent re-run)', async () => {
    await applyMigration(client, TARGET_0030); // adds alerts → full ceiling
    const first = (await readClient(client, CLIENT_ID))!;
    expect(first.scopes).toEqual(CEILING);

    await applyMigration(client, TARGET_0030); // must change nothing
    const second = (await readClient(client, CLIENT_ID))!;

    expect(second.id).toBe(first.id); // not recreated
    expect(second.created_at).toEqual(first.created_at);
    expect(second.scopes).toEqual(first.scopes);
    expect(second.redirect_uris).toEqual(first.redirect_uris);

    // And exactly one row exists — the guard never duplicated the client.
    const count = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM "oauth_clients" WHERE "client_id" = $1`,
      [CLIENT_ID],
    );
    expect(count.rows[0]!.n).toBe(1);
  });

  it('migrate-only AND migrate+seed both converge to the canonical ceiling; the seed is a no-op after 0030', async () => {
    // The migration chain now carries alerts itself: 0029 (frozen 12) ∪ 0030 (the
    // two alerts scopes) reaches the full live ceiling with NO seed. This is the
    // prod reality — the live updater runs migrate.js only (seed re-copy pending),
    // so 0030 is what unblocks mobile alerts OAuth there. Canary: any scope appended
    // to the definition after 0030 must extend the migration chain, not lean on seed.
    expect(CEILING).toEqual([...RECONCILE_SCOPES, ...ALERTS_SCOPES]);

    await applyMigration(client, TARGET_0030);

    // migrate-only install → already at the canonical ceiling.
    const migrateOnly = (await readClient(client, CLIENT_ID))!;
    expect(migrateOnly.scopes).toEqual(CEILING);

    // migrate+seed install → the seed finds nothing to do (a true no-op) and the
    // row stays at the exact same ceiling. The two deploy channels never fight.
    const repo = createOAuthRepository(drizzlePglite(client, { schema }) as unknown as Database);
    const seeded = (await seedFirstPartyClients(repo)).find((r) => r.clientId === CLIENT_ID)!;
    expect(seeded.action).toBe('unchanged');
    const afterSeed = (await readClient(client, CLIENT_ID))!;
    expect(afterSeed.scopes).toEqual(CEILING);

    // A re-run stays a no-op — steady state on every subsequent deploy.
    const seededAgain = (await seedFirstPartyClients(repo)).find((r) => r.clientId === CLIENT_ID)!;
    expect(seededAgain.action).toBe('unchanged');
  });
});
