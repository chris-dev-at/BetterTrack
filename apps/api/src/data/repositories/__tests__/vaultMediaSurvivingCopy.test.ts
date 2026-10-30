import { beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';

import {
  encodeVaultDocEnvelope,
  perVaultMediaTransitionRequestSchema,
  VAULT_CONTENT_CIPHER,
  type PerVaultMediaDocAttestation,
  type PerVaultMediaTransitionRequest,
  type VaultDocKind,
  type VaultMedia,
} from '@bettertrack/contracts';

import { driveConnections, vaultBlobs, vaultRetired, vaultRetirements, vaults } from '../../schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import { createVaultBlobRepository } from '../vaultBlobRepository';

/**
 * §7 rule 2 — "Remove a medium: only while another medium holds a
 * verified-fresh copy" (#1637). The proof a removal presents must be a readback
 * of a medium the transition KEEPS: the medium being retired cannot attest
 * itself. These are repository-level tests on purpose — the contract schema
 * (`perVaultMediaTransitionRequestSchema`) already derives the required kind at
 * the wire, so the only way to observe the repository's own gate is to call it
 * directly, which is also the shape a non-HTTP caller would take.
 */

// Deterministic TEST VECTOR UUIDs and bytes; none are credentials.
const id = (value: number) => `019c8300-0000-7000-8000-${value.toString(16).padStart(12, '0')}`;
const TEST_VECTOR = {
  vaultId: id(1),
  headerDocId: id(2),
  commonDocId: id(3),
  driveConnectionId: id(4),
  otherDriveConnectionId: id(10),
  keyId: id(5),
  deviceId: id(6),
  transitionId: id(7),
  headerWriteId: id(8),
  commonWriteId: id(9),
  attestedAt: new Date('2026-09-16T09:00:00.000Z'),
  now: new Date('2026-09-16T10:00:00.000Z'),
} as const;

const DOCS: readonly PerVaultMediaDocAttestation[] = [
  { docId: TEST_VECTOR.headerDocId, docVersion: 1, writeId: TEST_VECTOR.headerWriteId },
  { docId: TEST_VECTOR.commonDocId, docVersion: 1, writeId: TEST_VECTOR.commonWriteId },
];

function envelope(docId: string, docKind: VaultDocKind, writeId: string): Buffer {
  return Buffer.from(
    encodeVaultDocEnvelope(
      {
        formatVersion: 2,
        cipher: VAULT_CONTENT_CIPHER,
        iv: 'AA',
        keyId: TEST_VECTOR.keyId,
        keySlots: [
          { keyId: TEST_VECTOR.keyId, slot: 'seed-v1', wrappedKc: 'TEST_VECTOR_wrapped_key' },
        ],
        vaultId: TEST_VECTOR.vaultId,
        docId,
        docKind,
        accountBinding: 'A'.repeat(43),
        docVersion: 1,
        schemaVersion: 1,
        deviceId: TEST_VECTOR.deviceId,
        writeId,
        writtenAt: TEST_VECTOR.attestedAt.toISOString(),
      },
      new Uint8Array([0, 255, docKind === 'header' ? 1 : 2]),
    ),
  );
}

let h: TestHarness;
let userId: string;

async function seedVault(media: readonly VaultMedia[]): Promise<void> {
  const user = await h.seedUser({ email: 'rule2@bt.test', username: 'rule2' });
  userId = user.id;
  await h.db.insert(driveConnections).values([
    {
      id: TEST_VECTOR.driveConnectionId,
      userId,
      googleSub: 'TEST_VECTOR_rule2_drive_sub',
      email: 'test-vector-rule2-drive@example.test',
    },
    // A second connection the SAME user owns: the gap this file guards is a
    // readback taken from another of the owner's Drive accounts, which passes
    // every ownership check and still proves nothing about the surviving home.
    {
      id: TEST_VECTOR.otherDriveConnectionId,
      userId,
      googleSub: 'TEST_VECTOR_rule2_other_drive_sub',
      email: 'test-vector-rule2-other-drive@example.test',
    },
  ]);
  const driveSelected = media.includes('drive');
  await h.db.insert(vaults).values({
    id: TEST_VECTOR.vaultId,
    userId,
    name: 'Rule 2 vault',
    headerDocId: TEST_VECTOR.headerDocId,
    commonDocId: TEST_VECTOR.commonDocId,
    media: [...media],
    driveConnectionId: driveSelected ? TEST_VECTOR.driveConnectionId : null,
    retirementProofPublicKey: 'TEST_VECTOR_rule2_retirement_public_key',
    keyFingerprint: 'TEST-VECTOR-RULE2-FINGERPRINT',
    mediaAttestedAt: TEST_VECTOR.attestedAt,
    mediaAttestedDriveConnectionId: driveSelected ? TEST_VECTOR.driveConnectionId : null,
  });
  if (!media.includes('server')) return;
  for (const [docId, docKind, writeId] of [
    [TEST_VECTOR.headerDocId, 'header', TEST_VECTOR.headerWriteId],
    [TEST_VECTOR.commonDocId, 'common', TEST_VECTOR.commonWriteId],
  ] as const) {
    const blob = envelope(docId, docKind, writeId);
    await h.db.insert(vaultBlobs).values({
      vaultId: TEST_VECTOR.vaultId,
      docId,
      docKind,
      portfolioId: null,
      version: 1,
      formatVersion: 2,
      sizeBytes: blob.length,
      blob,
      createdAt: TEST_VECTOR.attestedAt,
      updatedAt: TEST_VECTOR.attestedAt,
    });
  }
}

function request(
  next: { media: readonly VaultMedia[]; driveConnectionId: string | null },
  expected: { media: readonly VaultMedia[]; driveConnectionId: string | null },
  verification: PerVaultMediaTransitionRequest['verification'],
): PerVaultMediaTransitionRequest {
  return {
    transitionId: TEST_VECTOR.transitionId,
    expected: {
      media: [...expected.media],
      driveConnectionId: expected.driveConnectionId,
      mediaAttestedAt: TEST_VECTOR.attestedAt.toISOString(),
    },
    next: { media: [...next.media], driveConnectionId: next.driveConnectionId },
    verification,
  };
}

const driveAttestation = (
  docs: readonly PerVaultMediaDocAttestation[] = DOCS,
  driveConnectionId: string = TEST_VECTOR.driveConnectionId,
): PerVaultMediaTransitionRequest['verification'] => ({
  kind: 'drive',
  driveConnectionId,
  docs: [...docs],
});

const serverAttestation = (
  docs: readonly PerVaultMediaDocAttestation[] = DOCS,
): PerVaultMediaTransitionRequest['verification'] => ({ kind: 'server', docs: [...docs] });

function transition(
  verification: PerVaultMediaTransitionRequest['verification'],
  next: { media: readonly VaultMedia[]; driveConnectionId: string | null },
  expected: { media: readonly VaultMedia[]; driveConnectionId: string | null } = {
    media: ['server', 'drive'],
    driveConnectionId: TEST_VECTOR.driveConnectionId,
  },
) {
  return createVaultBlobRepository(h.db).transitionMedia({
    userId,
    vaultId: TEST_VECTOR.vaultId,
    request: request(next, expected, verification),
    verifiedCandidateIds: new Set<string>(),
    now: TEST_VECTOR.now,
  });
}

async function storedMedia(): Promise<string[]> {
  const [row] = await h.db
    .select({ media: vaults.media })
    .from(vaults)
    .where(eq(vaults.id, TEST_VECTOR.vaultId));
  return [...(row?.media ?? [])].sort();
}

async function activeDocIds(): Promise<string[]> {
  const rows = await h.db
    .select({ docId: vaultBlobs.docId })
    .from(vaultBlobs)
    .where(eq(vaultBlobs.vaultId, TEST_VECTOR.vaultId))
    .orderBy(asc(vaultBlobs.docId));
  return rows.map((row) => row.docId);
}

async function retiredDocIds(): Promise<string[]> {
  const rows = await h.db
    .select({ docId: vaultRetired.docId })
    .from(vaultRetired)
    .where(eq(vaultRetired.vaultId, TEST_VECTOR.vaultId))
    .orderBy(asc(vaultRetired.docId));
  return rows.map((row) => row.docId);
}

async function purgeClockStarted(): Promise<boolean> {
  const rows = await h.db
    .select({ vaultId: vaultRetirements.vaultId })
    .from(vaultRetirements)
    .where(eq(vaultRetirements.vaultId, TEST_VECTOR.vaultId));
  return rows.length > 0;
}

beforeEach(async () => {
  h = await createTestApp();
  return h.dispose;
});

describe('§7 rule 2 — a medium removal is attested by the SURVIVING medium', () => {
  it('refuses to retire the server medium on a server-kind attestation', async () => {
    await seedVault(['server', 'drive']);

    const refused = await transition(serverAttestation(), {
      media: ['drive'],
      driveConnectionId: TEST_VECTOR.driveConnectionId,
    });

    expect(refused.status).toBe('verification_failed');
    // Nothing retired, no purge clock, the server copy still active.
    expect(await retiredDocIds()).toEqual([]);
    expect(await purgeClockStarted()).toBe(false);
    expect(await activeDocIds()).toEqual([TEST_VECTOR.headerDocId, TEST_VECTOR.commonDocId].sort());
    expect(await storedMedia()).toEqual(['drive', 'server']);
  });

  it('retires the server medium on a fresh drive-kind attestation', async () => {
    await seedVault(['server', 'drive']);

    const applied = await transition(driveAttestation(), {
      media: ['drive'],
      driveConnectionId: TEST_VECTOR.driveConnectionId,
    });

    expect(applied.status).toBe('ok');
    expect(await storedMedia()).toEqual(['drive']);
    expect(await activeDocIds()).toEqual([]);
    expect(await retiredDocIds()).toEqual(
      [TEST_VECTOR.headerDocId, TEST_VECTOR.commonDocId].sort(),
    );
    expect(await purgeClockStarted()).toBe(true);
  });

  it('refuses to remove the drive medium on a drive-kind attestation, and accepts server-kind', async () => {
    await seedVault(['server', 'drive']);
    const removeDrive = { media: ['server'] as const, driveConnectionId: null };

    const refused = await transition(driveAttestation(), removeDrive);
    expect(refused.status).toBe('verification_failed');
    expect(await storedMedia()).toEqual(['drive', 'server']);

    const applied = await transition(serverAttestation(), removeDrive);
    expect(applied.status).toBe('ok');
    expect(await storedMedia()).toEqual(['server']);
    // Removing drive retires nothing: only the server medium has a recovery set.
    expect(await retiredDocIds()).toEqual([]);
    expect(await purgeClockStarted()).toBe(false);
    expect(await activeDocIds()).toEqual([TEST_VECTOR.headerDocId, TEST_VECTOR.commonDocId].sort());
  });

  it('still refuses a stale surviving-kind attestation on `attestationsEqual`', async () => {
    await seedVault(['server', 'drive']);

    const stale = await transition(
      driveAttestation([
        { docId: TEST_VECTOR.headerDocId, docVersion: 2, writeId: TEST_VECTOR.headerWriteId },
        DOCS[1]!,
      ]),
      { media: ['drive'], driveConnectionId: TEST_VECTOR.driveConnectionId },
    );

    expect(stale.status).toBe('verification_failed');
    expect(await retiredDocIds()).toEqual([]);
    expect(await purgeClockStarted()).toBe(false);
  });

  it('leaves an ADDITION unaffected: nothing is removed, so either readback kind stands', async () => {
    // Deliberately narrower than the wire contract, which additionally derives
    // `drive` as the required kind for `added = ['drive']`. Rule 2 asks only
    // about removals, so the repository gate does not reach further than that.
    await seedVault(['server']);

    const applied = await transition(
      serverAttestation(),
      { media: ['server', 'drive'], driveConnectionId: TEST_VECTOR.driveConnectionId },
      { media: ['server'], driveConnectionId: null },
    );

    expect(applied.status).toBe('ok');
    expect(await storedMedia()).toEqual(['drive', 'server']);
  });
});

/**
 * §7 rule 2, the Drive half (#1987). A `drive`-kind readback proves a fresh copy
 * only on the connection it was read from, so the attestation must name the
 * connection the post-state KEEPS (`next.driveConnectionId`). The wire contract
 * has always refused the mismatch; before #1987 the repository did not, so a
 * non-HTTP caller could retire the server copy — starting the 7-day purge clock
 * — on a readback from a different Drive account of the same owner.
 */
describe('§7 rule 2 — the drive attestation must name the SURVIVING Drive connection', () => {
  const REMOVE_SERVER = {
    media: ['drive'] as const,
    driveConnectionId: TEST_VECTOR.driveConnectionId,
  };
  const BOTH_MEDIA = {
    media: ['server', 'drive'] as const,
    driveConnectionId: TEST_VECTOR.driveConnectionId,
  };

  it('refuses to retire the server medium on a readback from a DIFFERENT connection', async () => {
    await seedVault(['server', 'drive']);

    const refused = await transition(
      driveAttestation(DOCS, TEST_VECTOR.otherDriveConnectionId),
      REMOVE_SERVER,
      BOTH_MEDIA,
    );

    expect(refused.status).toBe('verification_failed');
    // Nothing retired, no purge clock, the server copy still active and selected.
    expect(await retiredDocIds()).toEqual([]);
    expect(await purgeClockStarted()).toBe(false);
    expect(await activeDocIds()).toEqual([TEST_VECTOR.headerDocId, TEST_VECTOR.commonDocId].sort());
    expect(await storedMedia()).toEqual(['drive', 'server']);
  });

  it('agrees with the wire edge-by-edge on the attested connection id', async () => {
    await seedVault(['server', 'drive']);

    // The mismatch runs FIRST and on purpose: it must be refused against a state
    // it does not change, so the second row's acceptance is attributable to the
    // attested connection id alone and not to a CAS that has moved underneath.
    const matrix: Array<{ attested: string; wire: string; repo: string }> = [];
    for (const [attested, driveConnectionId] of [
      ['other', TEST_VECTOR.otherDriveConnectionId],
      ['surviving', TEST_VECTOR.driveConnectionId],
    ] as const) {
      const verification = driveAttestation(DOCS, driveConnectionId);
      const wire = perVaultMediaTransitionRequestSchema.safeParse(
        request(REMOVE_SERVER, BOTH_MEDIA, verification),
      );
      const repo = await transition(verification, REMOVE_SERVER, BOTH_MEDIA);
      matrix.push({
        attested,
        wire: wire.success ? 'accepted' : 'rejected',
        repo: repo.status,
      });
    }

    // The one-line agreement probe: both boundaries draw the same edge.
    expect(matrix.map((row) => row.wire === 'accepted')).toEqual(
      matrix.map((row) => row.repo === 'ok'),
    );
    expect(matrix).toEqual([
      { attested: 'other', wire: 'rejected', repo: 'verification_failed' },
      { attested: 'surviving', wire: 'accepted', repo: 'ok' },
    ]);
    // And the accepted edge is the one that actually retires the bytes.
    expect(await storedMedia()).toEqual(['drive']);
    expect(await retiredDocIds()).toEqual(
      [TEST_VECTOR.headerDocId, TEST_VECTOR.commonDocId].sort(),
    );
    expect(await purgeClockStarted()).toBe(true);
  });
});
