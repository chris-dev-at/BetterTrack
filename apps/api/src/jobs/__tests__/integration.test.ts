import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, describe, expect, it } from 'vitest';

import type { Logger } from '../../logger';
import { createJobConnection } from '../connection';
import { createDeadLetter } from '../deadLetter';
import { DEFAULT_JOB_OPTIONS } from '../options';
import { registerSchedule } from '../scheduler';
import { createJobWorkers } from '../worker';
import type { JobContext } from '../types';

/**
 * Full end-to-end coverage through BullMQ's real engine: enqueue→process,
 * retry/backoff→dead-letter, and scheduler registration.
 *
 * BullMQ drives its queues with Lua scripts that use `cmsgpack`, which the
 * in-memory `ioredis-mock` cannot execute — so the real engine needs a real
 * Redis. This suite therefore runs only when `BULLMQ_TEST_REDIS_URL` points at
 * one (e.g. `BULLMQ_TEST_REDIS_URL=redis://localhost:6379 pnpm test`) and is
 * skipped otherwise, keeping CI green while still providing genuine E2E coverage
 * where a Redis is available. The unit suites cover the same behaviours' logic
 * against ioredis-mock.
 */
const REDIS_URL = process.env.BULLMQ_TEST_REDIS_URL;
const PREFIX = `bt-test-${process.pid}`;
const logger = pino({ level: 'silent' }) as unknown as Logger;

const connections: Redis[] = [];
function connect(): Redis {
  const c = createJobConnection(REDIS_URL as string);
  connections.push(c);
  return c;
}

afterAll(async () => {
  await Promise.allSettled(connections.map((c) => c.quit()));
});

describe.skipIf(!REDIS_URL)('BullMQ integration (real Redis)', () => {
  it('enqueues and processes a job (happy path)', async () => {
    const name = `${PREFIX}.happy`;
    const queue = new Queue(name, {
      connection: connect(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    await queue.obliterate({ force: true }).catch(() => undefined);

    const processed: unknown[] = [];
    const worker = new Worker(
      name,
      async (job) => {
        processed.push(job.data);
      },
      { connection: connect() },
    );

    await new Promise<void>((resolve, reject) => {
      worker.on('completed', () => resolve());
      worker.on('failed', (_j, e) => reject(e));
      queue.add(name, { hello: 'world' }).catch(reject);
      setTimeout(() => reject(new Error('timed out')), 8000);
    });

    expect(processed).toEqual([{ hello: 'world' }]);
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
  }, 20000);

  it('retries with backoff then dead-letters on permanent failure', async () => {
    const name = `${PREFIX}.fail`;
    const queue = new Queue(name, { connection: connect() });
    await queue.obliterate({ force: true }).catch(() => undefined);

    const deadLetterRedis = connect();
    const deadLetter = createDeadLetter(deadLetterRedis, { key: `${PREFIX}:dl` });
    await deadLetter.clear();

    let attempts = 0;
    const ctx: JobContext = { events: null as never, deadLetter, redis: deadLetterRedis, logger };
    const running = createJobWorkers({
      createConnection: connect,
      definitions: [
        {
          name: name as never,
          handler: async () => {
            attempts += 1;
            throw new Error('always fails');
          },
        },
      ],
      ctx,
      logger,
    });

    await queue.add(name, {}, { attempts: 2, backoff: { type: 'fixed', delay: 50 } });

    // Poll the dead-letter list until the permanent failure lands.
    const deadline = Date.now() + 8000;
    let entries = await deadLetter.list();
    while (entries.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      entries = await deadLetter.list();
    }

    expect(attempts).toBe(2); // ran twice (initial + one retry), then gave up
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      queue: name,
      attemptsMade: 2,
      failedReason: 'always fails',
    });

    await running.close();
    await deadLetter.clear();
    await queue.obliterate({ force: true });
    await queue.close();
  }, 20000);

  it('registers a repeatable scheduler from code', async () => {
    const name = `${PREFIX}.sched`;
    const queue = new Queue(name, { connection: connect() });
    await queue.obliterate({ force: true }).catch(() => undefined);

    await registerSchedule(queue, { id: `${name}.every`, every: 3600_000 });
    const schedulers = await queue.getJobSchedulers();
    expect(schedulers.map((s) => s.key)).toContain(`${name}.every`);

    await queue.obliterate({ force: true });
    await queue.close();
  }, 20000);
});
