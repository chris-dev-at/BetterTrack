import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSessionService } from '../sessionService';

/**
 * Session-window semantics (PROJECTPLAN.md §6.1, owner directive #79). The
 * 30-day window is fixed: it is set on `create` (login) and reset on `renew`
 * (PIN verify), and — crucially — `get` (every authenticated request) never
 * extends it. So a session lapses 30 days after the last login/PIN verify no
 * matter how much ordinary activity happens in between.
 */
describe('sessionService', () => {
  let redis: Redis;

  beforeEach(async () => {
    redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
  });

  afterEach(async () => {
    await redis.quit?.();
  });

  const sessKey = (id: string) => `sess:${id}`;

  it('creates a session with the full window and returns its data', async () => {
    const sessions = createSessionService(redis, 100);
    const id = await sessions.create('user-1');

    const ttl = await redis.ttl(sessKey(id));
    expect(ttl).toBeGreaterThan(95);
    expect(ttl).toBeLessThanOrEqual(100);

    const data = await sessions.get(id);
    expect(data?.userId).toBe('user-1');
    expect(data?.renewedAt).toBeGreaterThan(0);
  });

  it('does NOT extend the window on get — the window is fixed, not rolling', async () => {
    const sessions = createSessionService(redis, 100);
    const id = await sessions.create('user-1');

    // Simulate 95 seconds elapsed by shrinking the TTL, then access the session.
    await redis.expire(sessKey(id), 5);
    await sessions.get(id);
    await sessions.get(id);

    // get must not have bumped the TTL back toward the full window.
    const ttl = await redis.ttl(sessKey(id));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5);
  });

  it('renew resets the window back to the full 30 days', async () => {
    const sessions = createSessionService(redis, 100);
    const id = await sessions.create('user-1');

    await redis.expire(sessKey(id), 5);
    const renewed = await sessions.renew(id);
    expect(renewed).toBe(true);

    const ttl = await redis.ttl(sessKey(id));
    expect(ttl).toBeGreaterThan(95);
    expect(ttl).toBeLessThanOrEqual(100);
  });

  it('renew is a no-op on a session that has already expired', async () => {
    const sessions = createSessionService(redis, 100);
    const id = await sessions.create('user-1');
    await sessions.destroy(id);

    expect(await sessions.renew(id)).toBe(false);
  });

  it('lets a session expire after the window with no login/renew', async () => {
    const sessions = createSessionService(redis, 1);
    const id = await sessions.create('user-1');

    expect(await sessions.get(id)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 1200));
    expect(await sessions.get(id)).toBeNull();
  });

  it('destroyAllForUser kills every live session for the user', async () => {
    const sessions = createSessionService(redis, 100);
    const a = await sessions.create('user-1');
    const b = await sessions.create('user-1');
    const other = await sessions.create('user-2');

    await sessions.destroyAllForUser('user-1');

    expect(await sessions.get(a)).toBeNull();
    expect(await sessions.get(b)).toBeNull();
    // A different user's session is untouched.
    expect(await sessions.get(other)).not.toBeNull();
  });
});
