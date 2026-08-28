import { beforeEach, describe, expect, it } from 'vitest';
import { asc } from 'drizzle-orm';

import { vaultServerCandidates, vaults } from '../../schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import { createVaultBlobRepository } from '../vaultBlobRepository';

/**
 * The #1491 retention ruling keeps a staged server candidate alive to its
 * `expires_at` instead of deleting it at move-in, so a lying or buggy Drive
 * attestation stays recoverable inside the window. That reasoning assumes the
 * TTL is real. Lazy expiry alone only fires when the vault is read again, so a
 * candidate on a vault nobody touches again would persist indefinitely —
 * #1521 adds this bounded sweep.
 */
const NOW = new Date('2026-08-28T12:00:00.000Z');
const VAULT_ID = '019826d1-1000-7000-8000-000000000001';
const HEADER_DOC_ID = '019826d1-1000-7000-8000-000000000002';
const COMMON_DOC_ID = '019826d1-1000-7000-8000-000000000003';

let harness: TestHarness;

async function seedVault(): Promise<void> {
  const user = await harness.seedUser({ email: 'sweep@bt.test', username: 'sweep' });
  await harness.db.insert(vaults).values({
    id: VAULT_ID,
    userId: user.id,
    name: 'Sweep vault',
    headerDocId: HEADER_DOC_ID,
    commonDocId: COMMON_DOC_ID,
    media: ['server'],
    retirementProofPublicKey: 'sweep retirement public key',
    keyFingerprint: 'SWEEP-FINGERPRINT',
  });
}

async function stage(docId: string, expiresAt: Date): Promise<void> {
  const blob = Buffer.from(`ciphertext-${docId}`);
  await harness.db.insert(vaultServerCandidates).values({
    transitionId: '019826d1-1000-7000-8000-00000000000f',
    vaultId: VAULT_ID,
    docId,
    version: 1,
    formatVersion: 2,
    sizeBytes: blob.length,
    blob,
    createdAt: new Date(NOW.getTime() - 60_000),
    expiresAt,
  });
}

async function remainingDocIds(): Promise<string[]> {
  const rows = await harness.db
    .select({ docId: vaultServerCandidates.docId })
    .from(vaultServerCandidates)
    .orderBy(asc(vaultServerCandidates.docId));
  return rows.map((row) => row.docId);
}

beforeEach(async () => {
  harness = await createTestApp();
  await seedVault();
});

describe('cleanupExpiredServerCandidates', () => {
  it('disposes candidates past their TTL, keeps unexpired ones, and is idempotent', async () => {
    const repo = createVaultBlobRepository(harness.db);
    await stage('019826d1-1000-7000-8000-0000000000a1', new Date(NOW.getTime() - 1));
    await stage('019826d1-1000-7000-8000-0000000000a2', NOW);
    await stage('019826d1-1000-7000-8000-0000000000a3', new Date(NOW.getTime() + 60_000));

    // The vault is never read again: this sweep is the only actor.
    expect(await repo.cleanupExpiredServerCandidates(NOW, 100)).toBe(2);
    expect(await remainingDocIds()).toEqual(['019826d1-1000-7000-8000-0000000000a3']);

    // Second pass over the same cutoff finds nothing left to dispose and
    // leaves the surviving candidate exactly where it is.
    expect(await repo.cleanupExpiredServerCandidates(NOW, 100)).toBe(0);
    expect(await remainingDocIds()).toEqual(['019826d1-1000-7000-8000-0000000000a3']);

    // Once its own TTL passes, the survivor goes the same way.
    expect(await repo.cleanupExpiredServerCandidates(new Date(NOW.getTime() + 60_000), 100)).toBe(
      1,
    );
    expect(await remainingDocIds()).toEqual([]);
  });

  it('bounds one pass by the limit, oldest expiry first, and converges over passes', async () => {
    const repo = createVaultBlobRepository(harness.db);
    await stage('019826d1-1000-7000-8000-0000000000b1', new Date(NOW.getTime() - 3_000));
    await stage('019826d1-1000-7000-8000-0000000000b2', new Date(NOW.getTime() - 2_000));
    await stage('019826d1-1000-7000-8000-0000000000b3', new Date(NOW.getTime() - 1_000));

    expect(await repo.cleanupExpiredServerCandidates(NOW, 2)).toBe(2);
    expect(await remainingDocIds()).toEqual(['019826d1-1000-7000-8000-0000000000b3']);
    expect(await repo.cleanupExpiredServerCandidates(NOW, 2)).toBe(1);
    expect(await remainingDocIds()).toEqual([]);
  });

  it('refuses a non-positive limit rather than sweeping unbounded', async () => {
    const repo = createVaultBlobRepository(harness.db);
    await stage('019826d1-1000-7000-8000-0000000000c1', new Date(NOW.getTime() - 1));

    expect(await repo.cleanupExpiredServerCandidates(NOW, 0)).toBe(0);
    expect(await repo.cleanupExpiredServerCandidates(NOW, -5)).toBe(0);
    expect(await remainingDocIds()).toEqual(['019826d1-1000-7000-8000-0000000000c1']);
  });
});
