import type { NextFunction, Request, Response } from 'express';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../../../config/env';
import { ApiError } from '../../../errors';
import type { AppContext } from '../../context';
import type { ProgressiveSchedule } from '../../../services/security/progressiveLimiter';
import { createRateLimiters } from '../rateLimit';

let redis: Redis;

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
});

// A generous base `apiKey` schedule; per-key tiers override only (limit, window).
// `overrides` lets one test tighten the interactive `general` pair to prove a
// bearer request never spends it (#1730).
const ctx = (overrides: { general?: ProgressiveSchedule } = {}): AppContext => {
  const base = { windowSec: 60, limit: 120, cooldownsSec: [20, 60], decaySec: 900 };
  const config = {
    rateLimits: {
      enabled: true,
      general: overrides.general ?? base,
      generalBurst: overrides.general ?? base,
      // The cost dimension (§10 COST TABLE, #1643) is irrelevant to per-key
      // tiers, but `createRateLimiters` builds every limiter up front.
      expensive: base,
      requestCosts: {
        socialShared: 10,
        backtestPreview: 25,
        analyticsSeries: 10,
        importCreate: 100,
      },
      search: base,
      social: base,
      feedback: base,
      feedbackThread: base,
      vault: base,
      vaultRead: base,
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
  firstParty: false,
  scopes: ['portfolio:read'],
  securityGeneration: 0,
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
    const untiered: Request['apiKey'] = {
      id: 'grant-x',
      kind: 'oauth',
      firstParty: false,
      scopes: [],
      securityGeneration: 0,
    };
    for (let i = 0; i < 120; i += 1) {
      expect((await runOnce(apiKey, untiered)).err).toBeUndefined();
    }
    expect((await runOnce(apiKey, untiered)).err).toBeInstanceOf(ApiError);
  });
});

/**
 * #1730 — the per-key tier was silently bounded by the per-user `general`
 * budget, because a bearer request resolves `req.authUser` too and therefore
 * landed in the owner's interactive counter first. `general` now hands bearer
 * requests straight through; `apiKeyGuard` is the whole budget a key has.
 */
describe('#1730 a key’s tier is not capped by the owner’s general budget', () => {
  const OWNER = 'user-1';
  const TIGHT: ProgressiveSchedule = {
    windowSec: 60,
    limit: 2,
    cooldownsSec: [20, 60],
    decaySec: 900,
  };

  /** Drive one handler for a request that may or may not carry a bearer key. */
  const run = (
    handler: (req: Request, res: Response, next: NextFunction) => void,
    apiKey?: Request['apiKey'],
  ): Promise<unknown> => {
    const req = {
      ip: '10.0.0.1',
      method: 'GET',
      // Set for BOTH kinds: a bearer principal resolves `authUser` as well, which
      // is exactly why it used to meter into the owner's bucket.
      authUser: { id: OWNER },
      apiKey,
    } as unknown as Request;
    const res = { setHeader() {} } as unknown as Response;
    return new Promise((resolve) => handler(req, res, (err?: unknown) => resolve(err)));
  };

  it('reaches a tier well above the general limit, denied only by its own tier', async () => {
    const { general, apiKey } = createRateLimiters(ctx({ general: TIGHT }));
    const key = personal('key-fast', 5);

    for (let i = 0; i < 5; i += 1) {
      expect(await run(general, key), `general #${i + 1}`).toBeUndefined();
      expect(await run(apiKey, key), `apiKey #${i + 1}`).toBeUndefined();
    }
    // The 6th is refused by the KEY's own tier — never by the general budget of 2.
    expect(await run(general, key)).toBeUndefined();
    const overflow = await run(apiKey, key);
    expect(overflow).toBeInstanceOf(ApiError);
    expect((overflow as ApiError).statusCode).toBe(429);
  });

  it('leaves the owner’s interactive allowance untouched', async () => {
    const { general, apiKey } = createRateLimiters(ctx({ general: TIGHT }));
    const key = personal('key-busy', 100);

    for (let i = 0; i < 20; i += 1) {
      await run(general, key);
      await run(apiKey, key);
    }

    // The human's browser session still has its full 2-request allowance, and
    // the runaway integration never armed the general cooldown that would have
    // locked them out of the web UI.
    expect(await run(general)).toBeUndefined();
    expect(await run(general)).toBeUndefined();
    expect(await run(general)).toBeInstanceOf(ApiError);
  });
});
