import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { createOAuthRepository } from '../data/repositories/oauthRepository';
import * as schema from '../data/schema';
import { FIRST_PARTY_CLIENTS, seedFirstPartyClients } from '../services/oauth/firstPartyClients';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * #395 — the boot-time first-party OAuth client seed. `seedFirstPartyClients`
 * upserts the code-defined official apps (currently BetterTrackMobile) so a truly
 * fresh database always has the mobile OAuth client, without any manual admin
 * step. These tests exercise the REAL seed function through the REAL repo against
 * a live PGlite database and cover every acceptance criterion: fresh-DB create,
 * idempotent re-run, narrower→ceiling convergence, extra scopes/URIs preserved
 * (never narrows), and other clients left untouched.
 */

const MOBILE = FIRST_PARTY_CLIENTS.find((c) => c.clientId === 'btc_IbT1mzw_7kBiPHPkGfaE0Q')!;
const CEILING = [...MOBILE.scopeCeiling];
const CANONICAL_URI = MOBILE.redirectUris[0]!;

let harness: TestHarness;
let repo: ReturnType<typeof createOAuthRepository>;

beforeEach(async () => {
  harness = await createTestApp();
  repo = createOAuthRepository(harness.db);
});

async function clientRow(clientId: string) {
  const [row] = await harness.db
    .select()
    .from(schema.oauthClients)
    .where(eq(schema.oauthClients.clientId, clientId));
  return row ?? null;
}

/** Insert a bare BetterTrackMobile row with a chosen scope/URI shape to converge from. */
async function seedExistingMobile(input: {
  scopes: string[];
  redirectUris?: string[];
}): Promise<void> {
  await repo.createClient({
    userId: null,
    clientId: MOBILE.clientId,
    name: MOBILE.name,
    clientSecretHash: null,
    redirectUris: input.redirectUris ?? [CANONICAL_URI],
    scopes: input.scopes,
    isPublic: true,
    isFirstParty: true,
  });
}

function resultFor(results: Awaited<ReturnType<typeof seedFirstPartyClients>>, clientId: string) {
  return results.find((r) => r.clientId === clientId)!;
}

describe('seedFirstPartyClients (#395)', () => {
  it('creates BetterTrackMobile with the full scope ceiling on a fresh DB', async () => {
    expect(await clientRow(MOBILE.clientId)).toBeNull();

    const results = await seedFirstPartyClients(repo);

    const row = (await clientRow(MOBILE.clientId))!;
    expect(row.name).toBe(MOBILE.name);
    expect(row.redirectUris).toEqual([CANONICAL_URI]);
    expect(row.scopes).toEqual(CEILING);
    expect(row.isPublic).toBe(true);
    expect(row.isFirstParty).toBe(true);
    expect(row.clientSecretHash).toBeNull(); // public/PKCE — no secret
    expect(row.userId).toBeNull(); // system-owned
    expect(resultFor(results, MOBILE.clientId).action).toBe('created');
  });

  it('is a no-op on the second run — same row, no drift', async () => {
    await seedFirstPartyClients(repo);
    const first = (await clientRow(MOBILE.clientId))!;

    const results = await seedFirstPartyClients(repo);
    const second = (await clientRow(MOBILE.clientId))!;

    expect(second.id).toBe(first.id); // reused, not recreated
    expect(second.createdAt).toEqual(first.createdAt);
    expect(second.scopes).toEqual(first.scopes);
    expect(second.redirectUris).toEqual(first.redirectUris);
    expect(resultFor(results, MOBILE.clientId).action).toBe('unchanged');
  });

  it('converges an existing row with a NARROWER ceiling up to the full ceiling', async () => {
    // An old row created before the platform/chat scopes were ever granted.
    const narrow = ['portfolio:read', 'workboard:read', 'market:read'];
    await seedExistingMobile({ scopes: narrow });

    const results = await seedFirstPartyClients(repo);

    const row = (await clientRow(MOBILE.clientId))!;
    for (const scope of CEILING) expect(row.scopes).toContain(scope); // full ceiling reached
    expect(row.scopes.slice(0, narrow.length)).toEqual(narrow); // append-only union
    expect(new Set(row.scopes).size).toBe(row.scopes.length); // no duplicates
    expect(resultFor(results, MOBILE.clientId).action).toBe('converged');
  });

  it('keeps an admin-added EXTRA scope while still widening to the ceiling', async () => {
    // 'experimental:beta' is outside the ceiling; the union must never drop it.
    await seedExistingMobile({ scopes: ['portfolio:read', 'experimental:beta'] });

    const results = await seedFirstPartyClients(repo);

    const row = (await clientRow(MOBILE.clientId))!;
    expect(row.scopes).toContain('experimental:beta'); // extra preserved
    expect(row.scopes.slice(0, 2)).toEqual(['portfolio:read', 'experimental:beta']); // kept in place
    for (const scope of CEILING) expect(row.scopes).toContain(scope); // ceiling still reached
    expect(new Set(row.scopes).size).toBe(row.scopes.length);
    expect(resultFor(results, MOBILE.clientId).action).toBe('converged');
  });

  it('leaves a row already at the full ceiling plus an extra scope untouched', async () => {
    const withExtra = [...CEILING, 'experimental:beta'];
    await seedExistingMobile({ scopes: withExtra });

    const results = await seedFirstPartyClients(repo);

    const row = (await clientRow(MOBILE.clientId))!;
    expect(row.scopes).toEqual(withExtra); // nothing added, nothing removed
    expect(resultFor(results, MOBILE.clientId).action).toBe('unchanged');
  });

  it('adds the missing canonical redirect URI additively, keeping an admin-added extra', async () => {
    const extraUri = 'https://example.com/admin-added-cb';
    await seedExistingMobile({ scopes: CEILING, redirectUris: [extraUri] });

    await seedFirstPartyClients(repo);

    const row = (await clientRow(MOBILE.clientId))!;
    expect(row.redirectUris).toEqual([extraUri, CANONICAL_URI]); // existing first, canonical appended
  });

  it('leaves an unrelated OAuth client completely untouched', async () => {
    await harness.db.insert(schema.oauthClients).values({
      userId: null,
      clientId: 'btc_someOtherClient',
      name: 'Other',
      clientSecretHash: null,
      redirectUris: ['https://other.example/cb'],
      scopes: ['portfolio:read'],
      isPublic: true,
      isFirstParty: true,
    });

    await seedFirstPartyClients(repo);

    const other = (await clientRow('btc_someOtherClient'))!;
    expect(other.scopes).toEqual(['portfolio:read']);
    expect(other.redirectUris).toEqual(['https://other.example/cb']);
  });
});
