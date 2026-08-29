import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../logger';
import * as schema from '../../data/schema';
import { createAuditRepository } from '../../data/repositories/auditRepository';
import { createEmailLogRepository } from '../../data/repositories/emailLogRepository';
import { createUserRepository, type UserRepository } from '../../data/repositories/userRepository';
import {
  pinQuickAuthMarkerKey,
  rememberedDeviceKey,
  rememberedDevicesForUserKey,
  REMEMBERED_DEVICE_TTL_SECONDS,
} from '../../services/auth/loginThrottle';
import { createTestApp, type TestHarness } from '../../testing/createTestApp';
import {
  createDataRetentionCleanupJob,
  DATA_RETENTION_CLEANUP_CRON,
  DATA_RETENTION_CLEANUP_SCHEDULER_ID,
  DATA_RETENTION_CLEANUP_TZ,
} from '../definitions/retentionJobs';
import type { JobContext } from '../types';

const NOW = new Date('2026-07-30T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const logger = pino({ level: 'silent' }) as unknown as Logger;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

/** A repository stub that resolves nothing — the sweep then has no work. */
const noUsers: Pick<UserRepository, 'listByIds'> = { listByIds: async () => [] };
const noVaultStaging = { cleanupExpiredEnableStaging: async () => 0 };
const noVaultCandidates = { cleanupExpiredServerCandidates: async () => 0 };

function ctx(jobLogger: Logger = logger): JobContext {
  return {
    events: harness.ctx.events,
    deadLetter: {} as JobContext['deadLetter'],
    redis: harness.ctx.redis,
    logger: jobLogger,
  };
}

describe('data.retentionCleanup', () => {
  it('is a daily, idempotently registered off-peak schedule', () => {
    const job = createDataRetentionCleanupJob({
      audit: { deleteOlderThan: vi.fn() },
      emailLog: { deleteOlderThan: vi.fn() },
      vaultStaging: noVaultStaging,
      vaultCandidates: noVaultCandidates,
      users: noUsers,
      auditRetentionDays: 400,
      emailLogRetentionDays: 180,
    });

    expect(job.schedule).toEqual({
      id: DATA_RETENTION_CLEANUP_SCHEDULER_ID,
      pattern: DATA_RETENTION_CLEANUP_CRON,
      tz: DATA_RETENTION_CLEANUP_TZ,
    });
  });

  it('drains expired PGlite rows in bounded batches, preserves the window, and converges', async () => {
    const audit = createAuditRepository(harness.db);
    const emailLog = createEmailLogRepository(harness.db);
    const auditDelete = vi.spyOn(audit, 'deleteOlderThan');
    const emailDelete = vi.spyOn(emailLog, 'deleteOlderThan');
    await harness.db.insert(schema.auditLog).values([
      { action: 'expired.1', createdAt: new Date(NOW.getTime() - 401 * DAY_MS) },
      { action: 'expired.2', createdAt: new Date(NOW.getTime() - 450 * DAY_MS) },
      { action: 'inside', createdAt: new Date(NOW.getTime() - 399 * DAY_MS) },
    ]);
    await harness.db.insert(schema.emailLog).values([
      {
        recipient: 'expired-1@bt.test',
        template: 'fixture',
        subject: 'Expired 1',
        status: 'sent',
        createdAt: new Date(NOW.getTime() - 181 * DAY_MS),
      },
      {
        recipient: 'expired-2@bt.test',
        template: 'fixture',
        subject: 'Expired 2',
        status: 'failed',
        createdAt: new Date(NOW.getTime() - 200 * DAY_MS),
      },
      {
        recipient: 'inside@bt.test',
        template: 'fixture',
        subject: 'Inside',
        status: 'sent',
        createdAt: new Date(NOW.getTime() - 179 * DAY_MS),
      },
    ]);
    const job = createDataRetentionCleanupJob({
      audit,
      emailLog,
      vaultStaging: noVaultStaging,
      vaultCandidates: noVaultCandidates,
      users: noUsers,
      auditRetentionDays: 400,
      emailLogRetentionDays: 180,
      batchSize: 1,
      now: () => NOW,
    });

    await job.handler({} as never, ctx());

    expect((await harness.db.select().from(schema.auditLog)).map((row) => row.action)).toEqual([
      'inside',
    ]);
    expect((await harness.db.select().from(schema.emailLog)).map((row) => row.recipient)).toEqual([
      'inside@bt.test',
    ]);
    // Two full one-row batches plus the empty terminating batch for each table.
    expect(auditDelete).toHaveBeenCalledTimes(3);
    expect(emailDelete).toHaveBeenCalledTimes(3);
    expect(auditDelete.mock.calls.every(([, limit]) => limit === 1)).toBe(true);
    expect(emailDelete.mock.calls.every(([, limit]) => limit === 1)).toBe(true);

    await job.handler({} as never, ctx());
    expect(auditDelete).toHaveBeenCalledTimes(4);
    expect(emailDelete).toHaveBeenCalledTimes(4);
  });

  it('treats a zero-day window as retain forever and never calls that repository', async () => {
    const auditDelete = vi.fn();
    const emailDelete = vi.fn().mockResolvedValue(0);
    const job = createDataRetentionCleanupJob({
      audit: { deleteOlderThan: auditDelete },
      emailLog: { deleteOlderThan: emailDelete },
      vaultStaging: noVaultStaging,
      vaultCandidates: noVaultCandidates,
      users: noUsers,
      auditRetentionDays: 0,
      emailLogRetentionDays: 180,
      now: () => NOW,
    });

    await job.handler({} as never, ctx());

    expect(auditDelete).not.toHaveBeenCalled();
    expect(emailDelete).toHaveBeenCalledOnce();
  });

  it('continues a full vault-staging batch and reports examined rows truthfully', async () => {
    const cleanupExpiredEnableStaging = vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    const info = vi.fn();
    const job = createDataRetentionCleanupJob({
      audit: { deleteOlderThan: vi.fn() },
      emailLog: { deleteOlderThan: vi.fn() },
      vaultStaging: { cleanupExpiredEnableStaging },
      vaultCandidates: noVaultCandidates,
      users: noUsers,
      auditRetentionDays: 0,
      emailLogRetentionDays: 0,
      batchSize: 2,
      now: () => NOW,
    });

    await job.handler({} as never, ctx({ info } as unknown as Logger));

    expect(cleanupExpiredEnableStaging).toHaveBeenNthCalledWith(1, NOW, 2);
    expect(cleanupExpiredEnableStaging).toHaveBeenNthCalledWith(2, NOW, 2);
    expect(info).toHaveBeenCalledWith(
      {
        auditPruned: 0,
        emailLogPruned: 0,
        abandonedVaultStagesExamined: 3,
        expiredVaultCandidatesDisposed: 0,
        deferredToNextRun: false,
      },
      'expired audit and email-log rows pruned; abandoned vault-staging rows examined; expired vault candidates disposed',
    );
  });

  /**
   * #1521: the #1491 retention ruling assumed staged per-vault candidates
   * expire on their own. They do not — lazy expiry only fires when the vault
   * is read again. This pass makes the TTL real for a vault nobody reads.
   */
  it('drains expired staged vault candidates in bounded batches and reports the count', async () => {
    const cleanupExpiredServerCandidates = vi
      .fn()
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0);
    const info = vi.fn();
    const job = createDataRetentionCleanupJob({
      audit: { deleteOlderThan: vi.fn() },
      emailLog: { deleteOlderThan: vi.fn() },
      vaultStaging: noVaultStaging,
      vaultCandidates: { cleanupExpiredServerCandidates },
      users: noUsers,
      auditRetentionDays: 0,
      emailLogRetentionDays: 0,
      batchSize: 2,
      now: () => NOW,
    });

    await job.handler({} as never, ctx({ info } as unknown as Logger));

    expect(cleanupExpiredServerCandidates.mock.calls).toEqual([
      [NOW, 2],
      [NOW, 2],
      [NOW, 2],
    ]);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ expiredVaultCandidatesDisposed: 4, deferredToNextRun: false }),
      expect.stringContaining('expired vault candidates disposed'),
    );
  });

  it('stays silent when no sweep found anything to dispose', async () => {
    const info = vi.fn();
    const job = createDataRetentionCleanupJob({
      audit: { deleteOlderThan: vi.fn() },
      emailLog: { deleteOlderThan: vi.fn() },
      vaultStaging: noVaultStaging,
      vaultCandidates: noVaultCandidates,
      users: noUsers,
      auditRetentionDays: 0,
      emailLogRetentionDays: 0,
      now: () => NOW,
    });

    await job.handler({} as never, ctx({ info } as unknown as Logger));

    expect(info).not.toHaveBeenCalled();
  });
});

/**
 * The pre-retention remembered-device population (§13.5 V5-P14, PL-01). Shipped
 * V4 code wrote `remember_dev:<id>` with no expiry and no index membership, so
 * a browser that never returns could keep an immortal, unenumerable binding.
 * None of these cases calls quick auth: reaching that population without future
 * browser activity is the whole point of the sweep.
 */
describe('data.retentionCleanup — legacy remembered-device bindings', () => {
  const ORPHAN_DEVICE = 'legacy-orphan-device';
  const LIVE_DEVICE = 'legacy-live-device';

  /** Write a binding exactly the way pre-retention code did: no TTL, no index. */
  async function seedLegacyBinding(deviceId: string, userId: string): Promise<void> {
    await harness.ctx.redis.set(rememberedDeviceKey(deviceId), userId);
    await harness.ctx.redis.set(pinQuickAuthMarkerKey(deviceId), '1');
  }

  async function seedPinUser(username: string): Promise<{ id: string }> {
    const user = await harness.seedUser({ email: `${username}@bt.test`, username });
    await createUserRepository(harness.db).setPin(user.id, `argon2-${username}`);
    return user;
  }

  function sweepJob(users: Pick<UserRepository, 'listByIds'>) {
    return createDataRetentionCleanupJob({
      audit: { deleteOlderThan: vi.fn().mockResolvedValue(0) },
      emailLog: { deleteOlderThan: vi.fn().mockResolvedValue(0) },
      vaultStaging: noVaultStaging,
      vaultCandidates: noVaultCandidates,
      users,
      auditRetentionDays: 0,
      emailLogRetentionDays: 0,
      now: () => NOW,
    });
  }

  it('indexes and bounds a legacy binding whose account can still be remembered', async () => {
    const user = await seedPinUser('legacy_live');
    await seedLegacyBinding(LIVE_DEVICE, user.id);
    expect(await harness.ctx.redis.ttl(rememberedDeviceKey(LIVE_DEVICE))).toBe(-1);

    await sweepJob(createUserRepository(harness.db)).handler({} as never, ctx());

    const indexKey = rememberedDevicesForUserKey(user.id);
    expect(await harness.ctx.redis.get(rememberedDeviceKey(LIVE_DEVICE))).toBe(user.id);
    expect(await harness.ctx.redis.smembers(indexKey)).toEqual([LIVE_DEVICE]);
    for (const key of [rememberedDeviceKey(LIVE_DEVICE), indexKey]) {
      const ttl = await harness.ctx.redis.ttl(key);
      expect(ttl).toBeGreaterThan(REMEMBERED_DEVICE_TTL_SECONDS - 60);
      expect(ttl).toBeLessThanOrEqual(REMEMBERED_DEVICE_TTL_SECONDS);
    }
  });

  it('deletes a legacy binding whose account is gone, suspended or PIN-less', async () => {
    const userRepo = createUserRepository(harness.db);
    const suspended = await seedPinUser('legacy_suspended');
    await userRepo.setStatus(suspended.id, 'disabled');
    const pinless = await harness.seedUser({
      email: 'pinless@bt.test',
      username: 'legacy_pinless',
    });
    await seedLegacyBinding(ORPHAN_DEVICE, '019826d1-0000-7000-8000-00000000dead');
    await seedLegacyBinding('legacy-suspended-device', suspended.id);
    await seedLegacyBinding('legacy-pinless-device', pinless.id);

    await sweepJob(userRepo).handler({} as never, ctx());

    for (const deviceId of [ORPHAN_DEVICE, 'legacy-suspended-device', 'legacy-pinless-device']) {
      expect(await harness.ctx.redis.get(rememberedDeviceKey(deviceId))).toBeNull();
      expect(await harness.ctx.redis.get(pinQuickAuthMarkerKey(deviceId))).toBeNull();
    }
    // Handing dead residue a fresh 400-day lease plus an index is exactly the
    // leftover this sweep exists to remove — no index may be manufactured.
    for (const userId of ['019826d1-0000-7000-8000-00000000dead', suspended.id, pinless.id]) {
      expect(await harness.ctx.redis.exists(rememberedDevicesForUserKey(userId))).toBe(0);
    }
  });

  it('leaves an already-bounded binding alone and makes a second run a no-op', async () => {
    const user = await seedPinUser('legacy_bounded');
    const indexKey = rememberedDevicesForUserKey(user.id);
    await harness.ctx.redis.set(rememberedDeviceKey('bounded-device'), user.id, 'EX', 900);
    await harness.ctx.redis.sadd(indexKey, 'bounded-device');
    await harness.ctx.redis.expire(indexKey, 900);
    await seedLegacyBinding(LIVE_DEVICE, user.id);
    const users = createUserRepository(harness.db);
    const listByIds = vi.spyOn(users, 'listByIds');

    await sweepJob(users).handler({} as never, ctx());

    // The bounded binding keeps its own shorter lease — it was never touched.
    const boundedTtl = await harness.ctx.redis.ttl(rememberedDeviceKey('bounded-device'));
    expect(boundedTtl).toBeGreaterThan(840);
    expect(boundedTtl).toBeLessThanOrEqual(900);
    expect(listByIds).toHaveBeenCalledTimes(2);

    listByIds.mockClear();
    await sweepJob(users).handler({} as never, ctx());

    // Nothing is at TTL -1 any more, so the second pass resolves no accounts
    // and issues no writes.
    expect(listByIds).not.toHaveBeenCalled();
    expect((await harness.ctx.redis.smembers(indexKey)).sort()).toEqual(
      [LIVE_DEVICE, 'bounded-device'].sort(),
    );
  });

  it('tears down its own upgrade when the account is deleted mid-sweep', async () => {
    const user = await seedPinUser('legacy_raced');
    const indexKey = rememberedDevicesForUserKey(user.id);
    await seedLegacyBinding(LIVE_DEVICE, user.id);
    const userRepo = createUserRepository(harness.db);
    let reads = 0;
    const racingUsers: Pick<UserRepository, 'listByIds'> = {
      async listByIds(ids) {
        const rows = await userRepo.listByIds(ids);
        if (reads++ === 0) {
          // Account deletion commits — and finishes its own post-delete sweep,
          // including the reverse-index reset — after the sweep classified the
          // account as rememberable but before its fence re-read.
          await harness.db.delete(schema.users).where(eq(schema.users.id, user.id));
          await harness.ctx.redis.del(indexKey);
        }
        return rows;
      },
    };

    await sweepJob(racingUsers).handler({} as never, ctx());

    expect(reads).toBe(2);
    expect(await harness.ctx.redis.get(rememberedDeviceKey(LIVE_DEVICE))).toBeNull();
    expect(await harness.ctx.redis.get(pinQuickAuthMarkerKey(LIVE_DEVICE))).toBeNull();
    // The index the sweep resurrected after deletion cleared it is gone again.
    expect(await harness.ctx.redis.exists(indexKey)).toBe(0);
  });
});
