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
      loginIp: schedule,
      loginAccount: schedule,
    },
  } as unknown as AppConfig;
  return { config, redis } as unknown as AppContext;
};

// Realistic two-window general limiter: a generous 15-min/4500 steady state a
// reload flood can't reach, fronted by a tight 60-req / 10-s burst window. Both
// feed the same escalation ladder (owner report #202).
const burstCtx = (): AppContext => {
  const ladder = { cooldownsSec: [20, 60, 180, 600], decaySec: 15 * 60 };
  const config = {
    rateLimits: {
      enabled: true,
      general: { windowSec: 15 * 60, limit: 4500, ...ladder },
      generalBurst: { windowSec: 10, limit: 60, ...ladder },
      search: { windowSec: 60, limit: 60, ...ladder },
      loginIp: { windowSec: 60, limit: 25, ...ladder },
      loginAccount: { windowSec: 15 * 60, limit: 10, ...ladder },
    },
  } as unknown as AppConfig;
  return { config, redis } as unknown as AppContext;
};

const runOnce = (
  handler: (req: Request, res: Response, next: NextFunction) => void,
): Promise<{ headers: Record<string, string>; err: unknown }> => {
  const headers: Record<string, string> = {};
  const req = { ip: '10.0.0.1', authUser: undefined } as unknown as Request;
  const res = {
    setHeader(name: string, value: string | number) {
      headers[name] = String(value);
    },
  } as unknown as Response;
  return new Promise((resolve) => {
    handler(req, res, (err?: unknown) => resolve({ headers, err }));
  });
};

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

describe('general burst dimension — reload-flood hardening (§10, #202)', () => {
  // The number of /api/v1 calls one full page load fires. The reproduction only
  // needs it > 0; the burst window trips long before 1000 reloads regardless.
  const REQUESTS_PER_RELOAD = 6;

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
    // 60 req / 10 s at 6 req/reload → trips around reload 11, nowhere near 1000.
    expect(reloadsUntilTrip).toBeLessThan(1000);
    expect(reloadsUntilTrip).toBeLessThanOrEqual(11);
  });

  it('continued hammering after the cooldown elapses climbs the escalation ladder', async () => {
    const { general } = createRateLimiters(burstCtx());
    const burstCooldown = progressiveKeys('general_burst', '10.0.0.1').cooldown;

    // First flood → first rung (20 s), then simulate that cooldown elapsing.
    for (let i = 0; i <= 60; i += 1) await runOnce(general);
    await redis.del(burstCooldown);

    // A fresh flood while the escalation level is still armed → next rung (60 s).
    let last: { headers: Record<string, string>; err: unknown } | undefined;
    for (let i = 0; i <= 60; i += 1) last = await runOnce(general);

    const err = last!.err as ApiError;
    expect(err.statusCode).toBe(429);
    expect(err.details).toEqual({ retryAfter: 60 });
    expect(last!.headers['Retry-After']).toBe('60');
  });

  it('normal multi-tab refetch at human cadence never trips a 429', async () => {
    const { general } = createRateLimiters(burstCtx());
    const burstCount = progressiveKeys('general_burst', '10.0.0.1').count;
    const steadyCount = progressiveKeys('general', '10.0.0.1').count;

    // 3 tabs each refetching the app's ~6 core endpoints on focus = 18 requests.
    const perRefetch = 3 * 6;
    // ~a minute of human reload cadence: a refetch round, then the 10 s burst
    // window rolls over (its counter expires) before the next round.
    for (let round = 0; round < 20; round += 1) {
      for (let i = 0; i < perRefetch; i += 1) {
        const { err } = await runOnce(general);
        expect(err).toBeUndefined();
      }
      await redis.del(burstCount); // 10 s elapsed → burst window resets
    }

    // The generous steady-state window never came close to its 4500 allowance.
    expect(Number(await redis.get(steadyCount))).toBeLessThan(4500);
  });
});
