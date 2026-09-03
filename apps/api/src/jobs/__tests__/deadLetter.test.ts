import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEAD_LETTER_KEY,
  createDeadLetter,
  isPermanentFailure,
  type DeadLetterEntry,
} from '../deadLetter';
import { handleWorkerError, handleWorkerFailure } from '../worker';

let redis: Redis;

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
});

function entry(partial: Partial<DeadLetterEntry> = {}): DeadLetterEntry {
  return {
    queue: 'prices.refreshDaily',
    jobId: 'job-1',
    name: 'prices.refreshDaily',
    data: { foo: 'bar' },
    failedReason: 'upstream 500',
    attemptsMade: 3,
    timestamp: 0,
    ...partial,
  };
}

describe('createDeadLetter', () => {
  it('records and lists entries newest-first', async () => {
    const dl = createDeadLetter(redis);
    await dl.record(entry({ jobId: 'a' }));
    await dl.record(entry({ jobId: 'b' }));
    await dl.record(entry({ jobId: 'c' }));

    const all = await dl.list();
    expect(all.map((e) => e.jobId)).toEqual(['c', 'b', 'a']);
    expect(await dl.size()).toBe(3);
  });

  it('stamps a timestamp from the injected clock when none is given', async () => {
    const dl = createDeadLetter(redis, { now: () => 123_456 });
    await dl.record(entry({ timestamp: 0 }));
    const [first] = await dl.list();
    expect(first?.timestamp).toBe(123_456);
  });

  it('keeps a caller-supplied timestamp', async () => {
    const dl = createDeadLetter(redis, { now: () => 999 });
    await dl.record(entry({ timestamp: 555 }));
    const [first] = await dl.list();
    expect(first?.timestamp).toBe(555);
  });

  it('honours the list limit', async () => {
    const dl = createDeadLetter(redis);
    for (let i = 0; i < 5; i += 1) await dl.record(entry({ jobId: `j${i}` }));
    const limited = await dl.list(2);
    expect(limited.map((e) => e.jobId)).toEqual(['j4', 'j3']);
  });

  it('trims to the configured maximum', async () => {
    const dl = createDeadLetter(redis, { max: 3 });
    for (let i = 0; i < 6; i += 1) await dl.record(entry({ jobId: `j${i}` }));
    expect(await dl.size()).toBe(3);
    const all = await dl.list();
    // Only the three newest survive.
    expect(all.map((e) => e.jobId)).toEqual(['j5', 'j4', 'j3']);
  });

  it('clears the list', async () => {
    const dl = createDeadLetter(redis);
    await dl.record(entry());
    await dl.clear();
    expect(await dl.size()).toBe(0);
    expect(await dl.list()).toEqual([]);
  });

  it('writes under the documented key', async () => {
    const dl = createDeadLetter(redis);
    await dl.record(entry());
    expect(await redis.llen(DEAD_LETTER_KEY)).toBe(1);
  });

  it('skips corrupt entries on read', async () => {
    const dl = createDeadLetter(redis);
    await dl.record(entry({ jobId: 'older' }));
    await redis.lpush(DEAD_LETTER_KEY, 'not json');
    await dl.record(entry({ jobId: 'newer' }));
    const all = await dl.list();
    expect(all.map((e) => e.jobId)).toEqual(['newer', 'older']);
  });
});

describe('isPermanentFailure (§9 retry boundary)', () => {
  it('is false while retries remain', () => {
    expect(isPermanentFailure({ attemptsMade: 1, opts: { attempts: 3 } })).toBe(false);
    expect(isPermanentFailure({ attemptsMade: 2, opts: { attempts: 3 } })).toBe(false);
  });

  it('is true once the final attempt is exhausted', () => {
    expect(isPermanentFailure({ attemptsMade: 3, opts: { attempts: 3 } })).toBe(true);
    expect(isPermanentFailure({ attemptsMade: 4, opts: { attempts: 3 } })).toBe(true);
  });

  it('treats a missing attempts setting as a single attempt', () => {
    expect(isPermanentFailure({ attemptsMade: 1, opts: {} })).toBe(true);
    expect(isPermanentFailure({ attemptsMade: 0, opts: {} })).toBe(false);
    expect(isPermanentFailure({ attemptsMade: 1 })).toBe(true);
  });
});

/**
 * Failure paths that never reach {@link isPermanentFailure} (§13.5 V5-P2). BullMQ
 * delivers `failed` with no job record when the record could not be re-read, and
 * emits a worker-scoped `error` for failures of the job SYSTEM (Redis link, lock
 * extension, deserialization). Both used to end at a log line, so the admin
 * Problems page — the stated Sentry replacement — reported calm while jobs were
 * being lost.
 */
describe('worker failure capture coverage', () => {
  function stubLogger(): {
    error: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  } {
    return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  }

  it('captures a `failed` event that arrives with no job record', () => {
    const logger = stubLogger();
    const recorded: unknown[] = [];
    const captured: { err: unknown; meta: { queue: string; jobId?: string } }[] = [];

    handleWorkerFailure({
      queue: 'system.heartbeat',
      job: undefined,
      err: new Error('missing lock key'),
      ctx: {
        deadLetter: {
          record: async (entry: unknown) => {
            recorded.push(entry);
          },
        },
        logger,
      } as never,
      logger: logger as never,
      onPermanentFailure: (err, meta) => captured.push({ err, meta }),
    });

    // The job is gone for good: captured as a permanent failure, not downgraded
    // to a "will retry" warning nobody reads.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.meta).toEqual({ queue: 'system.heartbeat' });
    expect((captured[0]!.err as Error).message).toBe('missing lock key');
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
    // Nothing to dead-letter — the payload went with the record.
    expect(recorded).toHaveLength(0);
  });

  it('still treats a retryable attempt failure as backoff, not a capture', () => {
    const logger = stubLogger();
    let captured = 0;

    handleWorkerFailure({
      queue: 'system.heartbeat',
      job: {
        id: 'job-9',
        name: 'system.heartbeat',
        attemptsMade: 1,
        opts: { attempts: 3 },
      } as never,
      err: new Error('transient'),
      ctx: { deadLetter: { record: async () => {} }, logger } as never,
      logger: logger as never,
      onPermanentFailure: () => {
        captured += 1;
      },
    });

    expect(captured).toBe(0);
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('reports a worker-scoped error to the capture hook, not just the log', () => {
    const logger = stubLogger();
    const captured: { err: unknown; meta: { queue: string } }[] = [];
    const err = new Error('connect ECONNREFUSED 127.0.0.1:6379');

    handleWorkerError({
      queue: 'market.refresh',
      err,
      logger: logger as never,
      onWorkerError: (workerErr, meta) => captured.push({ err: workerErr, meta }),
    });

    expect(logger.error).toHaveBeenCalled();
    expect(captured).toEqual([{ err, meta: { queue: 'market.refresh' } }]);
  });

  it('is a no-op beyond logging when no capture hook is bound', () => {
    const logger = stubLogger();
    expect(() =>
      handleWorkerError({
        queue: 'market.refresh',
        err: new Error('boom'),
        logger: logger as never,
      }),
    ).not.toThrow();
    expect(logger.error).toHaveBeenCalled();
  });
});
