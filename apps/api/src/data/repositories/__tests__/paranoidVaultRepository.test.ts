import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../../db';
import { users } from '../../schema';
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

describe('paranoid vault repository media transaction', () => {
  async function makeParanoid(): Promise<void> {
    await db
      .update(users)
      .set({
        privacyMode: 'paranoid',
        paranoidMediaSet: ['server'],
        paranoidDriveAttestedVersion: null,
      })
      .where(eq(users.id, userId));
  }

  async function seedCurrentWithHistory(): Promise<void> {
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

  it('commits server → both → Drive-only with zero current/history ciphertext bytes', async () => {
    await makeParanoid();
    await seedCurrentWithHistory();

    const added = await repo.patchMedia({
      userId,
      proofVerified: true,
      expected: { mediaSet: ['server'], driveAttestedVersion: null },
      nextMediaSet: ['server', 'drive'],
      verification: { medium: 'drive', version: 2 },
      now: new Date('2026-07-26T10:00:00.000Z'),
    });
    expect(added).toEqual({
      status: 'ok',
      state: { mediaSet: ['server', 'drive'], driveAttestedVersion: null },
      idempotent: false,
    });
    expect((await repo.getCurrent(userId))?.version).toBe(2);
    expect((await repo.listHistory(userId)).items.map((row) => row.version)).toEqual([1]);

    await repo.compareAndSwap({
      userId,
      expectedVersion: 2,
      version: 3,
      formatVersion: 1,
      sizeBytes: 2,
      blob: blob('v3'),
      retention: RETENTION,
      now: T0,
    });
    const refreshed = await repo.patchMedia({
      userId,
      proofVerified: true,
      expected: { mediaSet: ['server', 'drive'], driveAttestedVersion: null },
      nextMediaSet: ['server', 'drive'],
      verification: { medium: 'drive', version: 3 },
      now: new Date('2026-07-26T10:00:30.000Z'),
    });
    expect(refreshed).toEqual({
      status: 'ok',
      state: { mediaSet: ['server', 'drive'], driveAttestedVersion: 3 },
      idempotent: false,
    });

    const driveOnly = await repo.patchMedia({
      userId,
      proofVerified: true,
      expected: { mediaSet: ['server', 'drive'], driveAttestedVersion: 3 },
      nextMediaSet: ['drive'],
      verification: { medium: 'drive', version: 3 },
      now: new Date('2026-07-26T10:01:00.000Z'),
    });
    expect(driveOnly).toEqual({
      status: 'ok',
      state: { mediaSet: ['drive'], driveAttestedVersion: 3 },
      idempotent: false,
    });
    expect(await repo.getCurrent(userId)).toBeNull();
    expect((await repo.listHistory(userId)).items).toEqual([]);
    expect(await repo.getMediaState(userId)).toEqual({
      privacyMode: 'paranoid',
      mediaState: { mediaSet: ['drive'], driveAttestedVersion: 3 },
    });

    const restored = await repo.addServerMedium({
      userId,
      version: 4,
      formatVersion: 1,
      sizeBytes: 2,
      blob: blob('v4'),
      now: new Date('2026-07-26T10:02:00.000Z'),
    });
    expect(restored).toEqual({
      status: 'ok',
      state: { mediaSet: ['server', 'drive'], driveAttestedVersion: 4 },
      idempotent: false,
    });
    expect((await repo.getCurrent(userId))?.blob.equals(blob('v4'))).toBe(true);
    expect((await repo.listHistory(userId)).items).toEqual([]);
  });

  it('fails closed on normal mode, stale state, fabricated verification, and an empty target', async () => {
    expect(
      await repo.patchMedia({
        userId,
        proofVerified: true,
        expected: { mediaSet: ['server'], driveAttestedVersion: null },
        nextMediaSet: ['server', 'drive'],
        verification: { medium: 'drive', version: 1 },
        now: T0,
      }),
    ).toEqual({ status: 'mode_required' });

    await makeParanoid();
    await seedCurrentWithHistory();
    expect(
      await repo.patchMedia({
        userId,
        proofVerified: true,
        expected: { mediaSet: ['server', 'drive'], driveAttestedVersion: 2 },
        nextMediaSet: ['drive'],
        verification: { medium: 'drive', version: 2 },
        now: T0,
      }),
    ).toMatchObject({ status: 'state_conflict' });
    expect(
      await repo.patchMedia({
        userId,
        proofVerified: true,
        expected: { mediaSet: ['server'], driveAttestedVersion: null },
        nextMediaSet: ['server', 'drive'],
        verification: { medium: 'server', version: 2 },
        now: T0,
      }),
    ).toMatchObject({ status: 'verification_failed' });
    expect(
      await repo.patchMedia({
        userId,
        proofVerified: true,
        expected: { mediaSet: ['server'], driveAttestedVersion: null },
        nextMediaSet: ['server', 'drive'],
        verification: { medium: 'drive', version: 99 },
        now: T0,
      }),
    ).toMatchObject({ status: 'verification_failed' });
    expect(
      await repo.patchMedia({
        userId,
        proofVerified: true,
        expected: { mediaSet: ['server'], driveAttestedVersion: null },
        nextMediaSet: [],
        verification: { medium: 'server', version: 2 },
        now: T0,
      }),
    ).toMatchObject({ status: 'verification_failed' });
    expect((await repo.getCurrent(userId))?.blob.equals(blob('v2'))).toBe(true);
    expect((await repo.listHistory(userId)).items).toHaveLength(1);
  });
});
