import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * #341 Part 2 — the 0023 data migration grants the first-party BetterTrackMobile
 * OAuth client the four #361 platform scopes on its ALLOWED-scope ceiling. These
 * tests exercise the REAL migration SQL (read from the drizzle folder) against a
 * live PGlite database, proving it is correct, idempotent, safe on a fresh DB,
 * and never touches another client. Consent-safety is covered separately in
 * oauth.test.ts (the ceiling is added; live grants are not widened).
 */

const MOBILE_CLIENT_ID = 'btc_IbT1mzw_7kBiPHPkGfaE0Q';
const NEW_SCOPES = [
  'account:security',
  'notifications:read',
  'notifications:write',
  'social:write',
];
const OLD_SCOPES = [
  'portfolio:read',
  'portfolio:write',
  'workboard:read',
  'workboard:write',
  'market:read',
  'social:read',
];

const migrationSql = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../drizzle/0023_mobile_oauth_scopes.sql',
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

describe('0023 mobile OAuth scopes migration', () => {
  it('is a no-op on a fresh DB where the BetterTrackMobile client does not exist', async () => {
    // The harness already applied 0023 during setup against an empty table; a
    // manual re-run must likewise not throw and must create nothing.
    await expect(runMigration()).resolves.not.toThrow();
    expect(await scopesOf(MOBILE_CLIENT_ID)).toBeNull();
  });

  it('adds exactly the four new scopes, preserving the existing ones and their order', async () => {
    await seedMobileClient(OLD_SCOPES);

    await runMigration();

    const after = (await scopesOf(MOBILE_CLIENT_ID))!;
    expect(after).toEqual([...OLD_SCOPES, ...NEW_SCOPES]);
    for (const s of NEW_SCOPES) expect(after).toContain(s);
  });

  it('is idempotent — repeated runs never duplicate or drift', async () => {
    await seedMobileClient(OLD_SCOPES);

    await runMigration();
    const once = (await scopesOf(MOBILE_CLIENT_ID))!;
    await runMigration();
    await runMigration();
    const thrice = (await scopesOf(MOBILE_CLIENT_ID))!;

    expect(thrice).toEqual(once);
    expect(new Set(thrice).size).toBe(thrice.length); // no duplicates
  });

  it('only appends the scopes that are actually missing (partial pre-existing set)', async () => {
    // The client already has one of the four new scopes.
    await seedMobileClient([...OLD_SCOPES, 'social:write']);

    await runMigration();

    const after = (await scopesOf(MOBILE_CLIENT_ID))!;
    for (const s of NEW_SCOPES) expect(after).toContain(s);
    expect(after.filter((s) => s === 'social:write')).toHaveLength(1); // not duplicated
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
