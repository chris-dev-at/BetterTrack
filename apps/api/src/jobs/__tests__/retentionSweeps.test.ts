import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../logger';
import {
  API_KEY_REQUEST_LOG_RETENTION_DAYS,
  createApiKeyRequestLogCleanupJob,
} from '../definitions/apiKeyJobs';
import {
  WEBHOOK_DELIVERY_RETENTION_DAYS,
  createWebhookDeliveryCleanupJob,
} from '../definitions/webhookJobs';
import type { JobContext } from '../types';

/**
 * The two V5-P10 retention sweeps (§13.5) used to issue one unbounded
 * `DELETE … WHERE created_at < cutoff`: a single transaction over the whole
 * eligible range, which on the highest-volume table in the app (one row per
 * bearer request) is a long lock hold that can be killed before it converges.
 * These assert the bounded drain the `data.retentionCleanup` sweep already
 * uses: fixed-size batches, a per-run ceiling, and rows past the ceiling left
 * eligible for the next run rather than dropped.
 */

const NOW = new Date('2026-08-20T03:00:00.000Z');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A table of `rows` eligible rows that only ever deletes `limit` at a time. */
function boundedTable(rows: number) {
  let remaining = rows;
  const limits: number[] = [];
  return {
    limits,
    get remaining(): number {
      return remaining;
    },
    deleteOlderThan: vi.fn(async (_cutoff: Date, limit: number) => {
      limits.push(limit);
      const deleted = Math.min(limit, remaining);
      remaining -= deleted;
      return deleted;
    }),
  };
}

function ctx(): { context: JobContext; info: ReturnType<typeof vi.fn> } {
  const info = vi.fn();
  return { context: { logger: { info } as unknown as Logger } as JobContext, info };
}

describe('webhooks.deliveryCleanup bounded drain', () => {
  it('drains the cutoff in fixed batches and stops on the short batch', async () => {
    const table = boundedTable(5);
    const job = createWebhookDeliveryCleanupJob({
      deliveries: table,
      batchSize: 2,
      now: () => NOW,
    });
    const { context, info } = ctx();

    await job.handler({} as never, context);

    // Two full batches, one short batch proving nothing eligible remains.
    expect(table.limits).toEqual([2, 2, 2]);
    expect(table.remaining).toBe(0);
    expect(info).toHaveBeenCalledWith(
      { pruned: 5, deferredToNextRun: false },
      'expired webhook deliveries pruned',
    );
    // Every batch is cut against the same run cutoff: now − retention window.
    const cutoffs = table.deleteOlderThan.mock.calls.map(([cutoff]) => cutoff.getTime());
    expect(new Set(cutoffs)).toEqual(
      new Set([NOW.getTime() - WEBHOOK_DELIVERY_RETENTION_DAYS * MS_PER_DAY]),
    );
  });

  it('defers rows past the per-run ceiling to the next run instead of dropping them', async () => {
    const table = boundedTable(10);
    const job = createWebhookDeliveryCleanupJob({
      deliveries: table,
      batchSize: 2,
      maxRowsPerRun: 4,
      now: () => NOW,
    });
    const { context, info } = ctx();

    await job.handler({} as never, context);
    expect(table.limits).toEqual([2, 2]);
    expect(table.remaining).toBe(6);
    expect(info).toHaveBeenCalledWith(
      { pruned: 4, deferredToNextRun: true },
      'expired webhook deliveries pruned',
    );

    // The deferred rows stay eligible: the next runs continue and converge.
    await job.handler({} as never, ctx().context);
    await job.handler({} as never, ctx().context);
    expect(table.remaining).toBe(0);
  });

  it('refuses a mis-tuned batch/ceiling pair at construction', () => {
    const deliveries = boundedTable(0);
    expect(() => createWebhookDeliveryCleanupJob({ deliveries, batchSize: 0 })).toThrow(
      /positive integer/,
    );
    expect(() =>
      createWebhookDeliveryCleanupJob({ deliveries, batchSize: 500, maxRowsPerRun: 100 }),
    ).toThrow(/at least one batch wide/);
  });
});

describe('apiKeys.requestLogCleanup bounded drain', () => {
  it('drains the cutoff in fixed batches and stops on the short batch', async () => {
    const table = boundedTable(5);
    const job = createApiKeyRequestLogCleanupJob({
      requestLog: table,
      batchSize: 2,
      now: () => NOW,
    });
    const { context, info } = ctx();

    await job.handler({} as never, context);

    expect(table.limits).toEqual([2, 2, 2]);
    expect(table.remaining).toBe(0);
    expect(info).toHaveBeenCalledWith(
      { pruned: 5, deferredToNextRun: false },
      'expired api-key request-log rows pruned',
    );
    const cutoffs = table.deleteOlderThan.mock.calls.map(([cutoff]) => cutoff.getTime());
    expect(new Set(cutoffs)).toEqual(
      new Set([NOW.getTime() - API_KEY_REQUEST_LOG_RETENTION_DAYS * MS_PER_DAY]),
    );
  });

  it('defers rows past the per-run ceiling to the next run instead of dropping them', async () => {
    const table = boundedTable(10);
    const job = createApiKeyRequestLogCleanupJob({
      requestLog: table,
      batchSize: 2,
      maxRowsPerRun: 4,
      now: () => NOW,
    });
    const { context, info } = ctx();

    await job.handler({} as never, context);
    expect(table.limits).toEqual([2, 2]);
    expect(table.remaining).toBe(6);
    expect(info).toHaveBeenCalledWith(
      { pruned: 4, deferredToNextRun: true },
      'expired api-key request-log rows pruned',
    );

    await job.handler({} as never, ctx().context);
    await job.handler({} as never, ctx().context);
    expect(table.remaining).toBe(0);
  });

  it('refuses a mis-tuned batch/ceiling pair at construction', () => {
    const requestLog = boundedTable(0);
    expect(() => createApiKeyRequestLogCleanupJob({ requestLog, batchSize: 0 })).toThrow(
      /positive integer/,
    );
    expect(() =>
      createApiKeyRequestLogCleanupJob({ requestLog, batchSize: 500, maxRowsPerRun: 100 }),
    ).toThrow(/at least one batch wide/);
  });

  it('logs nothing when the window is already drained', async () => {
    const table = boundedTable(0);
    const job = createApiKeyRequestLogCleanupJob({ requestLog: table, now: () => NOW });
    const { context, info } = ctx();

    await job.handler({} as never, context);

    expect(table.limits).toEqual([500]);
    expect(info).not.toHaveBeenCalled();
  });
});
