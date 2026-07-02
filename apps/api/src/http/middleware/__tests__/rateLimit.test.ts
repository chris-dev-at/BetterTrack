import type { NextFunction, Request, Response } from 'express';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../../../config/env';
import { ApiError } from '../../../errors';
import type { AppContext } from '../../context';
import { createRateLimiters } from '../rateLimit';

let redis: Redis;

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
});

// A tiny enabled schedule so a couple of calls overflow the allowance. The guard
// only reads `config.rateLimits` and `redis` off the context.
const ctxWith = (limit: number, firstCooldown: number): AppContext => {
  const schedule = { windowSec: 100, limit, cooldownsSec: [firstCooldown, 60], decaySec: 900 };
  const config = {
    rateLimits: {
      enabled: true,
      general: schedule,
      search: schedule,
      loginIp: schedule,
      loginAccount: schedule,
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
