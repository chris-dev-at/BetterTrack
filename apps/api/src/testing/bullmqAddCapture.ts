import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';

import { createQueueRegistry, type QueueRegistry } from '../jobs/queues';
import type { QueueName } from '../jobs/types';

/**
 * A {@link QueueRegistry} whose `enqueue` runs BullMQ's REAL producer path —
 * `Queue.add` → `Job.create` → `Job.addJob` → `Job.validateOptions` — and stops
 * only at the Lua add script, the first step that needs a real Redis (BullMQ's
 * scripts use `cmsgpack`, which ioredis-mock cannot execute).
 *
 * This exists because of #1184. Every other enqueue seam in the suite is a
 * recorder that accepts any job id, so a custom id BullMQ refuses (`Custom Id
 * cannot contain :`) passed every test and failed every production enqueue. Here
 * the job-id rules are BullMQ's own, from whatever version the lockfile
 * resolves, so a refused id rejects `enqueue` exactly as it does in production.
 */
export interface CapturedAdd {
  queue: QueueName;
  name: string;
  /** The custom job id BullMQ accepted, or undefined for an auto-id job. */
  jobId: string | undefined;
  data: unknown;
}

export interface BullmqAddCapture {
  registry: QueueRegistry;
  /** Every add that passed BullMQ's validation, in order. */
  readonly added: CapturedAdd[];
  close(): Promise<void>;
}

interface AddScriptJob {
  name: string;
  data: string;
}

interface ScriptsWithAddJob {
  addJob(
    client: unknown,
    job: AddScriptJob,
    opts: unknown,
    jobId: string | undefined,
  ): Promise<string>;
}

/**
 * Build the capturing registry for `queues`. Only the named queues are wired —
 * an enqueue onto any other queue would reach the Lua script and fail on
 * ioredis-mock, which is the right loud failure for a test that forgot one.
 */
export function createBullmqAddCapture(queues: readonly QueueName[]): BullmqAddCapture {
  const registry = createQueueRegistry(new RedisMock() as unknown as Redis);
  const added: CapturedAdd[] = [];
  let auto = 0;
  for (const name of queues) {
    // The registry memoises, so `enqueue` later reaches this same instance.
    // `scripts` is BullMQ-internal (not in the public typings); `Job` reads it
    // from the queue it is created on.
    const scripts = (registry.get(name) as unknown as { scripts: ScriptsWithAddJob }).scripts;
    scripts.addJob = async (_client, job, _opts, jobId) => {
      added.push({
        queue: name,
        name: job.name,
        jobId: jobId === '' ? undefined : jobId,
        data: JSON.parse(job.data) as unknown,
      });
      // The add script answers with the job's id — the custom one, or the
      // counter BullMQ would have assigned.
      return jobId ? jobId : String((auto += 1));
    };
  }
  return { registry, added, close: () => registry.close() };
}
