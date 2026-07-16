import { type Job, Worker } from 'bullmq';

import type { Logger } from '../logger';

import { type JobConnectionFactory } from './connection';
import { isPermanentFailure } from './deadLetter';
import type { JobContext, JobDefinition } from './types';

/**
 * Turns a list of {@link JobDefinition}s into running BullMQ workers
 * (PROJECTPLAN.md §9).
 *
 * Each worker gets its **own** connection (a worker holds a blocking connection
 * that cannot be shared) minted from the shared factory. On a permanent failure
 * — all attempts exhausted — the job is copied to the dead-letter list; earlier,
 * still-retryable failures are only logged so the backoff can do its job.
 */
export interface RunningWorkers {
  workers: Worker[];
  /** Gracefully stop every worker. */
  close(): Promise<void>;
}

export interface CreateJobWorkersDeps {
  /** Mints a fresh connection per worker. */
  createConnection: JobConnectionFactory;
  definitions: readonly JobDefinition[];
  ctx: JobContext;
  logger: Logger;
  /**
   * Error-tracking hook (§13.4 V4-P5a): called with the error when a job
   * PERMANENTLY fails (all attempts exhausted → dead-lettered), so BullMQ job
   * failures reach Sentry alongside API errors. A no-op when Sentry is disabled;
   * still-retryable attempt failures never fire it (that is normal backoff).
   */
  onPermanentFailure?: (err: unknown, meta: { queue: string; jobId?: string }) => void;
}

/**
 * The `failed` listener body, extracted so the permanent-failure branch — where
 * BullMQ job failures are dead-lettered AND reported to error tracking (§13.4
 * V4-P5a) — is unit-testable without a live BullMQ worker (which cannot run on
 * the test suite's ioredis-mock).
 */
export function handleWorkerFailure(params: {
  queue: string;
  job: Job | undefined;
  err: Error | undefined;
  ctx: JobContext;
  logger: Logger;
  onPermanentFailure?: (err: unknown, meta: { queue: string; jobId?: string }) => void;
}): void {
  const { queue, job, err, ctx, logger, onPermanentFailure } = params;
  if (job && isPermanentFailure(job)) {
    logger.error(
      { queue, jobId: job.id, attemptsMade: job.attemptsMade, err: err?.message },
      'job permanently failed — dead-lettering',
    );
    onPermanentFailure?.(err, { queue, jobId: job.id });
    void ctx.deadLetter
      .record({
        queue,
        jobId: job.id,
        name: job.name,
        data: job.data,
        failedReason: err?.message ?? job.failedReason ?? 'unknown',
        attemptsMade: job.attemptsMade,
        timestamp: Date.now(),
      })
      .catch((recordErr) => {
        logger.error({ queue, err: recordErr }, 'failed to write dead-letter entry');
      });
  } else {
    logger.warn(
      { queue, jobId: job?.id, attemptsMade: job?.attemptsMade, err: err?.message },
      'job attempt failed — will retry',
    );
  }
}

export function createJobWorkers(deps: CreateJobWorkersDeps): RunningWorkers {
  const { createConnection, definitions, ctx, logger, onPermanentFailure } = deps;

  const workers = definitions.map((def) => {
    const worker = new Worker(
      def.name,
      async (job: Job) => {
        await def.handler(job as never, ctx);
      },
      { connection: createConnection(), ...def.workerOptions },
    );

    worker.on('failed', (job, err) => {
      handleWorkerFailure({ queue: def.name, job, err, ctx, logger, onPermanentFailure });
    });

    worker.on('error', (err) => {
      logger.error({ queue: def.name, err }, 'worker error');
    });

    return worker;
  });

  return {
    workers,
    async close(): Promise<void> {
      await Promise.all(workers.map((w) => w.close()));
    },
  };
}
