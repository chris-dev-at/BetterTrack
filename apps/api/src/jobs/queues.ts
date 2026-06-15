import { type Job, type JobsOptions, Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import { DEFAULT_JOB_OPTIONS } from './options';
import { type JobPayload, type QueueName } from './types';

/**
 * Typed registry of BullMQ queues (PROJECTPLAN.md §9).
 *
 * Queues are created lazily and memoised, each pre-seeded with
 * {@link DEFAULT_JOB_OPTIONS} (3 attempts, exponential backoff). `enqueue` is
 * typed per queue, so the payload must match {@link JobPayload} for that queue.
 * Queues do not hold blocking connections, so they all share one connection.
 */
export interface QueueRegistry {
  /** The (memoised) queue for `name`, typed to its payload. */
  get<N extends QueueName>(name: N): Queue<JobPayload<N>>;
  /** Enqueue a typed job onto its queue. */
  enqueue<N extends QueueName>(
    name: N,
    data: JobPayload<N>,
    opts?: JobsOptions,
  ): Promise<Job<JobPayload<N>>>;
  /** Close every queue that has been created. */
  close(): Promise<void>;
}

export function createQueueRegistry(connection: Redis): QueueRegistry {
  const queues = new Map<QueueName, Queue>();

  function get<N extends QueueName>(name: N): Queue<JobPayload<N>> {
    let queue = queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
      queues.set(name, queue);
    }
    return queue as Queue<JobPayload<N>>;
  }

  return {
    get,
    async enqueue<N extends QueueName>(
      name: N,
      data: JobPayload<N>,
      opts?: JobsOptions,
    ): Promise<Job<JobPayload<N>>> {
      // Add through the base Queue type: BullMQ's `add` constrains the job name
      // against the data generic, which TS can't reduce for an unresolved `N`.
      const queue: Queue = get(name);
      const job = await queue.add(name, data, opts);
      return job as Job<JobPayload<N>>;
    },
    async close(): Promise<void> {
      await Promise.all([...queues.values()].map((q) => q.close()));
      queues.clear();
    },
  };
}
