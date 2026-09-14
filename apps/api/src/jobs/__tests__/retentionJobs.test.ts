import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../logger';
import * as schema from '../../data/schema';
import { createAuditRepository } from '../../data/repositories/auditRepository';
import { createEmailLogRepository } from '../../data/repositories/emailLogRepository';
import { createNotificationDigestRepository } from '../../data/repositories/notificationDigestRepository';
import { createProblemRepository } from '../../data/repositories/problemRepository';
import { createUsageAnalyticsRepository } from '../../data/repositories/usageAnalyticsRepository';
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
  DIGEST_QUEUE_RETENTION_DAYS,
  type DataRetentionCleanupJobDeps,
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
const noProblems = { deleteOlderThan: async () => 0 };
const noUsageEvents = { deleteEventsOlderThan: async () => 0 };
const noDigestQueue = { deleteDeliveredOlderThan: async () => 0 };

function ctx(jobLogger: Logger = logger): JobContext {
  return {
    events: harness.ctx.events,
    deadLetter: {} as JobContext['deadLetter'],
    redis: harness.ctx.redis,
    logger: jobLogger,
    isFeatureEnabled: async () => true,
  };
}

describe('data.retentionCleanup', () => {
  it('is a daily, idempotently registered off-peak schedule', () => {
    const job = createDataRetentionCleanupJob({
      audit: { deleteOlderThan: vi.fn() },
      emailLog: { deleteOlderThan: vi.fn() },
      vaultStaging: noVaultStaging,
      vaultCandidates: noVaultCandidates,
      digestQueue: noDigestQueue,
      users: noUsers,
      problems: noProblems,
      usageEvents: noUsageEvents,
      problemRetentionDays: 0,
      usageEventRetentionDays: 0,
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
      digestQueue: noDigestQueue,
      users: noUsers,
      problems: noProblems,
      usageEvents: noUsageEvents,
      problemRetentionDays: 0,
      usageEventRetentionDays: 0,
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
      digestQueue: noDigestQueue,
      users: noUsers,
      problems: noProblems,
      usageEvents: noUsageEvents,
      problemRetentionDays: 0,
      usageEventRetentionDays: 0,
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
      digestQueue: noDigestQueue,
      users: noUsers,
      problems: noProblems,
      usageEvents: noUsageEvents,
      problemRetentionDays: 0,
      usageEventRetentionDays: 0,
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
        problemsPruned: 0,
        usageEventsPruned: 0,
        digestQueuePruned: 0,
        deferredToNextRun: false,
      },
      'expired audit, email-log, problem, usage-event and delivered digest-queue rows pruned; abandoned vault-staging rows examined; expired vault candidates disposed',
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
      digestQueue: noDigestQueue,
      users: noUsers,
      problems: noProblems,
      usageEvents: noUsageEvents,
      problemRetentionDays: 0,
      usageEventRetentionDays: 0,
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

  /**
   * §13.5 V5-P2 arc (d): the capture's rate cap bounds how fast `problems`
   * grows, never how big it gets, and raw `usage_events` — a per-user viewing
   * history — had no time-based sweep at all. Both now age out on the existing
   * daily cron, and only the rows past the window may go.
   */
  it('prunes problems past their window and leaves the recent ones', async () => {
    const repo = createProblemRepository(harness.db);
    const seen = (daysAgo: number, fingerprint: string) => ({
      fingerprint,
      kind: 'error' as const,
      title: 'Error',
      message: fingerprint,
      context: null,
      seenAt: new Date(NOW.getTime() - daysAgo * DAY_MS),
      occurrences: 1,
    });
    await repo.upsert(seen(91, 'stale-open'));
    await repo.upsert(seen(400, 'ancient'));
    await repo.upsert(seen(89, 'recent'));

    const job = createDataRetentionCleanupJob({
      audit: { deleteOlderThan: vi.fn() },
      emailLog: { deleteOlderThan: vi.fn() },
      vaultStaging: noVaultStaging,
      vaultCandidates: noVaultCandidates,
      digestQueue: noDigestQueue,
      problems: repo,
      usageEvents: noUsageEvents,
      users: noUsers,
      auditRetentionDays: 0,
      emailLogRetentionDays: 0,
      problemRetentionDays: 90,
      usageEventRetentionDays: 0,
      batchSize: 1,
      now: () => NOW,
    });

    const summary = await job.handler({} as never, ctx());

    expect((await harness.db.select().from(schema.problems)).map((row) => row.fingerprint)).toEqual(
      ['recent'],
    );
    expect(summary).toMatchObject({ problemsPruned: 2 });
  });

  it('prunes raw usage events past their window and keeps the rollup', async () => {
    const user = await harness.seedUser({ email: 'usage@bt.test', username: 'usage_user' });
    const day = (daysAgo: number) =>
      new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString().slice(0, 10);
    await harness.db.insert(schema.usageEvents).values([
      { userId: user.id, feature: 'assets.view', assetId: 'AAPL', day: day(181), hits: 3 },
      { userId: user.id, feature: 'assets.view', assetId: 'MSFT', day: day(400), hits: 1 },
      { userId: user.id, feature: 'assets.view', assetId: 'SAP', day: day(179), hits: 2 },
    ]);
    await harness.db
      .insert(schema.usageDaily)
      .values([{ day: day(400), feature: '*', events: 1, activeUsers: 1 }]);

    const job = createDataRetentionCleanupJob({
      audit: { deleteOlderThan: vi.fn() },
      emailLog: { deleteOlderThan: vi.fn() },
      vaultStaging: noVaultStaging,
      vaultCandidates: noVaultCandidates,
      digestQueue: noDigestQueue,
      problems: noProblems,
      usageEvents: createUsageAnalyticsRepository(harness.db, harness.db),
      users: noUsers,
      auditRetentionDays: 0,
      emailLogRetentionDays: 0,
      problemRetentionDays: 0,
      usageEventRetentionDays: 180,
      batchSize: 1,
      now: () => NOW,
    });

    const summary = await job.handler({} as never, ctx());

    expect((await harness.db.select().from(schema.usageEvents)).map((row) => row.assetId)).toEqual([
      'SAP',
    ]);
    // The aggregate rollup the analytics page reads is deliberately untouched.
    expect(await harness.db.select().from(schema.usageDaily)).toHaveLength(1);
    expect(summary).toMatchObject({ usageEventsPruned: 2 });
  });

  it('stays silent when no sweep found anything to dispose', async () => {
    const info = vi.fn();
    const job = createDataRetentionCleanupJob({
      audit: { deleteOlderThan: vi.fn() },
      emailLog: { deleteOlderThan: vi.fn() },
      vaultStaging: noVaultStaging,
      vaultCandidates: noVaultCandidates,
      digestQueue: noDigestQueue,
      users: noUsers,
      problems: noProblems,
      usageEvents: noUsageEvents,
      problemRetentionDays: 0,
      usageEventRetentionDays: 0,
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
      digestQueue: noDigestQueue,
      users,
      problems: noProblems,
      usageEvents: noUsageEvents,
      problemRetentionDays: 0,
      usageEventRetentionDays: 0,
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

/**
 * The digest queue (§13.5 V5-P3) was the one operational table with no sweep
 * (#1696): a claim only stamps `delivered_at`, so every delivered row — each
 * carrying a fully rendered title/body — stayed forever, one row per
 * notification × outbound channel plus one per quiet-hours deferral. These
 * prove the drain is bounded, cut on the DELIVERY instant, and that the pending
 * set (the live work list) is untouchable.
 */
describe('data.retentionCleanup — delivered digest-queue rows (#1696)', () => {
  /** A queue row `deliveredDaysAgo` days old, or still pending when null. */
  function queueRow(userId: string, title: string, deliveredDaysAgo: number | null) {
    return {
      userId,
      type: 'friend.request',
      channel: 'email' as const,
      cadence: 'daily' as const,
      period: 'd:2026-01-01',
      title,
      body: 'alice sent you a friend request.',
      // Created long before the window in every case: age alone must not decide.
      createdAt: new Date(NOW.getTime() - 400 * DAY_MS),
      deliveredAt:
        deliveredDaysAgo === null ? null : new Date(NOW.getTime() - deliveredDaysAgo * DAY_MS),
    };
  }

  async function queueTitles(): Promise<string[]> {
    const rows = await harness.db.select().from(schema.notificationDigestQueue);
    return rows.map((row) => row.title).sort();
  }

  function sweepWith(digestQueue: DataRetentionCleanupJobDeps['digestQueue']) {
    return createDataRetentionCleanupJob({
      audit: { deleteOlderThan: async () => 0 },
      emailLog: { deleteOlderThan: async () => 0 },
      vaultStaging: noVaultStaging,
      vaultCandidates: noVaultCandidates,
      digestQueue,
      users: noUsers,
      problems: noProblems,
      usageEvents: noUsageEvents,
      problemRetentionDays: 0,
      usageEventRetentionDays: 0,
      auditRetentionDays: 0,
      emailLogRetentionDays: 0,
      now: () => NOW,
    });
  }

  it('prunes rows delivered past the window and never a row still pending delivery', async () => {
    const user = await harness.seedUser({ email: 'digest@bt.test', username: 'digestsweep' });
    await harness.db.insert(schema.notificationDigestQueue).values([
      queueRow(user.id, 'expired-1', DIGEST_QUEUE_RETENTION_DAYS + 1),
      queueRow(user.id, 'expired-2', DIGEST_QUEUE_RETENTION_DAYS + 120),
      queueRow(user.id, 'inside-window', DIGEST_QUEUE_RETENTION_DAYS - 1),
      // A quiet-hours deferral queued 400 days ago and not yet released: older
      // than any cutoff, but sweeping it would silently drop a notification.
      {
        ...queueRow(user.id, 'still-pending', null),
        cadence: 'instant' as const,
        period: 'deferred',
        deliverAfter: new Date(NOW.getTime() + DAY_MS),
      },
    ]);

    const summary = await sweepWith(createNotificationDigestRepository(harness.db)).handler(
      {} as never,
      ctx(),
    );

    expect(summary).toMatchObject({ digestQueuePruned: 2 });
    expect(await queueTitles()).toEqual(['inside-window', 'still-pending']);
  });

  it('bounds the table: delivered periods past the horizon do not accumulate', async () => {
    const user = await harness.seedUser({ email: 'grow@bt.test', username: 'digestgrowth' });
    const repo = createNotificationDigestRepository(harness.db);
    const job = sweepWith(repo);

    // Twelve daily periods × three outbound channels, all delivered past the
    // horizon, arriving over twelve runs. Without a sweep this is monotonic.
    for (let period = 0; period < 12; period += 1) {
      await harness.db.insert(schema.notificationDigestQueue).values(
        (['email', 'push', 'webpush'] as const).map((channel) => ({
          ...queueRow(user.id, `p${period}-${channel}`, DIGEST_QUEUE_RETENTION_DAYS + 1 + period),
          channel,
        })),
      );
      await job.handler({} as never, ctx());
    }
    expect(await queueTitles()).toEqual([]);

    // …while the still-fresh period of the last run survives it untouched.
    await harness.db.insert(schema.notificationDigestQueue).values([queueRow(user.id, 'fresh', 1)]);
    await job.handler({} as never, ctx());
    expect(await queueTitles()).toEqual(['fresh']);
  });

  it('drains in bounded batches under the per-run ceiling, leaving the rest eligible', async () => {
    const limits: number[] = [];
    let remaining = 10;
    const table = {
      deleteDeliveredOlderThan: async (cutoff: Date, limit: number) => {
        expect(cutoff.getTime()).toBe(NOW.getTime() - DIGEST_QUEUE_RETENTION_DAYS * DAY_MS);
        limits.push(limit);
        const deleted = Math.min(limit, remaining);
        remaining -= deleted;
        return deleted;
      },
    };
    const job = createDataRetentionCleanupJob({
      audit: { deleteOlderThan: async () => 0 },
      emailLog: { deleteOlderThan: async () => 0 },
      vaultStaging: noVaultStaging,
      vaultCandidates: noVaultCandidates,
      digestQueue: table,
      users: noUsers,
      problems: noProblems,
      usageEvents: noUsageEvents,
      problemRetentionDays: 0,
      usageEventRetentionDays: 0,
      auditRetentionDays: 0,
      emailLogRetentionDays: 0,
      batchSize: 2,
      maxRowsPerRun: 4,
      now: () => NOW,
    });

    // One capped run: fixed-size batches, the ceiling stops it, the remainder is
    // deferred rather than dropped — and the next runs converge.
    expect(await job.handler({} as never, ctx())).toMatchObject({
      digestQueuePruned: 4,
      deferredToNextRun: 1,
    });
    expect(limits).toEqual([2, 2]);
    expect(remaining).toBe(6);

    await job.handler({} as never, ctx());
    await job.handler({} as never, ctx());
    const last = await job.handler({} as never, ctx());
    expect(remaining).toBe(0);
    expect(last).toMatchObject({ deferredToNextRun: 0 });
  });
});
