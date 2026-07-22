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

// A generous base `apiKey` schedule; per-key tiers override only (limit, window).
const ctx = (): AppContext => {
  const base = { windowSec: 60, limit: 120, cooldownsSec: [20, 60], decaySec: 900 };
  const config = {
    rateLimits: {
      enabled: true,
      general: base,
      generalBurst: base,
      search: base,
      social: base,
      apiKey: base,
      loginIp: base,
      loginAccount: base,
    },
  } as unknown as AppConfig;
  return { config, redis } as unknown as AppContext;
};

/** Drive the apiKey guard once for a given key principal. */
const runOnce = (
  handler: (req: Request, res: Response, next: NextFunction) => void,
  apiKey: Request['apiKey'],
): Promise<{ headers: Record<string, string>; err: unknown }> => {
  const headers: Record<string, string> = {};
  const req = { ip: '10.0.0.1', method: 'GET', apiKey } as unknown as Request;
  const res = {
    setHeader(name: string, value: string | number) {
      headers[name] = String(value);
    },
  } as unknown as Response;
  return new Promise((resolve) => {
    handler(req, res, (err?: unknown) => resolve({ headers, err }));
  });
};

const personal = (id: string, limit: number, windowSec = 60): Request['apiKey'] => ({
  id,
  kind: 'personal',
  scopes: ['portfolio:read'],
  rateLimit: { limit, windowSec },
});

describe('per-key rate tier enforcement (§13.5 V5-P10, issue 2/2)', () => {
  it('turns a key away with 429 once it exceeds its own tier limit', async () => {
    const { apiKey } = createRateLimiters(ctx());
    const key = personal('key-a', 3);

    for (let i = 0; i < 3; i += 1) {
      const { err } = await runOnce(apiKey, key);
      expect(err).toBeUndefined();
    }
    const { err, headers } = await runOnce(apiKey, key);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).statusCode).toBe(429);
    // Limit headers follow the existing rate-limit convention (Retry-After).
    expect(headers['Retry-After']).toBeDefined();
  });

  it('does not affect other keys when one key is over its limit (done-when)', async () => {
    const { apiKey } = createRateLimiters(ctx());
    const hot = personal('key-hot', 2);
    const cool = personal('key-cool', 2);

    // Exhaust the hot key.
    await runOnce(apiKey, hot);
    await runOnce(apiKey, hot);
    const overflow = await runOnce(apiKey, hot);
    expect(overflow.err).toBeInstanceOf(ApiError);
    expect((overflow.err as ApiError).statusCode).toBe(429);

    // The cool key is completely unaffected — its own counter is untouched.
    const a = await runOnce(apiKey, cool);
    const b = await runOnce(apiKey, cool);
    expect(a.err).toBeUndefined();
    expect(b.err).toBeUndefined();
  });

  it('a higher-tier key gets a bigger allowance than a lower-tier key', async () => {
    const { apiKey } = createRateLimiters(ctx());
    const low = personal('key-low', 1);
    const high = personal('key-high', 5);

    expect((await runOnce(apiKey, low)).err).toBeUndefined();
    expect((await runOnce(apiKey, low)).err).toBeInstanceOf(ApiError);

    for (let i = 0; i < 5; i += 1) {
      expect((await runOnce(apiKey, high)).err).toBeUndefined();
    }
    expect((await runOnce(apiKey, high)).err).toBeInstanceOf(ApiError);
  });

  it('falls back to the config base schedule when a key has no resolved tier', async () => {
    const { apiKey } = createRateLimiters(ctx());
    // No `rateLimit` on the principal (e.g. an OAuth grant): base limit is 120.
    const untiered: Request['apiKey'] = { id: 'grant-x', kind: 'oauth', scopes: [] };
    for (let i = 0; i < 120; i += 1) {
      expect((await runOnce(apiKey, untiered)).err).toBeUndefined();
    }
    expect((await runOnce(apiKey, untiered)).err).toBeInstanceOf(ApiError);
  });
});
