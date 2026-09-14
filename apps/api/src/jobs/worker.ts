import { type Job, Worker } from 'bullmq';

import type { Logger } from '../logger';
import { jobOutcomesTotal } from '../metrics';

import { type JobConnectionFactory } from './connection';
import { isPermanentFailure } from './deadLetter';
import type { JobContext, JobDefinition, JobPayload, JobRunSummary, QueueName } from './types';

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
  /**
   * Capture hook for WORKER-scoped errors (§13.5 V5-P2): BullMQ emits `error`
   * for failures that never become a per-job `failed` event — a dropped Redis
   * connection, a lock that could not be extended, a payload that would not
   * deserialize. Without this they were logged and dropped, so a long Redis
   * outage left the admin Problems page — the stated Sentry replacement —
   * showing nothing at all while the job system was down.
   */
  onWorkerError?: (err: unknown, meta: { queue: string }) => void;
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
    // A dead-lettered job is the definitive failure outcome (§13.5 V5-P2);
    // still-retryable attempt failures are normal backoff and not counted.
    jobOutcomesTotal.inc({ queue, outcome: 'failed' });
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
  } else if (!job) {
    // A `failed` event with NO job record — a stalled job whose record could not
    // be re-read, say. There is no attempts state to consult, nothing to
    // dead-letter (the payload went with the record) and BullMQ will not deliver
    // it again, so this is a definitive, permanent failure: count it and capture
    // it (§13.5 V5-P2). Downgrading it to "will retry" lost the job silently.
    jobOutcomesTotal.inc({ queue, outcome: 'failed' });
    logger.error(
      { queue, err: err?.message },
      'job failed with no job record — permanently lost, capturing',
    );
    onPermanentFailure?.(err, { queue });
  } else {
    logger.warn(
      { queue, jobId: job.id, attemptsMade: job.attemptsMade, err: err?.message },
      'job attempt failed — will retry',
    );
  }
}

/**
 * The `error` listener body, extracted for the same reason as
 * {@link handleWorkerFailure}. Worker-scoped errors are a failure of the job
 * SYSTEM rather than of one job, so they are captured through
 * {@link CreateJobWorkersDeps.onWorkerError} — the capture side folds and
 * rate-caps them by fingerprint, so a sustained outage costs a bounded number of
 * rows, not one per emitted event.
 */
export function handleWorkerError(params: {
  queue: string;
  err: unknown;
  logger: Logger;
  onWorkerError?: (err: unknown, meta: { queue: string }) => void;
}): void {
  const { queue, err, logger, onWorkerError } = params;
  logger.error({ queue, err }, 'worker error');
  onWorkerError?.(err, { queue });
}

/**
 * The ONE place a job definition is executed (§13.5 V5-P2 arc (c)).
 *
 * A definition that declares a {@link JobDefinition.featureFlag} runs only while
 * that switch is ON; otherwise the run is SHED — the handler is never entered,
 * so there is no evaluation, no side effect and no consumption of a per-run
 * idempotency bucket (an `(alert, window)` key, say). Re-enabling therefore
 * cannot find a window silently burnt by a run that was never allowed to fire.
 *
 * The read happens here, per run, rather than in each handler: a handler-local
 * `if` is exactly what the next producer forgets. A flag read that throws is
 * left to propagate — the job fails and BullMQ retries it — because the one
 * outcome a kill switch must never produce is "the read failed, so we fired".
 *
 * Exported so a test can drive the same path the worker takes without a live
 * BullMQ engine (which needs a real Redis; ioredis-mock cannot run its Lua).
 */
export async function runJobDefinition<N extends QueueName>(
  definition: JobDefinition<N>,
  job: Job<JobPayload<N>>,
  ctx: JobContext,
): Promise<void | JobRunSummary> {
  const flag = definition.featureFlag;
  if (flag && !(await ctx.isFeatureEnabled(flag))) {
    ctx.logger.info(
      { queue: definition.name, flag },
      'job shed — the feature it produces for is switched off',
    );
    return;
  }
  return await definition.handler(job, ctx);
}

export function createJobWorkers(deps: CreateJobWorkersDeps): RunningWorkers {
  const { createConnection, definitions, ctx, logger, onPermanentFailure, onWorkerError } = deps;

  const workers = definitions.map((def) => {
    const worker = new Worker(
      def.name,
      async (job: Job) => {
        // The handler's summary (if it returns one) becomes BullMQ's
        // `returnvalue`, which is how the admin operations cockpit can say what
        // last night's sweep deleted (#1406 W4). `JobRunSummary` is counts-only,
        // so this can carry no identifier; handlers that return nothing are
        // unaffected and store `null`. The kill-switch shed lives in
        // `runJobDefinition`, which is the only entry into a handler.
        return await runJobDefinition(def, job as never, ctx);
      },
      { connection: createConnection(), ...def.workerOptions },
    );

    worker.on('completed', () => {
      jobOutcomesTotal.inc({ queue: def.name, outcome: 'completed' });
    });

    worker.on('failed', (job, err) => {
      handleWorkerFailure({ queue: def.name, job, err, ctx, logger, onPermanentFailure });
    });

    worker.on('error', (err) => {
      handleWorkerError({ queue: def.name, err, logger, onWorkerError });
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
