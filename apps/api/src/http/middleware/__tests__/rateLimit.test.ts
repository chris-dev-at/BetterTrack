import type { NextFunction, Request, Response } from 'express';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../../../config/env';
import { ApiError } from '../../../errors';
import { progressiveKeys } from '../../../services/security/progressiveLimiter';
import type { AppContext } from '../../context';
import { createRateLimiters } from '../rateLimit';

let redis: Redis;

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
});

// A tiny enabled schedule so a couple of calls overflow the allowance. The guard
// only reads `config.rateLimits` and `redis` off the context. `generalBurst`
// mirrors the steady-state schedule here so the single-dimension escalation
// assertions below stay meaningful (either window trips the same rung).
const ctxWith = (limit: number, firstCooldown: number): AppContext => {
  const schedule = { windowSec: 100, limit, cooldownsSec: [firstCooldown, 60], decaySec: 900 };
  const config = {
    rateLimits: {
      enabled: true,
      general: schedule,
      generalBurst: schedule,
      search: schedule,
      social: schedule,
      feedback: schedule,
      feedbackThread: schedule,
      vault: schedule,
      vaultRead: schedule,
      apiKey: schedule,
      loginIp: schedule,
      loginAccount: schedule,
    },
  } as unknown as AppConfig;
  return { config, redis } as unknown as AppContext;
};

// The SHIPPED two-window general limiter (§10 limiter table, owner directive
// 2026-09-02): a 15-min/9000 steady state a reload flood can't reach, fronted by
// a 600-req / 30-s burst window. Both feed the same escalation ladder (owner
// report #202). Kept in sync with `config/env.ts`, which
// `config/__tests__/rateLimitTable.test.ts` pins against the real loader.
const burstCtx = (): AppContext => {
  const ladder = { cooldownsSec: [20, 60, 180, 600], decaySec: 15 * 60 };
  const config = {
    rateLimits: {
      enabled: true,
      general: { windowSec: 15 * 60, limit: 9000, ...ladder },
      generalBurst: { windowSec: 30, limit: 600, ...ladder },
      search: { windowSec: 60, limit: 300, ...ladder },
      social: { windowSec: 60 * 60, limit: 30, ...ladder },
      feedback: { windowSec: 60 * 60, limit: 5, ...ladder },
      feedbackThread: { windowSec: 60 * 60, limit: 60, ...ladder },
      vault: { windowSec: 60, limit: 60, ...ladder },
      vaultRead: { windowSec: 60, limit: 600, ...ladder },
      apiKey: { windowSec: 60, limit: 120, ...ladder },
      loginIp: { windowSec: 60, limit: 25, ...ladder },
      loginAccount: { windowSec: 15 * 60, limit: 10, ...ladder },
    },
  } as unknown as AppConfig;
  return { config, redis } as unknown as AppContext;
};

/** Drive a guard with an anonymous caller from `ip` (no resolved principal). */
const runFrom = (
  handler: (req: Request, res: Response, next: NextFunction) => void,
  ip: string,
  authUserId?: string,
): Promise<{ headers: Record<string, string>; err: unknown }> => {
  const headers: Record<string, string> = {};
  const req = {
    ip,
    authUser: authUserId === undefined ? undefined : { id: authUserId },
  } as unknown as Request;
  const res = {
    setHeader(name: string, value: string | number) {
      headers[name] = String(value);
    },
  } as unknown as Response;
  return new Promise((resolve) => {
    handler(req, res, (err?: unknown) => resolve({ headers, err }));
  });
};

const runOnce = (handler: (req: Request, res: Response, next: NextFunction) => void) =>
  runFrom(handler, '10.0.0.1');

describe('progressive rate-limit middleware (§10)', () => {
  it('passes through while under the allowance', async () => {
    const { general } = createRateLimiters(ctxWith(3, 20));
    for (let i = 0; i < 3; i += 1) {
      const { err } = await runOnce(general);
      expect(err).toBeUndefined();
    }
  });

  it('over-limit yields a 429 carrying retryAfter in the header and body', async () => {
    const { general } = createRateLimiters(ctxWith(3, 20));
    let last: { headers: Record<string, string>; err: unknown } | undefined;
    for (let i = 0; i < 4; i += 1) last = await runOnce(general);

    const err = last!.err as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.details).toEqual({ retryAfter: 20 });
    expect(last!.headers['Retry-After']).toBe('20');
  });

  it('is a no-op when disabled', async () => {
    const ctx = ctxWith(1, 20);
    (ctx.config.rateLimits as { enabled: boolean }).enabled = false;
    const { general } = createRateLimiters(ctx);
    for (let i = 0; i < 5; i += 1) {
      const { err } = await runOnce(general);
      expect(err).toBeUndefined();
    }
  });
});

describe('per-vault read/write budgets (E1 review F3)', () => {
  it('uses independent allowances, counters, and cooldowns for reads and writes', async () => {
    const ctx = ctxWith(1, 20);
    ctx.config.rateLimits.vaultRead = {
      ...ctx.config.rateLimits.vaultRead,
      limit: 2,
    };
    const { vault, vaultRead } = createRateLimiters(ctx);

    expect((await runOnce(vault)).err).toBeUndefined();
    expect((await runOnce(vault)).err).toBeInstanceOf(ApiError);

    // Exhausting the write budget does not leak its cooldown into reads. The
    // read guard has its own larger allowance, then trips independently.
    expect((await runOnce(vaultRead)).err).toBeUndefined();
    expect((await runOnce(vaultRead)).err).toBeUndefined();
    expect((await runOnce(vaultRead)).err).toBeInstanceOf(ApiError);

    expect(await redis.get(progressiveKeys('vault', 'ip:10.0.0.1').cooldown)).toBe('1');
    expect(await redis.get(progressiveKeys('vault_read', 'ip:10.0.0.1').cooldown)).toBe('1');
  });
});

describe('general burst dimension — reload-flood hardening (§10, #202)', () => {
  /**
   * The number of /api/v1 calls one full page load fires, measured against the
   * real SPA: a cold dashboard load is 10 + 2N requests, and a 10-widget board
   * at N=5 portfolios is ~50 (see the §10 LIMITER TABLE in `config/env.ts`).
   * The old figure here was 6, which is why the burst window looked roomy.
   */
  const REQUESTS_PER_RELOAD = 50;

  it('a rapid page-reload flood trips a 429 with Retry-After well before 1000 reloads', async () => {
    const { general } = createRateLimiters(burstCtx());

    let trip: { headers: Record<string, string>; err: unknown } | undefined;
    let reloadsUntilTrip = 0;
    for (let reload = 1; reload <= 1000 && !trip; reload += 1) {
      for (let i = 0; i < REQUESTS_PER_RELOAD; i += 1) {
        const res = await runOnce(general);
        if (res.err) {
          trip = res;
          reloadsUntilTrip = reload;
          break;
        }
      }
    }

    expect(trip).toBeDefined();
    const err = trip!.err as ApiError;
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.details).toEqual({ retryAfter: 20 }); // first (short) rung
    expect(trip!.headers['Retry-After']).toBe('20');
    // 600 req / 30 s at ~50 req/reload → trips at reload 13. A human mashing
    // reload manages roughly one a second, so the guard still notices a genuine
    // flood less than halfway through its own window.
    expect(reloadsUntilTrip).toBeLessThanOrEqual(13);
    // ~650 requests through the in-memory Redis before the trip; this one is
    // deliberately end-to-end, so it gets its own budget instead of the default.
  }, 60_000);

  it('continued hammering after the cooldown elapses climbs the escalation ladder', async () => {
    const { general } = createRateLimiters(burstCtx());
    const keys = progressiveKeys('general_burst', 'ip:10.0.0.1');

    // Drive the window to its boundary by seeding the limiter's OWN counter,
    // then let one real request cross it. Replaying all 600 requests twice would
    // assert nothing extra about the ladder (the counting is covered by the
    // flood test above) and costs a minute of mock-Redis round trips. Seeding
    // state to reach an edge is what this suite already does to simulate a
    // cooldown elapsing.
    const atTheBoundary = async () => {
      await redis.set(keys.count, '600', 'EX', 30);
    };

    // First overflow → first rung (20 s), then simulate that cooldown elapsing.
    await atTheBoundary();
    const first = await runOnce(general);
    expect((first.err as ApiError).details).toEqual({ retryAfter: 20 });
    await redis.del(keys.cooldown);

    // A fresh overflow while the escalation level is still armed → rung 2 (60 s).
    await atTheBoundary();
    const second = await runOnce(general);

    const err = second.err as ApiError;
    expect(err.statusCode).toBe(429);
    expect(err.details).toEqual({ retryAfter: 60 });
    expect(second.headers['Retry-After']).toBe('60');
  });

  it('a two-tab cold load plus a navigation and a search never trips a 429', async () => {
    const { general } = createRateLimiters(burstCtx());
    const burstCount = progressiveKeys('general_burst', 'u:user-1').count;
    const steadyCount = progressiveKeys('general', 'u:user-1').count;

    // THE MODELLED NORMAL-USE BAR, fired as one uninterrupted spike inside a
    // single burst window — the case that used to 429 and is the whole point of
    // the 2026-09-02 pass. Two tabs cold-loading a widget board (50 each), a
    // portfolio navigation (14), one deliberate asset search including its
    // enrichment polls (24), and an unkeyed `invalidateQueries()` replaying a
    // cold load's worth of reads (50).
    const spike = 50 * 2 + 14 + 24 + 50;
    expect(spike).toBe(188);

    // Five consecutive burst windows of that spike — a user hammering reload
    // and re-navigating for two and a half minutes without a pause.
    const ROUNDS = 5;
    for (let round = 0; round < ROUNDS; round += 1) {
      for (let i = 0; i < spike; i += 1) {
        const { err } = await runFrom(general, '10.0.0.1', 'user-1');
        expect(err).toBeUndefined();
      }
      // …and each spike fits its window with room to spare, not by a hair.
      expect(Number(await redis.get(burstCount))).toBe(spike);
      expect(spike * 3).toBeLessThanOrEqual(600);
      await redis.del(burstCount); // 30 s elapsed → burst window rolls over
    }

    // Every one of those requests landed in the steady-state window, and a full
    // quarter-hour at that cadence (30 windows of 30 s) still does not reach it.
    expect(Number(await redis.get(steadyCount))).toBe(spike * ROUNDS);
    expect(spike * 30).toBeLessThan(9000);
  });
});

describe('general limiter keying — per user, not per address (§10)', () => {
  it('does not let one account exhaust another account behind the same address', async () => {
    const { general } = createRateLimiters(ctxWith(2, 20));

    // Two people on one home router / office NAT / CGNAT egress.
    expect((await runFrom(general, '203.0.113.7', 'alice')).err).toBeUndefined();
    expect((await runFrom(general, '203.0.113.7', 'alice')).err).toBeUndefined();
    expect((await runFrom(general, '203.0.113.7', 'alice')).err).toBeInstanceOf(ApiError);

    // Bob shares the address and nothing else: his allowance is untouched, and
    // Alice's live cooldown does not reach him.
    expect((await runFrom(general, '203.0.113.7', 'bob')).err).toBeUndefined();
    expect((await runFrom(general, '203.0.113.7', 'bob')).err).toBeUndefined();
    expect((await runFrom(general, '203.0.113.7', 'bob')).err).toBeInstanceOf(ApiError);

    // `general` guards a burst window in front of the steady one and the first
    // denial wins, so the cooldown these two earned lives in `general_burst`.
    // Two cooldowns, one per account — never one shared by the address.
    expect(await redis.get(progressiveKeys('general_burst', 'u:alice').cooldown)).toBe('1');
    expect(await redis.get(progressiveKeys('general_burst', 'u:bob').cooldown)).toBe('1');
    // The address itself was never metered for authenticated traffic.
    expect(await redis.get(progressiveKeys('general_burst', 'ip:203.0.113.7').count)).toBeNull();
    expect(await redis.get(progressiveKeys('general', 'ip:203.0.113.7').count)).toBeNull();
  });

  it('meters one account as one budget across every address it connects from', async () => {
    const { general } = createRateLimiters(ctxWith(2, 20));

    // Phone on cellular, then the same account on the laptop over wifi. The
    // budget belongs to the user, so roaming cannot mint a fresh allowance.
    expect((await runFrom(general, '198.51.100.4', 'alice')).err).toBeUndefined();
    expect((await runFrom(general, '203.0.113.7', 'alice')).err).toBeUndefined();
    expect((await runFrom(general, '192.0.2.9', 'alice')).err).toBeInstanceOf(ApiError);
  });

  it('falls back to the address only for anonymous callers, in a disjoint key space', async () => {
    const { general } = createRateLimiters(ctxWith(2, 20));

    expect((await runFrom(general, '203.0.113.7')).err).toBeUndefined();
    expect((await runFrom(general, '203.0.113.7')).err).toBeUndefined();
    expect((await runFrom(general, '203.0.113.7')).err).toBeInstanceOf(ApiError);

    // An anonymous flood from that address does not spend a signed-in user's
    // budget, even if a user id were ever to look like an address.
    expect((await runFrom(general, '203.0.113.7', '203.0.113.7')).err).toBeUndefined();
    expect(await redis.get(progressiveKeys('general_burst', 'ip:203.0.113.7').cooldown)).toBe('1');
    expect(await redis.get(progressiveKeys('general_burst', 'u:203.0.113.7').cooldown)).toBeNull();
  });

  it('keeps the login limiter per address even when a session is present (§6.1)', async () => {
    const { login } = createRateLimiters(ctxWith(2, 30));

    // Credential stuffing is an address-shaped attack: the limiter must not be
    // escapable by presenting a (valid) session for a different account.
    expect((await runFrom(login, '203.0.113.7', 'alice')).err).toBeUndefined();
    expect((await runFrom(login, '203.0.113.7', 'bob')).err).toBeUndefined();
    expect((await runFrom(login, '203.0.113.7')).err).toBeInstanceOf(ApiError);
    expect(await redis.get(progressiveKeys('login_ip', 'ip:203.0.113.7').cooldown)).toBe('1');
  });
});

describe('per-API-key limiter (§6.13, V2-P12)', () => {
  // Drive the guard with a bearer request (req.apiKey set), keyed by key id.
  const runKey = (
    handler: (req: Request, res: Response, next: NextFunction) => void,
    keyId: string,
  ): Promise<{ headers: Record<string, string>; err: unknown }> => {
    const headers: Record<string, string> = {};
    const req = {
      ip: '10.0.0.1',
      apiKey: { id: keyId, scopes: [] },
    } as unknown as Request;
    const res = {
      setHeader(name: string, value: string | number) {
        headers[name] = String(value);
      },
    } as unknown as Response;
    return new Promise((resolve) => {
      handler(req, res, (err?: unknown) => resolve({ headers, err }));
    });
  };

  it('trips a burst per key, recovers after the cooldown clears, and isolates other keys', async () => {
    const { apiKey } = createRateLimiters(ctxWith(2, 1));

    // Key A: two under the allowance, the third trips a 429 with its rung.
    expect((await runKey(apiKey, 'A')).err).toBeUndefined();
    expect((await runKey(apiKey, 'A')).err).toBeUndefined();
    const tripped = await runKey(apiKey, 'A');
    const err = tripped.err as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(429);
    expect(tripped.headers['Retry-After']).toBe('1');

    // A different key id has its own independent counter.
    expect((await runKey(apiKey, 'B')).err).toBeUndefined();

    // Simulate the cooldown TTL elapsing → key A gets a fresh allowance.
    await redis.del(progressiveKeys('api_key', 'A').cooldown);
    expect((await runKey(apiKey, 'A')).err).toBeUndefined();
  });

  it('never counts cookie-session requests (no req.apiKey)', async () => {
    const { apiKey } = createRateLimiters(ctxWith(1, 1));
    for (let i = 0; i < 5; i += 1) {
      const { err } = await runOnce(apiKey);
      expect(err).toBeUndefined();
    }
  });
});
