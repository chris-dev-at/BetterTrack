import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import { releaseCacheLock } from '../cacheLock';

let redis: Redis;

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
});

const LOCK_KEY = 'mkt:lock:yahoo:BAYN.DE:quote:spot';

describe('releaseCacheLock', () => {
  it('deletes a lock owned by the caller token', async () => {
    await redis.set(LOCK_KEY, 'owner-a');

    await expect(releaseCacheLock(redis, LOCK_KEY, 'owner-a')).resolves.toBe(true);
    await expect(redis.get(LOCK_KEY)).resolves.toBeNull();
  });

  it('leaves a lock owned by another token untouched', async () => {
    await redis.set(LOCK_KEY, 'owner-b');

    await expect(releaseCacheLock(redis, LOCK_KEY, 'owner-a')).resolves.toBe(false);
    await expect(redis.get(LOCK_KEY)).resolves.toBe('owner-b');
  });

  it('leaves a missing lock untouched', async () => {
    await expect(releaseCacheLock(redis, LOCK_KEY, 'owner-a')).resolves.toBe(false);
    await expect(redis.exists(LOCK_KEY)).resolves.toBe(0);
  });

  it('cannot delete a successor lock after the original lease expires', async () => {
    await redis.set(LOCK_KEY, 'owner-a', 'PX', 10_000, 'NX');
    await redis.pexpire(LOCK_KEY, 0);
    await expect(redis.set(LOCK_KEY, 'owner-b', 'PX', 10_000, 'NX')).resolves.toBe('OK');

    await expect(releaseCacheLock(redis, LOCK_KEY, 'owner-a')).resolves.toBe(false);
    await expect(redis.get(LOCK_KEY)).resolves.toBe('owner-b');
  });
});
