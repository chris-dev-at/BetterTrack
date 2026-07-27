import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../../db';
import {
  paranoidVaultHistory,
  paranoidVaultServerCandidates,
  paranoidVaults,
  users,
} from '../../schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import {
  createParanoidVaultRepository,
  type ParanoidVaultRepository,
} from '../paranoidVaultRepository';

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION = { maxVersions: 10, maxAgeMs: 30 * DAY_MS };
const T0 = new Date('2026-07-24T10:00:00.000Z');

let harness: TestHarness;
let db: Database;
let repo: ParanoidVaultRepository;
let userId: string;

beforeEach(async () => {
  harness = await createTestApp();
  db = harness.db;
  repo = createParanoidVaultRepository(db);
  const user = await harness.seedUser({ email: 'vaulter@bt.test', username: 'vaulter' });
  userId = user.id;
});

function blob(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

describe('paranoid vault repository CAS', () => {
  it('returns null when no vault exists', async () => {
    expect(await repo.getCurrent(userId)).toBeNull();
  });

  it('creates the first blob and reads it back byte-identical', async () => {
    const bytes = blob('cipher-1');
    const result = await repo.compareAndSwap({
      userId,
      expectedVersion: null,
      version: 1,
      formatVersion: 1,
      sizeBytes: bytes.length,
      blob: bytes,
      retention: RETENTION,
      now: T0,
    });
    expect(result).toMatchObject({ status: 'ok', version: 1 });

    const row = await repo.getCurrent(userId);
    expect(row?.version).toBe(1);
    expect(row?.sizeBytes).toBe(bytes.length);
    expect(row?.blob.equals(bytes)).toBe(true);
    expect((await repo.listHistory(userId)).items).toHaveLength(0);
  });

  it('refuses a second create when a vault already exists', async () => {
    await repo.compareAndSwap({
      userId,
      expectedVersion: null,
      version: 1,
      formatVersion: 1,
      sizeBytes: 1,
      blob: blob('a'),
      retention: RETENTION,
      now: T0,
    });
    const result = await repo.compareAndSwap({
      userId,
      expectedVersion: null,
      version: 1,
      formatVersion: 1,
      sizeBytes: 1,
      blob: blob('b'),
      retention: RETENTION,
      now: T0,
    });
    expect(result).toEqual({ status: 'precondition_failed', currentVersion: 1 });
  });

  it('replaces on a matching precondition and archives the superseded blob', async () => {
    await repo.compareAndSwap({
      userId,
      expectedVersion: null,
      version: 1,
      formatVersion: 1,
      sizeBytes: 8,
      blob: blob('cipher-1'),
      retention: RETENTION,
      now: T0,
    });
    const result = await repo.compareAndSwap({
      userId,
      expectedVersion: 1,
      version: 2,
      formatVersion: 1,
      sizeBytes: 8,
      blob: blob('cipher-2'),
      retention: RETENTION,
      now: T0,
    });
    expect(result).toMatchObject({ status: 'ok', version: 2 });

    const row = await repo.getCurrent(userId);
    expect(row?.version).toBe(2);
    expect(row?.blob.equals(blob('cipher-2'))).toBe(true);

    const history = await repo.listHistory(userId);
    expect(history.items.map((h) => h.version)).toEqual([1]);
    expect((await repo.getHistory(userId, 1))?.blob.equals(blob('cipher-1'))).toBe(true);
  });

  it('rejects a stale precondition and never overwrites newer ciphertext', async () => {
    await repo.compareAndSwap({
      userId,
      expectedVersion: null,
      version: 1,
      formatVersion: 1,
      sizeBytes: 8,
      blob: blob('cipher-1'),
      retention: RETENTION,
      now: T0,
    });
    await repo.compareAndSwap({
      userId,
      expectedVersion: 1,
      version: 2,
      formatVersion: 1,
      sizeBytes: 8,
      blob: blob('cipher-2'),
      retention: RETENTION,
      now: T0,
    });
    // A writer still holding version 1 tries to replace — must lose the race.
    const stale = await repo.compareAndSwap({
      userId,
      expectedVersion: 1,
      version: 2,
      formatVersion: 1,
      sizeBytes: 8,
      blob: blob('stale-overwrite'),
      retention: RETENTION,
      now: T0,
    });
    expect(stale).toEqual({ status: 'precondition_failed', currentVersion: 2 });
    const row = await repo.getCurrent(userId);
    expect(row?.version).toBe(2);
    expect(row?.blob.equals(blob('cipher-2'))).toBe(true);
  });

  it('bounds the history to the newest N versions', async () => {
    const retention = { maxVersions: 2, maxAgeMs: 3650 * DAY_MS };
    await repo.compareAndSwap({
      userId,
      expectedVersion: null,
      version: 1,
      formatVersion: 1,
      sizeBytes: 1,
      blob: blob('v1'),
      retention,
      now: T0,
    });
    for (let v = 2; v <= 5; v += 1) {
      await repo.compareAndSwap({
        userId,
        expectedVersion: v - 1,
        version: v,
        formatVersion: 1,
        sizeBytes: 1,
        blob: blob(`v${v}`),
        retention,
        now: T0,
      });
    }
    // Archived versions were 1..4; the count bound keeps the newest 2.
    const history = await repo.listHistory(userId);
    expect(history.items.map((h) => h.version)).toEqual([4, 3]);
    expect((await repo.getCurrent(userId))?.version).toBe(5);
  });

  it('caps and keyset-paginates metadata reads, then owner-scopes one blob read', async () => {
    const retention = { maxVersions: 100, maxAgeMs: 3650 * DAY_MS };
    await repo.compareAndSwap({
      userId,
      expectedVersion: null,
      version: 1,
      formatVersion: 1,
      sizeBytes: 2,
      blob: blob('v1'),
      retention,
      now: T0,
    });
    for (let version = 2; version <= 14; version += 1) {
      const bytes = blob(`v${version}`);
      await repo.compareAndSwap({
        userId,
        expectedVersion: version - 1,
        version,
        formatVersion: 1,
        sizeBytes: bytes.length,
        blob: bytes,
        retention,
        now: T0,
      });
    }

    const first = await repo.listHistory(userId, { limit: 1000 });
    expect(first.items.map((row) => row.version)).toEqual([13, 12, 11, 10, 9, 8, 7, 6, 5, 4]);
    expect(first.nextCursor).toBe(4);
    expect(first.items[0]).toEqual({
      version: 13,
      sizeBytes: 3,
      createdAt: T0,
    });
    expect(first.items[0]).not.toHaveProperty('blob');
    expect(first.items[0]).not.toHaveProperty('formatVersion');

    const second = await repo.listHistory(userId, { cursor: first.nextCursor!, limit: 1000 });
    expect(second.items.map((row) => row.version)).toEqual([3, 2, 1]);
    expect(second.nextCursor).toBeNull();

    expect((await repo.getHistory(userId, 7))?.blob.equals(blob('v7'))).toBe(true);
    const other = await harness.seedUser({ email: 'other@bt.test', username: 'other' });
    expect(await repo.getHistory(other.id, 7)).toBeNull();
  });

  it('bounds the history by age', async () => {
    const retention = { maxVersions: 100, maxAgeMs: 30 * DAY_MS };
    await repo.compareAndSwap({
      userId,
      expectedVersion: null,
      version: 1,
      formatVersion: 1,
      sizeBytes: 1,
      blob: blob('v1'),
      retention,
      now: T0,
    });
    // Archive v1 at T0.
    await repo.compareAndSwap({
      userId,
      expectedVersion: 1,
      version: 2,
      formatVersion: 1,
      sizeBytes: 1,
      blob: blob('v2'),
      retention,
      now: T0,
    });
    // 40 days later: archive v2 fresh, and the age prune drops v1 (older than 30d).
    const later = new Date(T0.getTime() + 40 * DAY_MS);
    await repo.compareAndSwap({
      userId,
      expectedVersion: 2,
      version: 3,
      formatVersion: 1,
      sizeBytes: 1,
      blob: blob('v3'),
      retention,
      now: later,
    });
    const history = await repo.listHistory(userId);
    expect(history.items.map((h) => h.version)).toEqual([2]);
  });
});

describe('paranoid vault media retirement', () => {
  async function makeParanoidServerVault(): Promise<void> {
    await db
      .update(users)
      .set({
        privacyMode: 'paranoid',
        paranoidMediaSet: ['server'],
        paranoidDriveAttestedVersion: null,
      })
      .where(eq(users.id, userId));
    await repo.compareAndSwap({
      userId,
      expectedVersion: null,
      version: 1,
      formatVersion: 1,
      sizeBytes: 2,
      blob: blob('v1'),
      retention: RETENTION,
      now: T0,
    });
    await repo.compareAndSwap({
      userId,
      expectedVersion: 1,
      version: 2,
      formatVersion: 1,
      sizeBytes: 2,
      blob: blob('v2'),
      retention: RETENTION,
      now: T0,
    });
  }

  it('atomically retires the live blob and all history without deleting bytes', async () => {
    await makeParanoidServerVault();

    expect(
      await repo.transitionMedia({
        userId,
        expectedMediaSet: ['server'],
        mediaSet: ['server', 'drive'],
        driveAttestedVersion: 2,
        expectedServerVersion: 2,
        now: T0,
      }),
    ).toEqual({ status: 'ok', idempotent: false });

    const retiredAt = new Date(T0.getTime() + DAY_MS);
    expect(
      await repo.transitionMedia({
        userId,
        expectedMediaSet: ['server', 'drive'],
        mediaSet: ['drive'],
        driveAttestedVersion: 2,
        expectedServerVersion: 2,
        now: retiredAt,
      }),
    ).toEqual({ status: 'ok', idempotent: false });

    expect(await repo.getCurrent(userId)).toBeNull();
    const rows = await db
      .select()
      .from(paranoidVaultHistory)
      .where(eq(paranoidVaultHistory.userId, userId));
    expect(rows.map((row) => row.version).sort()).toEqual([1, 2]);
    expect(rows.every((row) => row.retiredAt?.getTime() === retiredAt.getTime())).toBe(true);
    expect((await repo.getHistory(userId, 2))?.blob.equals(blob('v2'))).toBe(true);
    expect(await repo.getMediaSnapshot(userId)).toMatchObject({
      mediaSet: ['drive'],
      driveAttestedVersion: 2,
      current: null,
      retiredHead: { version: 2 },
    });
  });

  it('rolls back media metadata and retirement together on a constraint failure', async () => {
    await makeParanoidServerVault();

    await expect(
      repo.transitionMedia({
        userId,
        expectedMediaSet: ['server'],
        mediaSet: ['drive'],
        // Deliberately violates the durable users check after retirement work
        // has run, proving the entire transaction rolls back.
        driveAttestedVersion: -1,
        expectedServerVersion: 2,
        now: T0,
      }),
    ).rejects.toThrow();

    expect((await repo.getCurrent(userId))?.blob.equals(blob('v2'))).toBe(true);
    expect((await repo.listHistory(userId)).items.map((row) => row.version)).toEqual([1]);
    expect(await repo.getMediaSnapshot(userId)).toMatchObject({
      mediaSet: ['server'],
      driveAttestedVersion: null,
      retiredHead: null,
    });
  });

  it('promotes an inactive candidate and re-retires an unchanged retained version', async () => {
    await makeParanoidServerVault();
    const firstRetirement = new Date(T0.getTime() + DAY_MS);
    await repo.transitionMedia({
      userId,
      expectedMediaSet: ['server'],
      mediaSet: ['drive'],
      driveAttestedVersion: 2,
      expectedServerVersion: 2,
      now: firstRetirement,
    });

    const staged = await repo.stageServerCandidate({
      userId,
      version: 2,
      formatVersion: 1,
      sizeBytes: 2,
      blob: blob('v2'),
      now: new Date(firstRetirement.getTime() + DAY_MS),
      expiresAt: new Date(firstRetirement.getTime() + 2 * DAY_MS),
    });
    expect(staged.status).toBe('ok');
    if (staged.status !== 'ok') throw new Error('candidate staging failed');

    expect(
      await repo.transitionMedia({
        userId,
        expectedMediaSet: ['drive'],
        mediaSet: ['server', 'drive'],
        driveAttestedVersion: 2,
        expectedServerVersion: 2,
        serverCandidateId: staged.candidate.id,
        now: new Date(firstRetirement.getTime() + DAY_MS),
      }),
    ).toEqual({ status: 'ok', idempotent: false });
    expect((await repo.getCurrent(userId))?.blob.equals(blob('v2'))).toBe(true);
    expect(
      await db
        .select()
        .from(paranoidVaultServerCandidates)
        .where(eq(paranoidVaultServerCandidates.userId, userId)),
    ).toHaveLength(0);

    const secondRetirement = new Date(firstRetirement.getTime() + 3 * DAY_MS);
    expect(
      await repo.transitionMedia({
        userId,
        expectedMediaSet: ['server', 'drive'],
        mediaSet: ['drive'],
        driveAttestedVersion: 2,
        expectedServerVersion: 2,
        now: secondRetirement,
      }),
    ).toEqual({ status: 'ok', idempotent: false });

    expect(await repo.getCurrent(userId)).toBeNull();
    const retained = await db
      .select()
      .from(paranoidVaultHistory)
      .where(eq(paranoidVaultHistory.userId, userId))
      .orderBy(paranoidVaultHistory.version);
    expect(retained.map((row) => row.version)).toEqual([1, 2]);
    expect(retained.filter((row) => row.version === 2)).toHaveLength(1);
    expect(retained.every((row) => row.retiredAt?.getTime() === secondRetirement.getTime())).toBe(
      true,
    );
  });

  it('physically expires an untouched inactive candidate without owner traffic', async () => {
    await makeParanoidServerVault();
    await repo.transitionMedia({
      userId,
      expectedMediaSet: ['server'],
      mediaSet: ['drive'],
      driveAttestedVersion: 2,
      expectedServerVersion: 2,
      now: T0,
    });
    const expiresAt = new Date(T0.getTime() + DAY_MS);
    const staged = await repo.stageServerCandidate({
      userId,
      version: 2,
      formatVersion: 1,
      sizeBytes: 2,
      blob: blob('v2'),
      now: T0,
      expiresAt,
    });
    expect(staged.status).toBe('ok');

    expect(await repo.deleteExpiredServerCandidates(new Date(expiresAt.getTime() - 1), 100)).toBe(
      0,
    );
    expect(await repo.deleteExpiredServerCandidates(expiresAt, 100)).toBe(1);
    expect(
      await db
        .select()
        .from(paranoidVaultServerCandidates)
        .where(eq(paranoidVaultServerCandidates.userId, userId)),
    ).toHaveLength(0);
  });

  it('rejects both purge gates, then removes every retired byte after the window', async () => {
    await makeParanoidServerVault();
    const retiredAt = new Date(T0.getTime() + DAY_MS);
    await repo.transitionMedia({
      userId,
      expectedMediaSet: ['server'],
      mediaSet: ['drive'],
      driveAttestedVersion: 2,
      expectedServerVersion: 2,
      now: retiredAt,
    });

    expect(
      await repo.purgeRetired({
        userId,
        proofVersion: 1,
        now: new Date(retiredAt.getTime() + 8 * DAY_MS),
        minRetirementAgeMs: 7 * DAY_MS,
      }),
    ).toEqual({ status: 'proof_version_too_old', latestVersion: 2 });
    expect(
      await repo.purgeRetired({
        userId,
        proofVersion: 2,
        now: new Date(retiredAt.getTime() + 6 * DAY_MS),
        minRetirementAgeMs: 7 * DAY_MS,
      }),
    ).toEqual({
      status: 'retention_not_met',
      eligibleAt: new Date(retiredAt.getTime() + 7 * DAY_MS),
    });
    expect(await repo.getHistory(userId, 2)).not.toBeNull();

    expect(
      await repo.purgeRetired({
        userId,
        proofVersion: 2,
        now: new Date(retiredAt.getTime() + 7 * DAY_MS),
        minRetirementAgeMs: 7 * DAY_MS,
      }),
    ).toEqual({ status: 'ok', purgedVersions: 2, purgedBytes: 4 });
    expect(await repo.getCurrent(userId)).toBeNull();
    expect(await repo.listHistory(userId)).toEqual({ items: [], nextCursor: null });
    expect(
      await db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, userId)),
    ).toHaveLength(0);
  });
});
