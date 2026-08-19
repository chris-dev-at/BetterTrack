import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VAULT_RETIRED_SERVER_MIN_RETENTION_MS } from '@bettertrack/contracts';

import type { Database } from '../../data/db';
import {
  paranoidVaultHistory,
  paranoidVaultRetired,
  paranoidVaultRetirements,
  paranoidVaults,
  users,
} from '../../data/schema';
import {
  createParanoidVaultRepository,
  type ParanoidVaultRepository,
} from '../../data/repositories/paranoidVaultRepository';
import type { Logger } from '../../logger';
import { createTestApp, type TestHarness } from '../../testing/createTestApp';
import {
  createParanoidRetiredPurgeJob,
  PARANOID_RETIRED_PURGE_CRON,
  PARANOID_RETIRED_PURGE_SCHEDULER_ID,
  PARANOID_RETIRED_PURGE_TZ,
} from '../paranoidJobs';
import type { JobContext } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-08-01T10:00:00.000Z');
const RUN_AT = new Date(T0.getTime() + VAULT_RETIRED_SERVER_MIN_RETENTION_MS);
const RETENTION = { maxVersions: 10, maxAgeMs: 30 * DAY_MS };
const PROOF_KEY = 'retirement-proof-public-key';
const logger = pino({ level: 'silent' }) as unknown as Logger;

let harness: TestHarness;
let db: Database;
let vaults: ParanoidVaultRepository;

beforeEach(async () => {
  harness = await createTestApp();
  db = harness.db;
  vaults = createParanoidVaultRepository(db);
});

function ctx(): JobContext {
  return {
    events: harness.ctx.events,
    deadLetter: {} as JobContext['deadLetter'],
    redis: harness.ctx.redis,
    logger,
  };
}

function blob(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

async function seedParanoidUser(name: string): Promise<string> {
  const user = await harness.seedUser({ email: `${name}@bt.test`, username: name });
  await db
    .update(users)
    .set({
      privacyMode: 'paranoid',
      paranoidMediaSet: ['server'],
      paranoidDriveAttestedVersion: null,
    })
    .where(eq(users.id, user.id));
  return user.id;
}

async function writeServerVault(
  userId: string,
  values: readonly string[],
  now: Date,
): Promise<number> {
  for (const [index, value] of values.entries()) {
    const bytes = blob(value);
    const version = index + 1;
    expect(
      await vaults.compareAndSwap({
        userId,
        expectedVersion: version === 1 ? null : version - 1,
        version,
        formatVersion: 1,
        sizeBytes: bytes.length,
        blob: bytes,
        retirementProofPublicKey: PROOF_KEY,
        retention: RETENTION,
        now,
      }),
    ).toMatchObject({ status: 'ok', version });
  }
  return values.length;
}

async function retireServerVault(
  userId: string,
  values: readonly string[],
  now: Date,
): Promise<number> {
  const retiredVersion = await writeServerVault(userId, values, now);
  const serverOnly = { mediaSet: ['server'] as Array<'server'>, driveAttestedVersion: null };
  const both = {
    mediaSet: ['server', 'drive'] as Array<'server' | 'drive'>,
    driveAttestedVersion: retiredVersion,
  };
  expect(
    await vaults.transitionMedia({
      userId,
      expected: serverOnly,
      nextMediaSet: both.mediaSet,
      verification: { kind: 'drive', version: retiredVersion },
      candidateReadbackVerified: false,
      now,
    }),
  ).toMatchObject({ status: 'ok' });
  expect(
    await vaults.transitionMedia({
      userId,
      expected: both,
      nextMediaSet: ['drive'],
      verification: { kind: 'drive', version: retiredVersion },
      candidateReadbackVerified: false,
      now,
    }),
  ).toMatchObject({ status: 'ok' });
  return retiredVersion;
}

async function reAddServerVault(
  userId: string,
  retiredVersion: number,
  latestValue: string,
): Promise<void> {
  const bytes = blob(latestValue);
  const staged = await vaults.stageServerCandidate({
    userId,
    version: retiredVersion,
    formatVersion: 1,
    sizeBytes: bytes.length,
    blob: bytes,
    retirementProofPublicKey: PROOF_KEY,
    now: new Date(T0.getTime() + 1),
    expiresAt: new Date(T0.getTime() + 10 * 60 * 1000),
  });
  expect(staged).toMatchObject({ status: 'ok' });
  if (staged.status !== 'ok') throw new Error('server candidate was not staged');

  expect(
    await vaults.transitionMedia({
      userId,
      expected: { mediaSet: ['drive'], driveAttestedVersion: retiredVersion },
      nextMediaSet: ['server', 'drive'],
      verification: {
        kind: 'server-candidate',
        candidateId: staged.candidate.id,
        readback: 'verified-candidate-readback-receipt',
      },
      candidateReadbackVerified: true,
      now: new Date(T0.getTime() + 2),
    }),
  ).toMatchObject({ status: 'ok' });
}

async function retiredRows(userId: string) {
  return db.select().from(paranoidVaultRetired).where(eq(paranoidVaultRetired.userId, userId));
}

async function retirementRows(userId: string) {
  return db
    .select()
    .from(paranoidVaultRetirements)
    .where(eq(paranoidVaultRetirements.userId, userId));
}

describe('paranoid.retiredPurge', () => {
  it('is an hourly, idempotently registered automatic-retirement schedule', () => {
    const job = createParanoidRetiredPurgeJob({ vaults });

    expect(job.schedule).toEqual({
      id: PARANOID_RETIRED_PURGE_SCHEDULER_ID,
      pattern: PARANOID_RETIRED_PURGE_CRON,
      tz: PARANOID_RETIRED_PURGE_TZ,
    });
  });

  it('purges an elapsed retirement once and makes a second run a clean no-op', async () => {
    const userId = await seedParanoidUser('elapsed_once');
    await retireServerVault(userId, ['retired-v1', 'retired-v2'], T0);
    const purge = vi.spyOn(vaults, 'purgeElapsedRetirement');
    const job = createParanoidRetiredPurgeJob({ vaults, now: () => RUN_AT });

    await job.handler({} as never, ctx());
    expect(await retiredRows(userId)).toEqual([]);
    expect(await retirementRows(userId)).toEqual([]);
    expect(purge).toHaveBeenCalledOnce();

    await job.handler({} as never, ctx());
    expect(purge).toHaveBeenCalledOnce();
    expect(await retiredRows(userId)).toEqual([]);
    expect(await retirementRows(userId)).toEqual([]);
  });

  it('purges only elapsed Drive-only rows and skips re-added or otherwise live server media', async () => {
    const elapsedUserId = await seedParanoidUser('elapsed_target');
    await retireServerVault(elapsedUserId, ['elapsed-v1', 'elapsed-v2'], T0);

    const futureUserId = await seedParanoidUser('future_other');
    await retireServerVault(futureUserId, ['future-v1', 'future-v2'], new Date(T0.getTime() + 1));

    const reAddedUserId = await seedParanoidUser('server_readded');
    const reAddedVersion = await retireServerVault(reAddedUserId, ['readded-v1', 'readded-v2'], T0);
    await reAddServerVault(reAddedUserId, reAddedVersion, 'readded-v2');

    const liveUserId = await seedParanoidUser('live_never_retired');
    await writeServerVault(liveUserId, ['live-v1', 'live-v2'], T0);

    const purge = vi.spyOn(vaults, 'purgeElapsedRetirement');
    const job = createParanoidRetiredPurgeJob({ vaults, now: () => RUN_AT, batchSize: 1 });
    await job.handler({} as never, ctx());

    expect(await retiredRows(elapsedUserId)).toEqual([]);
    expect(await retirementRows(elapsedUserId)).toEqual([]);

    // One millisecond inside the seven-day window is still protected, and an
    // owner-scoped purge must not spill into this other user's rows.
    expect(await retiredRows(futureUserId)).toHaveLength(2);
    expect(await retirementRows(futureUserId)).toHaveLength(1);
    expect(purge).not.toHaveBeenCalledWith(expect.objectContaining({ userId: futureUserId }));

    // The scan saw this elapsed retirement, but its locked recheck found the
    // server medium had been restored and skipped both the live row and the
    // retained recovery set.
    expect(purge).toHaveBeenCalledWith(
      expect.objectContaining({ userId: reAddedUserId, retiredVersion: reAddedVersion }),
    );
    expect(await retiredRows(reAddedUserId)).toHaveLength(2);
    expect(await retirementRows(reAddedUserId)).toHaveLength(1);
    expect(
      await db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, reAddedUserId)),
    ).toMatchObject([{ version: reAddedVersion }]);

    // A live vault that never entered retirement is outside the scan entirely.
    expect(purge).not.toHaveBeenCalledWith(expect.objectContaining({ userId: liveUserId }));
    expect(
      await db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, liveUserId)),
    ).toMatchObject([{ version: 2 }]);
    expect(
      await db
        .select()
        .from(paranoidVaultHistory)
        .where(eq(paranoidVaultHistory.userId, liveUserId)),
    ).toMatchObject([{ version: 1 }]);
  });
});
