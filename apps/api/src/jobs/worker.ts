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
}

export function createJobWorkers(deps: CreateJobWorkersDeps): RunningWorkers {
  const { createConnection, definitions, ctx, logger } = deps;

  const workers = definitions.map((def) => {
    const worker = new Worker(
      def.name,
      async (job: Job) => {
        await def.handler(job as never, ctx);
      },
      { connection: createConnection(), ...def.workerOptions },
    );

    worker.on('failed', (job, err) => {
      if (job && isPermanentFailure(job)) {
        logger.error(
          { queue: def.name, jobId: job.id, attemptsMade: job.attemptsMade, err: err?.message },
          'job permanently failed — dead-lettering',
        );
        void ctx.deadLetter
          .record({
            queue: def.name,
            jobId: job.id,
            name: job.name,
            data: job.data,
            failedReason: err?.message ?? job.failedReason ?? 'unknown',
            attemptsMade: job.attemptsMade,
            timestamp: Date.now(),
          })
          .catch((recordErr) => {
            logger.error({ queue: def.name, err: recordErr }, 'failed to write dead-letter entry');
          });
      } else {
        logger.warn(
          { queue: def.name, jobId: job?.id, attemptsMade: job?.attemptsMade, err: err?.message },
          'job attempt failed — will retry',
        );
      }
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
