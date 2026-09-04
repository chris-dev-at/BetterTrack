import type { JobsOptions } from 'bullmq';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assembleRegisteredJobDefinitions,
  JOB_REGISTRATION_DESCRIPTORS,
  type RegisteredJobDefinitions,
} from '../definitions/registration';
import { BACKOFF_BASE_MS, DEFAULT_JOB_OPTIONS, QUEUE_JOB_OPTIONS } from '../options';
import { createQueueRegistry, type QueueRegistry } from '../queues';
import {
  ALL_QUEUE_NAMES,
  QUEUE_FEATURE_FLAGS,
  QUEUE_NAMES,
  type JobDefinition,
  type QueueName,
} from '../types';

/**
 * The queue registry is what turns a declared per-queue option into the options
 * BullMQ actually stamps on a job (§13.5 V5-P10). Asserting the constant proves
 * nothing — before this wiring existed, `webhooks.deliver` declared 5 attempts
 * and every enqueued job carried 3.
 *
 * BullMQ's Lua scripts cannot run on ioredis-mock, so the assertions stop one
 * step short of Redis: `Queue.addJob` computes the merged options and hands them
 * to `Job.create`, which is stubbed here. That merge — `{...jobsOpts, ...opts}` —
 * IS the effective option set of the enqueued job. `integration.test.ts` covers
 * the same expectation against a real Redis when one is available.
 */

const registries: QueueRegistry[] = [];

function newRegistry(): QueueRegistry {
  const registry = createQueueRegistry(new RedisMock() as unknown as Redis);
  registries.push(registry);
  return registry;
}

/** Enqueue with `Job.create` stubbed; resolves to the merged options BullMQ built. */
async function effectiveEnqueuedOptions(
  registry: QueueRegistry,
  name: QueueName,
  opts?: JobsOptions,
): Promise<JobsOptions> {
  const queue = registry.get(name);
  const create = vi.fn(async (..._args: unknown[]) => ({ id: '1', opts: {} }));
  // `Job` is a prototype getter on QueueBase; shadow it with an own property.
  Object.defineProperty(queue, 'Job', { value: { create } });
  await registry.enqueue(name, {} as never, opts);
  expect(create).toHaveBeenCalledTimes(1);
  return create.mock.calls[0]![3] as JobsOptions;
}

afterEach(async () => {
  await Promise.allSettled(registries.splice(0).map((r) => r.close()));
});

describe('queue registry job options (§13.5 V5-P10)', () => {
  it('stamps the declared 5 attempts on a webhooks.deliver job enqueued with no opts', async () => {
    const merged = await effectiveEnqueuedOptions(newRegistry(), QUEUE_NAMES.webhooksDeliver);

    expect(merged.attempts).toBe(5);
    expect(merged.backoff).toEqual({ type: 'exponential', delay: BACKOFF_BASE_MS });
    // The §9 defaults the override does not mention survive.
    expect(merged.removeOnComplete).toEqual(DEFAULT_JOB_OPTIONS.removeOnComplete);
    expect(merged.removeOnFail).toEqual(DEFAULT_JOB_OPTIONS.removeOnFail);
  });

  it('lets an explicit per-call opts override the queue declaration', async () => {
    const merged = await effectiveEnqueuedOptions(newRegistry(), QUEUE_NAMES.webhooksDeliver, {
      attempts: 1,
    });

    expect(merged.attempts).toBe(1);
    // Untouched keys still come from the declaration/defaults.
    expect(merged.backoff).toEqual({ type: 'exponential', delay: BACKOFF_BASE_MS });
  });

  it('leaves a queue without a declaration on DEFAULT_JOB_OPTIONS', async () => {
    const registry = newRegistry();

    expect(registry.get(QUEUE_NAMES.systemHeartbeat).defaultJobOptions).toEqual(
      DEFAULT_JOB_OPTIONS,
    );
    const merged = await effectiveEnqueuedOptions(registry, QUEUE_NAMES.systemHeartbeat);
    expect(merged.attempts).toBe(DEFAULT_JOB_OPTIONS.attempts);
  });

  it('declares overrides only for real queues', () => {
    for (const name of Object.keys(QUEUE_JOB_OPTIONS)) {
      expect(ALL_QUEUE_NAMES).toContain(name);
    }
  });
});

describe('definition-declared job options stay the ones the queue applies', () => {
  /**
   * The exhaustive worker input, stubbed down to name + handler — plus each
   * queue's declared kill switch, which the assembly checks the same way.
   */
  function stubDefinitions(override: Partial<JobDefinition>): RegisteredJobDefinitions {
    return Object.fromEntries(
      JOB_REGISTRATION_DESCRIPTORS.map((descriptor) => {
        const featureFlag = QUEUE_FEATURE_FLAGS[descriptor.name];
        return [
          descriptor.key,
          {
            name: descriptor.name,
            handler: async () => undefined,
            ...(featureFlag ? { featureFlag } : {}),
            ...(descriptor.name === QUEUE_NAMES.webhooksDeliver ? override : {}),
          },
        ];
      }),
    ) as unknown as RegisteredJobDefinitions;
  }

  it('accepts a definition that declares its queue entry', () => {
    const assembled = assembleRegisteredJobDefinitions(
      stubDefinitions({ jobOptions: QUEUE_JOB_OPTIONS[QUEUE_NAMES.webhooksDeliver] }),
    );

    expect(assembled).toHaveLength(JOB_REGISTRATION_DESCRIPTORS.length);
  });

  it('refuses an inline declaration the registry would never apply', () => {
    // Byte-identical to the queue entry, but a different object: the enqueued
    // job would silently carry DEFAULT_JOB_OPTIONS instead.
    expect(() =>
      assembleRegisteredJobDefinitions(
        stubDefinitions({
          jobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
        }),
      ),
    ).toThrow(/not the QUEUE_JOB_OPTIONS entry/);
  });
});
