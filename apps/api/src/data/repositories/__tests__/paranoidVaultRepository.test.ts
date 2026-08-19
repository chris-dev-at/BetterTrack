import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '../../db';
import {
  paranoidEnableTransitions,
  paranoidVaultHistory,
  paranoidVaultRetired,
  paranoidVaultRetirements,
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
  await db
    .update(users)
    .set({
      privacyMode: 'paranoid',
      paranoidMediaSet: ['server'],
      paranoidDriveAttestedVersion: null,
    })
    .where(eq(users.id, userId));
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

describe('normal-mode enable staging access', () => {
  beforeEach(async () => {
    await db
      .update(users)
      .set({ privacyMode: 'normal', paranoidMediaSet: null, paranoidDriveAttestedVersion: null })
      .where(eq(users.id, userId));
  });

  it('fails closed until an owner capture opens a staging window', async () => {
    expect(await repo.readCurrent(userId, 'owner-session', T0)).toEqual({
      status: 'medium_inactive',
    });
    expect(await repo.readCurrent(userId, 'sync-bearer', T0)).toEqual({
      status: 'medium_inactive',
    });

    const denied = await repo.compareAndSwap({
      userId,
      access: 'owner-session',
      expectedVersion: null,
      version: 1,
      formatVersion: 1,
      sizeBytes: 1,
      blob: blob('x'),
      retention: RETENTION,
      now: T0,
    });
    expect(denied).toEqual({ status: 'medium_inactive' });
  });

  it('allows only the owner session while the enable window is live', async () => {
    await repo.beginEnableStaging({
      userId,
      now: T0,
      expiresAt: new Date(T0.getTime() + 10 * 60 * 1000),
    });
    expect(await repo.readCurrent(userId, 'owner-session', T0)).toEqual({ status: 'not_found' });

    const bytes = blob('staged-ciphertext');
    expect(
      await repo.compareAndSwap({
        userId,
        access: 'owner-session',
        expectedVersion: null,
        version: 1,
        formatVersion: 1,
        sizeBytes: bytes.length,
        blob: bytes,
        retention: RETENTION,
        now: T0,
      }),
    ).toMatchObject({ status: 'ok', version: 1 });
    expect(await repo.readCurrent(userId, 'owner-session', T0)).toMatchObject({
      status: 'ok',
      row: { version: 1 },
    });
    expect(await repo.readCurrent(userId, 'sync-bearer', T0)).toEqual({
      status: 'medium_inactive',
    });
  });

  it('physically deletes current and historical ciphertext when staging expires', async () => {
    await repo.beginEnableStaging({
      userId,
      now: T0,
      expiresAt: new Date(T0.getTime() + 1),
    });
    await repo.compareAndSwap({
      userId,
      access: 'owner-session',
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
      access: 'owner-session',
      expectedVersion: 1,
      version: 2,
      formatVersion: 1,
      sizeBytes: 2,
      blob: blob('v2'),
      retention: RETENTION,
      now: T0,
    });

    expect(await repo.readCurrent(userId, 'owner-session', new Date(T0.getTime() + 2))).toEqual({
      status: 'medium_inactive',
    });
    expect(await db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, userId))).toEqual(
      [],
    );
    expect(
      await db.select().from(paranoidVaultHistory).where(eq(paranoidVaultHistory.userId, userId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(paranoidEnableTransitions)
        .where(eq(paranoidEnableTransitions.userId, userId)),
    ).toEqual([]);
  });

  it('sweeps abandoned staging without waiting for another vault request', async () => {
    await repo.beginEnableStaging({
      userId,
      now: T0,
      expiresAt: new Date(T0.getTime() + 1),
    });
    await repo.compareAndSwap({
      userId,
      access: 'owner-session',
      expectedVersion: null,
      version: 1,
      formatVersion: 1,
      sizeBytes: 6,
      blob: blob('staged'),
      retention: RETENTION,
      now: T0,
    });

    expect(await repo.cleanupExpiredEnableStaging(new Date(T0.getTime() + 2), 10)).toBe(1);
    expect(await repo.getCurrent(userId)).toBeNull();
    expect(
      await db
        .select()
        .from(paranoidEnableTransitions)
        .where(eq(paranoidEnableTransitions.userId, userId)),
    ).toEqual([]);
  });

  it('counts examined rows when a selected staging window is refreshed before expiry', async () => {
    const stagedUsers = [];
    for (let index = 0; index < 3; index += 1) {
      const stagedUser = await harness.seedUser({
        email: `staging-race-${index}@bt.test`,
        username: `staging_race_${index}`,
      });
      stagedUsers.push(stagedUser);
      await repo.beginEnableStaging({
        userId: stagedUser.id,
        now: T0,
        expiresAt: new Date(T0.getTime() + index + 1),
      });
    }
    const cutoff = new Date(T0.getTime() + 10);
    const refreshedUntil = new Date(T0.getTime() + DAY_MS);
    const expireSelected = repo.expireEnableStaging.bind(repo);
    const expireSpy = vi.spyOn(repo, 'expireEnableStaging');
    expireSpy.mockImplementationOnce(async (selectedUserId, now) => {
      expect(selectedUserId).toBe(stagedUsers[0]!.id);
      await db
        .update(paranoidEnableTransitions)
        .set({ expiresAt: refreshedUntil, updatedAt: now })
        .where(eq(paranoidEnableTransitions.userId, selectedUserId));
      return expireSelected(selectedUserId, now);
    });

    expect(await repo.cleanupExpiredEnableStaging(cutoff, 2)).toBe(2);
    expect(await repo.cleanupExpiredEnableStaging(cutoff, 2)).toBe(1);

    expect(expireSpy).toHaveBeenCalledTimes(3);
    expect(
      await db
        .select()
        .from(paranoidEnableTransitions)
        .orderBy(paranoidEnableTransitions.expiresAt),
    ).toMatchObject([{ userId: stagedUsers[0]!.id, expiresAt: refreshedUntil }]);
  });
});

describe('durable paranoid media transitions', () => {
  it('rolls a conflicting server retirement back without losing active ciphertext', async () => {
    const proofKey = 'test-retirement-proof-key';
    const activeBytes = blob('active-v1');
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
      sizeBytes: activeBytes.length,
      blob: activeBytes,
      retirementProofPublicKey: proofKey,
      retention: RETENTION,
      now: T0,
    });
    const serverOnly = { mediaSet: ['server'] as Array<'server'>, driveAttestedVersion: null };
    const both = {
      mediaSet: ['server', 'drive'] as Array<'server' | 'drive'>,
      driveAttestedVersion: 1,
    };
    expect(
      await repo.transitionMedia({
        userId,
        expected: serverOnly,
        nextMediaSet: both.mediaSet,
        verification: { kind: 'drive', version: 1 },
        candidateReadbackVerified: false,
        now: T0,
      }),
    ).toMatchObject({ status: 'ok' });

    // A same-version retired row with different opaque bytes is the exact
    // uniqueness/conflict edge: the transaction must fail closed before it
    // deletes the active row or changes the durable media state.
    await db.insert(paranoidVaultRetirements).values({
      userId,
      retiredVersion: 1,
      retirementProofPublicKey: proofKey,
      retiredAt: T0,
    });
    await db.insert(paranoidVaultRetired).values({
      userId,
      version: 1,
      formatVersion: 1,
      sizeBytes: 9,
      blob: blob('different'),
      createdAt: T0,
      retiredAt: T0,
    });

    const failed = await repo.transitionMedia({
      userId,
      expected: both,
      nextMediaSet: ['drive'],
      verification: { kind: 'drive', version: 1 },
      candidateReadbackVerified: false,
      now: T0,
    });
    expect(failed).toMatchObject({ status: 'retirement_conflict' });
    expect((await repo.getCurrent(userId))?.blob.equals(activeBytes)).toBe(true);
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(user?.paranoidMediaSet).toEqual(['server', 'drive']);
    expect((await repo.getHistory(userId, 1))?.blob.equals(blob('different'))).toBe(true);
  });
});
