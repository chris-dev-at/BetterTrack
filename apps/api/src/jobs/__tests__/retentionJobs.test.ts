import { pino } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../logger';
import * as schema from '../../data/schema';
import { createAuditRepository } from '../../data/repositories/auditRepository';
import { createEmailLogRepository } from '../../data/repositories/emailLogRepository';
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

function ctx(): JobContext {
  return {
    events: harness.ctx.events,
    deadLetter: {} as JobContext['deadLetter'],
    redis: harness.ctx.redis,
    logger,
  };
}

describe('data.retentionCleanup', () => {
  it('is a daily, idempotently registered off-peak schedule', () => {
    const job = createDataRetentionCleanupJob({
      audit: { deleteOlderThan: vi.fn() },
      emailLog: { deleteOlderThan: vi.fn() },
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
      auditRetentionDays: 0,
      emailLogRetentionDays: 180,
      now: () => NOW,
    });

    await job.handler({} as never, ctx());

    expect(auditDelete).not.toHaveBeenCalled();
    expect(emailDelete).toHaveBeenCalledOnce();
  });
});
