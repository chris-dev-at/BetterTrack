import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEAD_LETTER_KEY,
  createDeadLetter,
  isPermanentFailure,
  type DeadLetterEntry,
} from '../deadLetter';

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
    await redis.lpush(DEAD_LETTER_KEY, 'not json');
    await dl.record(entry({ jobId: 'ok' }));
    const all = await dl.list();
    expect(all.map((e) => e.jobId)).toEqual(['ok']);
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
