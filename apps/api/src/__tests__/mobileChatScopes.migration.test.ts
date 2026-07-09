import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * #349 follow-up — the 0027 data migration grants the first-party
 * BetterTrackMobile OAuth client the two #361 friend-chat scopes
 * (chat:read, chat:write) on its ALLOWED-scope ceiling, so mobile OAuth can
 * reach the #349 friend-chat endpoints. These tests exercise the REAL migration
 * SQL (read from the drizzle folder) against a live PGlite database, proving it
 * is correct, idempotent, safe on a fresh DB, and never touches another client.
 * Consent-safety (the ceiling is widened; live grants are not) is covered by the
 * OAuth suite; this migration only touches oauth_clients.scopes.
 */

const MOBILE_CLIENT_ID = 'btc_IbT1mzw_7kBiPHPkGfaE0Q';
const NEW_SCOPES = ['chat:read', 'chat:write'];
// The mobile client's realistic ceiling by the time 0027 runs: the original
// scopes plus the four #361 platform scopes granted by the earlier 0023.
const EXISTING_SCOPES = [
  'portfolio:read',
  'portfolio:write',
  'workboard:read',
  'workboard:write',
  'market:read',
  'social:read',
  'account:security',
  'notifications:read',
  'notifications:write',
  'social:write',
];

const migrationSql = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../drizzle/0027_mobile_chat_scopes.sql',
  ),
  'utf8',
);

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

async function runMigration(): Promise<void> {
  await harness.db.execute(sql.raw(migrationSql));
}

async function seedMobileClient(scopes: string[]): Promise<void> {
  await harness.db.insert(schema.oauthClients).values({
    userId: null,
    clientId: MOBILE_CLIENT_ID,
    name: 'BetterTrack Mobile',
    clientSecretHash: null,
    redirectUris: ['bettertrack://oauth/callback'],
    scopes,
    isPublic: true,
    isFirstParty: true,
  });
}

async function scopesOf(clientId: string): Promise<string[] | null> {
  const [row] = await harness.db
    .select()
    .from(schema.oauthClients)
    .where(eq(schema.oauthClients.clientId, clientId));
  return row ? (row.scopes as string[]) : null;
}

describe('0027 mobile chat scopes migration', () => {
  it('is a no-op on a fresh DB where the BetterTrackMobile client does not exist', async () => {
    // The harness already applied 0027 during setup against an empty table; a
    // manual re-run must likewise not throw and must create nothing.
    await expect(runMigration()).resolves.not.toThrow();
    expect(await scopesOf(MOBILE_CLIENT_ID)).toBeNull();
  });

  it('adds exactly the two chat scopes, preserving the existing ones and their order', async () => {
    await seedMobileClient(EXISTING_SCOPES);

    await runMigration();

    const after = (await scopesOf(MOBILE_CLIENT_ID))!;
    expect(after).toEqual([...EXISTING_SCOPES, ...NEW_SCOPES]);
    for (const s of NEW_SCOPES) expect(after).toContain(s);
  });

  it('is idempotent — repeated runs never duplicate or drift', async () => {
    await seedMobileClient(EXISTING_SCOPES);

    await runMigration();
    const once = (await scopesOf(MOBILE_CLIENT_ID))!;
    await runMigration();
    await runMigration();
    const thrice = (await scopesOf(MOBILE_CLIENT_ID))!;

    expect(thrice).toEqual(once);
    expect(new Set(thrice).size).toBe(thrice.length); // no duplicates
  });

  it('only appends the scopes that are actually missing (partial pre-existing set)', async () => {
    // The client already has one of the two new scopes.
    await seedMobileClient([...EXISTING_SCOPES, 'chat:read']);

    await runMigration();

    const after = (await scopesOf(MOBILE_CLIENT_ID))!;
    for (const s of NEW_SCOPES) expect(after).toContain(s);
    expect(after.filter((s) => s === 'chat:read')).toHaveLength(1); // not duplicated
    expect(new Set(after).size).toBe(after.length);
  });

  it('leaves every other OAuth client untouched', async () => {
    await harness.db.insert(schema.oauthClients).values({
      userId: null,
      clientId: 'btc_someOtherFirstPartyClient',
      name: 'Other',
      clientSecretHash: null,
      redirectUris: ['https://other.example/cb'],
      scopes: ['portfolio:read'],
      isPublic: true,
      isFirstParty: true,
    });

    await runMigration();

    expect(await scopesOf('btc_someOtherFirstPartyClient')).toEqual(['portfolio:read']);
  });
});
