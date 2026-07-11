import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sha256Base64Url } from '../../crypto/tokens';
import { createSessionService, isPersistent } from '../sessionService';

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

/**
 * Session manager (PROJECTPLAN.md §6.1, §6.11, V3-P11a): device metadata,
 * listing, and per-session / others revocation. Metadata lives in a side key so
 * stamping it never extends the fixed 30-day window.
 */
describe('sessionService — session manager (V3-P11a)', () => {
  let redis: Redis;

  beforeEach(async () => {
    redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
  });

  afterEach(async () => {
    await redis.quit?.();
  });

  const sessKey = (id: string) => `sess:${id}`;
  const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Chrome/120.0 Safari/537.36';

  it('lists a session with a public handle (not the raw id) and current marker', async () => {
    const sessions = createSessionService(redis, 100);
    const id = await sessions.create('user-1');

    const list = await sessions.listForUser('user-1', id);
    expect(list).toHaveLength(1);
    const entry = list[0]!;
    // The handle is the SHA-256 of the id — the raw token is never exposed.
    expect(entry.id).toBe(sha256Base64Url(id));
    expect(entry.id).not.toBe(id);
    expect(entry.current).toBe(true);
    // No request has stamped it yet → no UA, last-seen falls back to created.
    expect(entry.userAgent).toBeNull();
    expect(entry.lastSeenAt).toBe(entry.createdAt);
  });

  it('touchLastSeen captures the UA on first-seen without extending the window', async () => {
    const sessions = createSessionService(redis, 100);
    const id = await sessions.create('user-1');

    await redis.expire(sessKey(id), 40); // simulate elapsed time
    await sessions.touchLastSeen(id, CHROME);

    // Metadata captured…
    const entry = (await sessions.listForUser('user-1', id))[0]!;
    expect(entry.userAgent).toBe(CHROME);
    expect(entry.lastSeenAt).toBeGreaterThanOrEqual(entry.createdAt);
    // …but the fixed-window session TTL is untouched (still ~40, not reset to 100).
    const ttl = await redis.ttl(sessKey(id));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(40);
  });

  it('touchLastSeen is a no-op for a session that no longer exists', async () => {
    const sessions = createSessionService(redis, 100);
    const id = await sessions.create('user-1');
    await sessions.destroy(id);

    await sessions.touchLastSeen(id, CHROME);
    // No metadata resurrected, nothing to list.
    expect(await sessions.listForUser('user-1', id)).toHaveLength(0);
    expect(await redis.get(`sess_meta:${id}`)).toBeNull();
  });

  it('revokeForUser revokes exactly the session matching the public handle', async () => {
    const sessions = createSessionService(redis, 100);
    const keep = await sessions.create('user-1');
    const target = await sessions.create('user-1');

    const ok = await sessions.revokeForUser('user-1', sha256Base64Url(target));
    expect(ok).toBe(true);
    expect(await sessions.get(target)).toBeNull();
    expect(await sessions.get(keep)).not.toBeNull();
    // Metadata for the revoked session is gone too.
    expect(await redis.get(`sess_meta:${target}`)).toBeNull();
  });

  it('revokeForUser refuses a handle that is not one of the user’s sessions', async () => {
    const sessions = createSessionService(redis, 100);
    await sessions.create('user-1');
    const other = await sessions.create('user-2');

    // user-1 cannot revoke user-2's session even knowing its handle.
    expect(await sessions.revokeForUser('user-1', sha256Base64Url(other))).toBe(false);
    expect(await sessions.get(other)).not.toBeNull();
    // A totally unknown handle is simply not found.
    expect(await sessions.revokeForUser('user-1', 'nope')).toBe(false);
  });

  it('revokeOthersForUser kills every session except the kept one', async () => {
    const sessions = createSessionService(redis, 100);
    const keep = await sessions.create('user-1');
    const a = await sessions.create('user-1');
    const b = await sessions.create('user-1');

    const revoked = await sessions.revokeOthersForUser('user-1', keep);
    expect(revoked).toBe(2);
    expect(await sessions.get(keep)).not.toBeNull();
    expect(await sessions.get(a)).toBeNull();
    expect(await sessions.get(b)).toBeNull();
    expect(await sessions.listForUser('user-1', keep)).toHaveLength(1);
  });

  it('listForUser prunes expired sessions that linger in the index', async () => {
    const sessions = createSessionService(redis, 100);
    const live = await sessions.create('user-1');
    const dead = await sessions.create('user-1');

    // Expire one out from under the index (as the 30-day window would).
    await redis.del(sessKey(dead));

    const list = await sessions.listForUser('user-1', live);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(sha256Base64Url(live));
    // The dead id has been pruned from the index.
    expect(await redis.smembers('user_sessions:user-1')).toEqual([live]);
  });

  it('destroyAllForUser clears device metadata as well as sessions', async () => {
    const sessions = createSessionService(redis, 100);
    const a = await sessions.create('user-1');
    await sessions.touchLastSeen(a, CHROME);

    await sessions.destroyAllForUser('user-1');
    expect(await redis.get(`sess_meta:${a}`)).toBeNull();
    expect(await sessions.listForUser('user-1', null)).toHaveLength(0);
  });
});

/**
 * Ephemeral sessions (V4-P2b, owner spec #399 §A; PROJECTPLAN.md §16). An
 * unticked "stay signed in" (or a PIN-less OAuth) login mints an ephemeral
 * session: a sliding idle window hard-capped from creation, versus a persistent
 * session's fixed 30-day window. An injected clock drives the idle/cap math
 * independently of ioredis-mock's real-time key TTL.
 */
describe('sessionService — ephemeral sessions (V4-P2b, §399 §A)', () => {
  let redis: Redis;
  let now: number;
  const clock = () => now;
  const sessKey = (id: string) => `sess:${id}`;
  // Small, distinguishable windows: 100s idle, 1000s cap, 5000s persistent.
  const make = () =>
    createSessionService(redis, 5000, {
      ephemeralIdleMs: 100_000,
      ephemeralCapMs: 1_000_000,
      now: clock,
    });

  beforeEach(async () => {
    redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    now = 1_700_000_000_000;
  });

  afterEach(async () => {
    await redis.quit?.();
  });

  it('mints a persistent session with the full fixed window', async () => {
    const sessions = make();
    const id = await sessions.create('u', true);
    const ttl = await redis.ttl(sessKey(id));
    expect(ttl).toBeGreaterThan(4900);
    expect(ttl).toBeLessThanOrEqual(5000);
    expect((await sessions.get(id))?.persistent).toBe(true);
  });

  it('mints an ephemeral session with the idle window, NOT the 30-day window', async () => {
    const sessions = make();
    const id = await sessions.create('u', false);
    const ttl = await redis.ttl(sessKey(id));
    expect(ttl).toBeGreaterThan(90);
    expect(ttl).toBeLessThanOrEqual(100);
    expect((await sessions.get(id))?.persistent).toBe(false);
  });

  it('slides the ephemeral idle window forward on activity', async () => {
    const sessions = make();
    const id = await sessions.create('u', false);
    // 70s on (past the last-seen throttle): activity re-arms the full idle window.
    now += 70_000;
    await sessions.touchLastSeen(id, 'UA');
    const ttl = await redis.ttl(sessKey(id));
    expect(ttl).toBeGreaterThan(90);
    expect(ttl).toBeLessThanOrEqual(100);
  });

  it('never slides the ephemeral window past the hard cap', async () => {
    const sessions = make();
    const id = await sessions.create('u', false);
    // 970s in — only 30s below the 1000s cap: the slide is capped to ~30s.
    now += 970_000;
    await sessions.touchLastSeen(id, 'UA');
    const ttl = await redis.ttl(sessKey(id));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(31);
  });

  it('a persistent session is not slid by activity (fixed window)', async () => {
    const sessions = make();
    const id = await sessions.create('u', true);
    await redis.expire(sessKey(id), 40); // simulate elapsed real TTL
    now += 70_000;
    await sessions.touchLastSeen(id, 'UA');
    // The fixed window is untouched — never reset toward the full 5000s.
    const ttl = await redis.ttl(sessKey(id));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(40);
  });

  it('renew resets an ephemeral session to a fresh idle window, not the 30-day window', async () => {
    const sessions = make();
    const id = await sessions.create('u', false);
    await redis.expire(sessKey(id), 10);
    now += 200_000; // 200s in, still far under the cap
    expect(await sessions.renew(id)).toBe(true);
    const ttl = await redis.ttl(sessKey(id));
    expect(ttl).toBeGreaterThan(90);
    expect(ttl).toBeLessThanOrEqual(100);
  });

  it('setPersistent upgrades an ephemeral session to the full fixed window', async () => {
    const sessions = make();
    const id = await sessions.create('u', false);
    expect(await sessions.setPersistent(id, true)).toBe(true);
    expect((await sessions.get(id))?.persistent).toBe(true);
    const ttl = await redis.ttl(sessKey(id));
    expect(ttl).toBeGreaterThan(4900);
    expect(ttl).toBeLessThanOrEqual(5000);
  });

  it('setPersistent is a no-op-false on a session that is already gone', async () => {
    const sessions = make();
    const id = await sessions.create('u', false);
    await sessions.destroy(id);
    expect(await sessions.setPersistent(id, true)).toBe(false);
  });

  it('listForUser reports persistence per session; a legacy (unmarked) session reads persistent', async () => {
    const sessions = make();
    const persistentId = await sessions.create('u', true);
    const ephemeralId = await sessions.create('u', false);
    // A pre-V4-P2b session written with no `persistent` marker.
    const legacyId = 'legacy-session-id';
    await redis.set(
      sessKey(legacyId),
      JSON.stringify({ userId: 'u', createdAt: now, renewedAt: now }),
      'EX',
      5000,
    );
    await redis.sadd('user_sessions:u', legacyId);

    const list = await sessions.listForUser('u', persistentId);
    const byHandle = (id: string) => list.find((e) => e.id === sha256Base64Url(id));
    expect(byHandle(persistentId)?.persistent).toBe(true);
    expect(byHandle(ephemeralId)?.persistent).toBe(false);
    expect(byHandle(legacyId)?.persistent).toBe(true);
  });

  it('isPersistent treats an unmarked session as persistent (back-compat)', () => {
    expect(isPersistent({})).toBe(true);
    expect(isPersistent({ persistent: false })).toBe(false);
    expect(isPersistent({ persistent: true })).toBe(true);
  });

  it('expiresAtFor: persistent → renewedAt + fixed window; ephemeral → the hard cap from creation', () => {
    const sessions = make();
    const createdAt = now;
    const renewedAt = now + 123_000; // a later PIN verify moves the window
    // Persistent: the fixed window (here 5000s) past the LAST renew.
    expect(sessions.expiresAtFor({ createdAt, renewedAt, persistent: true })).toBe(
      renewedAt + 5_000_000,
    );
    // A legacy unmarked session is treated as persistent (back-compat).
    expect(sessions.expiresAtFor({ createdAt, renewedAt })).toBe(renewedAt + 5_000_000);
    // Ephemeral: the hard cap from CREATION — a stable upper bound, unaffected
    // by renew or the sliding idle window (never the 30-day window).
    expect(sessions.expiresAtFor({ createdAt, renewedAt, persistent: false })).toBe(
      createdAt + 1_000_000,
    );
  });
});
