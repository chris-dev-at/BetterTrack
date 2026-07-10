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
 * The 0029 first-party-client-reconcile migration self-heals the BetterTrackMobile
 * OAuth client on EVERY deploy — prod's auto-updater runs migrate.js but never
 * seed.js, so the #398 boot-seed never fires there and a stale restore keeps
 * mobile chat 403ing (#386, #395). The migration must reproduce the seed's
 * union-only convergence purely in SQL: create-if-missing at the full ceiling,
 * else widen scopes/redirect URIs WITHOUT narrowing. The shared harness only ever
 * replays migrations onto an empty DB (and truncates), so — exactly like the 0019
 * / 0024 data-migration suites — this boots a throwaway PGlite, applies everything
 * UP TO 0029, seeds a pre-state, then applies 0029 like the drizzle migrator would.
 */

const drizzleDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const TARGET = '0029_first_party_client_reconcile';

const MOBILE = FIRST_PARTY_CLIENTS.find((c) => c.clientId === 'btc_IbT1mzw_7kBiPHPkGfaE0Q')!;
const CLIENT_ID = MOBILE.clientId;
const CEILING = [...MOBILE.scopeCeiling];
const CANONICAL_URI = MOBILE.redirectUris[0]!;

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

describe(`migration ${TARGET} — first-party client reconcile (union-only)`, () => {
  let client: PGlite;

  beforeEach(async () => {
    client = new PGlite({ extensions: { pg_trgm } });
    const tags = migrationTags();
    expect(tags).toContain(TARGET);
    // Replay every migration up to (not including) the target — the state a prod
    // DB is in the moment before this migration runs.
    for (const tag of tags) {
      if (tag === TARGET) break;
      await applyMigration(client, tag);
    }
  });

  it('INSERTs the full canonical row when the client is missing (fresh/restored DB)', async () => {
    expect(await readClient(client, CLIENT_ID)).toBeNull();

    await applyMigration(client, TARGET);

    const row = (await readClient(client, CLIENT_ID))!;
    expect(row).not.toBeNull();
    expect(row.name).toBe('BetterTrackMobile');
    expect(row.scopes).toEqual(CEILING); // full 12-scope ceiling, canonical order
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

    await applyMigration(client, TARGET);

    const row = (await readClient(client, CLIENT_ID))!;
    // Never narrows: every ceiling scope is now present…
    for (const scope of CEILING) expect(row.scopes).toContain(scope);
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
    await applyMigration(client, TARGET); // INSERT path
    const first = (await readClient(client, CLIENT_ID))!;

    await applyMigration(client, TARGET); // must change nothing
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

  it('leaves the #398 boot-seed a no-op afterwards (migration and seed converge)', async () => {
    // The whole point: the migration is the prod-reachable channel that produces
    // exactly the state seedFirstPartyClients considers already converged, so the
    // two never fight. Run the REAL seed against the post-migration DB.
    await applyMigration(client, TARGET);

    const repo = createOAuthRepository(drizzlePglite(client, { schema }) as unknown as Database);
    const results = await seedFirstPartyClients(repo);

    expect(results.find((r) => r.clientId === CLIENT_ID)!.action).toBe('unchanged');
  });
});
