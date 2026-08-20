import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { vaultMediaListSchema, vaultMediaSchema } from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { newId } from '../data/ids';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * PARANOID VAULTS per-portfolio schema keystone (#1410, epic E0;
 * `docs/paranoid-design.md` §3/§8). Migration 0090 applies on a fresh PGlite
 * database that has already run 0089 (createTestApp runs the full journal), and
 * every CHECK/unique constraint the issue's acceptance criteria name is PROVEN
 * here by insert, not assumed.
 */

const PROOF_KEY = 'MCowBQYDK2VwAyEA' + 'A'.repeat(27) + '=';
const FINGERPRINT = 'Abcdef0123456789';

let h: TestHarness;
let userId: string;

function vaultValues(overrides: Partial<typeof schema.vaults.$inferInsert> = {}) {
  return {
    userId,
    name: `vault-${newId()}`,
    media: ['server'],
    retirementProofPublicKey: PROOF_KEY,
    keyFingerprint: FINGERPRINT,
    ...overrides,
  };
}

async function insertVault(overrides: Partial<typeof schema.vaults.$inferInsert> = {}) {
  const [row] = await h.db.insert(schema.vaults).values(vaultValues(overrides)).returning();
  if (!row) throw new Error('expected an inserted vault');
  return row;
}

async function insertConnection(ownerId: string, googleSub = `sub-${newId()}`) {
  const [row] = await h.db
    .insert(schema.driveConnections)
    .values({ userId: ownerId, googleSub, email: 'y@gmail.com', displayName: 'Y' })
    .returning();
  if (!row) throw new Error('expected an inserted drive connection');
  return row;
}

async function insertPortfolio() {
  const [row] = await h.db
    .insert(schema.portfolios)
    .values({ userId, name: `portfolio-${newId()}` })
    .returning();
  if (!row) throw new Error('expected an inserted portfolio');
  return row;
}

beforeAll(async () => {
  h = await createTestApp();
  const seeded = await h.seedUser({ email: 'vault-schema@bt.test', username: 'vault_schema' });
  userId = seeded.id;
});

afterAll(async () => {
  await h.ctx.redis.quit?.();
});

describe('vaults — media + Drive-binding CHECK (§3, acceptance a/b/d)', () => {
  it('accepts each valid media set', async () => {
    await insertVault({ media: ['server'] });
    const connection = await insertConnection(userId);
    await insertVault({ media: ['drive'], driveConnectionId: connection.id });
    await insertVault({ media: ['server', 'drive'], driveConnectionId: connection.id });
    await insertVault({ media: ['drive', 'server'], driveConnectionId: connection.id });
  });

  it('(b) rejects an empty media set', async () => {
    await expect(insertVault({ media: [] })).rejects.toThrow();
  });

  it('(a) rejects the drive medium without a bound Drive connection', async () => {
    await expect(insertVault({ media: ['drive'] })).rejects.toThrow();
    await expect(insertVault({ media: ['server', 'drive'] })).rejects.toThrow();
  });

  it('rejects a stale Drive binding when drive is not selected', async () => {
    const connection = await insertConnection(userId);
    await expect(
      insertVault({ media: ['server'], driveConnectionId: connection.id }),
    ).rejects.toThrow();
  });

  it('(d) rejects the RESERVED local medium at the server boundary while the contract enum accepts it', async () => {
    // The contract half: clients may know the word (§22 — additive future).
    expect(vaultMediaSchema.parse('local')).toBe('local');
    expect(vaultMediaListSchema.safeParse(['local']).success).toBe(true);
    expect(vaultMediaListSchema.safeParse(['server', 'local']).success).toBe(true);
    // The server half: the deepest boundary refuses to persist it.
    await expect(insertVault({ media: ['local'] })).rejects.toThrow();
    await expect(insertVault({ media: ['server', 'local'] })).rejects.toThrow();
    // ...including via UPDATE of an existing row.
    const vault = await insertVault({ media: ['server'] });
    await expect(
      h.db
        .update(schema.vaults)
        .set({ media: ['local'] })
        .where(eq(schema.vaults.id, vault.id)),
    ).rejects.toThrow();
  });

  it('rejects duplicated and unknown media values', async () => {
    await expect(insertVault({ media: ['server', 'server'] })).rejects.toThrow();
    await expect(insertVault({ media: ['tape'] })).rejects.toThrow();
  });

  it('enforces one vault name per user', async () => {
    await insertVault({ name: 'Duplicate me' });
    await expect(insertVault({ name: 'Duplicate me' })).rejects.toThrow();
  });
});

describe('drive_connections — per-user uniqueness, shared physical Drive (§8)', () => {
  it('google_sub is unique per user, and a SECOND user may hold the same sub', async () => {
    const sharedSub = `shared-${newId()}`;
    await insertConnection(userId, sharedSub);
    // Same user, same Google account again → refused.
    await expect(insertConnection(userId, sharedSub)).rejects.toThrow();
    // A different BetterTrack user backing up to the SAME physical Drive → allowed.
    const other = await h.seedUser({ email: 'shared-drive@bt.test', username: 'shared_drive' });
    const row = await insertConnection(other.id, sharedSub);
    expect(row.googleSub).toBe(sharedSub);
  });

  it('refuses disconnecting a Google account a vault is still bound to (FK)', async () => {
    const connection = await insertConnection(userId);
    await insertVault({ media: ['drive'], driveConnectionId: connection.id });
    await expect(
      h.db.delete(schema.driveConnections).where(eq(schema.driveConnections.id, connection.id)),
    ).rejects.toThrow();
  });
});

describe('vault_blobs — doc-kind shape (§3/§5, acceptance c)', () => {
  function blobValues(
    vaultId: string,
    overrides: Partial<typeof schema.vaultBlobs.$inferInsert> = {},
  ) {
    return {
      vaultId,
      docId: newId(),
      docKind: 'header',
      version: 1,
      formatVersion: 2,
      sizeBytes: 4,
      blob: Buffer.from('test'),
      ...overrides,
    };
  }

  it('accepts a well-formed header + common + portfolio doc set', async () => {
    const vault = await insertVault();
    const portfolio = await insertPortfolio();
    await h.db.insert(schema.vaultBlobs).values(blobValues(vault.id, { docKind: 'header' }));
    await h.db.insert(schema.vaultBlobs).values(blobValues(vault.id, { docKind: 'common' }));
    await h.db
      .insert(schema.vaultBlobs)
      .values(blobValues(vault.id, { docKind: 'portfolio', portfolioId: portfolio!.id }));

    // The doc set's shape: a second header or common doc for the SAME vault is
    // refused; the same portfolio cannot hold a second doc in ANY vault.
    await expect(
      h.db.insert(schema.vaultBlobs).values(blobValues(vault.id, { docKind: 'header' })),
    ).rejects.toThrow();
    await expect(
      h.db.insert(schema.vaultBlobs).values(blobValues(vault.id, { docKind: 'common' })),
    ).rejects.toThrow();
    const secondVault = await insertVault();
    await h.db.insert(schema.vaultBlobs).values(blobValues(secondVault.id, { docKind: 'header' }));
    await expect(
      h.db
        .insert(schema.vaultBlobs)
        .values(blobValues(secondVault.id, { docKind: 'portfolio', portfolioId: portfolio!.id })),
    ).rejects.toThrow();
  });

  it("(c) rejects doc_kind='portfolio' without a portfolio and a non-portfolio doc WITH one", async () => {
    const vault = await insertVault();
    const portfolio = await insertPortfolio();
    await expect(
      h.db.insert(schema.vaultBlobs).values(blobValues(vault.id, { docKind: 'portfolio' })),
    ).rejects.toThrow();
    await expect(
      h.db
        .insert(schema.vaultBlobs)
        .values(blobValues(vault.id, { docKind: 'header', portfolioId: portfolio!.id })),
    ).rejects.toThrow();
    await expect(
      h.db
        .insert(schema.vaultBlobs)
        .values(blobValues(vault.id, { docKind: 'common', portfolioId: portfolio!.id })),
    ).rejects.toThrow();
  });

  it('rejects an unknown doc kind', async () => {
    const vault = await insertVault();
    await expect(
      h.db.insert(schema.vaultBlobs).values(blobValues(vault.id, { docKind: 'roster' })),
    ).rejects.toThrow();
  });
});

describe('portfolios — the locked stub (§3)', () => {
  it('rejects a vault_alias without a vault membership', async () => {
    const portfolio = await insertPortfolio();
    await expect(
      h.db
        .update(schema.portfolios)
        .set({ vaultAlias: 'Locked wallet' })
        .where(eq(schema.portfolios.id, portfolio!.id)),
    ).rejects.toThrow();
  });

  it('a vault cannot be deleted while a stub references it; clearing the stub frees it', async () => {
    const vault = await insertVault();
    const portfolio = await insertPortfolio();
    await h.db
      .update(schema.portfolios)
      .set({ vaultId: vault.id, vaultAlias: 'Locked wallet' })
      .where(eq(schema.portfolios.id, portfolio!.id));

    await expect(
      h.db.delete(schema.vaults).where(eq(schema.vaults.id, vault.id)),
    ).rejects.toThrow();

    await h.db
      .update(schema.portfolios)
      .set({ vaultId: null, vaultAlias: null })
      .where(eq(schema.portfolios.id, portfolio!.id));
    await h.db.delete(schema.vaults).where(eq(schema.vaults.id, vault.id));
    expect(await h.db.select().from(schema.vaults).where(eq(schema.vaults.id, vault.id))).toEqual(
      [],
    );
  });
});

describe('coexistence — the v1 account-level surface is untouched (§19 regression)', () => {
  it('a live v1 paranoid account keeps working with the new tables present', async () => {
    const legacy = await h.seedUser({ email: 'legacy-v1@bt.test', username: 'legacy_v1' });
    const blob = Buffer.from('v1-ciphertext');
    await h.db
      .update(schema.users)
      .set({ privacyMode: 'paranoid', paranoidMediaSet: ['server'] })
      .where(eq(schema.users.id, legacy.id));
    await h.db.insert(schema.paranoidVaults).values({
      userId: legacy.id,
      version: 1,
      formatVersion: 1,
      sizeBytes: blob.byteLength,
      blob,
    });
    // The account-level CHECK still enforces exactly as before...
    await expect(
      h.db
        .update(schema.users)
        .set({ paranoidMediaSet: null })
        .where(eq(schema.users.id, legacy.id)),
    ).rejects.toThrow();
    // ...and the same account can additionally own a per-portfolio vault row
    // without either surface interfering with the other (E9 retires v1 later).
    const [vault] = await h.db
      .insert(schema.vaults)
      .values({
        userId: legacy.id,
        name: 'coexistence',
        media: ['server'],
        retirementProofPublicKey: PROOF_KEY,
        keyFingerprint: FINGERPRINT,
      })
      .returning();
    expect(vault!.userId).toBe(legacy.id);
    const [v1Row] = await h.db
      .select()
      .from(schema.paranoidVaults)
      .where(eq(schema.paranoidVaults.userId, legacy.id));
    expect(v1Row!.version).toBe(1);
  });
});
