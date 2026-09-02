import type { Application } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { limiterKeyForUser } from '../http/middleware/rateLimit';
import { progressiveKeys } from '../services/security/progressiveLimiter';
import { createTestApp, type SeededUser } from '../testing/createTestApp';

/**
 * The §10 limiters, exercised through the REAL middleware chain rather than the
 * guard in isolation — the bit that unit tests cannot prove is that
 * `limiters.general` is mounted AFTER the bearer/session middleware, so
 * `req.authUser` is actually resolved by the time the key is derived. If that
 * ordering ever regresses, every signed-in request silently falls back to its
 * address and a household shares one bucket again.
 *
 * Owner directive 2026-09-02 ("increase rate limits… before blocking").
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

type Agent = ReturnType<typeof request.agent>;

/** Log in and return the session cookie, for callers that avoid a shared agent. */
async function sessionCookie(app: Application, user: SeededUser): Promise<string[]> {
  const response = await request(app)
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(response.status).toBe(200);
  const setCookie: unknown = response.headers['set-cookie'];
  const cookies = (Array.isArray(setCookie) ? setCookie : [setCookie]).filter(
    (value): value is string => typeof value === 'string',
  );
  expect(cookies.length).toBeGreaterThan(0);
  return cookies;
}

async function loginAgent(app: Application, user: SeededUser): Promise<Agent> {
  const agent = request.agent(app);
  const response = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(response.status).toBe(200);
  return agent;
}

describe('general limiter keys authenticated traffic by user (§10)', () => {
  it('meters two accounts on one address separately, and 429s only the one over budget', async () => {
    // Both agents come from the same supertest address, which is exactly the
    // household / office / CGNAT case the keying has to survive.
    const limited = await createTestApp({
      rateLimitsEnabled: true,
      env: { RATE_LIMIT_BURST_LIMIT: '4', RATE_LIMIT_BURST_WINDOW_SEC: '60' },
    });
    const alice = await limited.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await limited.seedUser({ email: 'bob@bt.test', username: 'bob' });

    // The login itself spends part of Alice's budget; drain what is left.
    const aliceAgent = await loginAgent(limited.app, alice);
    let aliceStatus = 200;
    for (let i = 0; i < 10 && aliceStatus !== 429; i += 1) {
      aliceStatus = (await aliceAgent.get('/api/v1/auth/me')).status;
    }
    expect(aliceStatus).toBe(429);

    // Bob shares the address and is unaffected: his own login and first reads
    // succeed while Alice is in her cooldown.
    const bobAgent = await loginAgent(limited.app, bob);
    expect((await bobAgent.get('/api/v1/auth/me')).status).toBe(200);

    // …and the two cooldowns are recorded under two different user keys.
    const aliceKey = progressiveKeys('general_burst', limiterKeyForUser(alice.id)).cooldown;
    expect(await limited.ctx.redis.get(aliceKey)).toBe('1');
    expect(
      await limited.ctx.redis.get(
        progressiveKeys('general_burst', limiterKeyForUser(bob.id)).cooldown,
      ),
    ) //
      .toBeNull();
  });

  it('carries Retry-After on the 429, as a header and in the body', async () => {
    const limited = await createTestApp({
      rateLimitsEnabled: true,
      env: { RATE_LIMIT_BURST_LIMIT: '3', RATE_LIMIT_BURST_WINDOW_SEC: '60' },
    });
    const user = await limited.seedUser({ email: 'retry@bt.test', username: 'retry' });
    const agent = await loginAgent(limited.app, user);

    let over = await agent.get('/api/v1/auth/me');
    for (let i = 0; i < 10 && over.status !== 429; i += 1) {
      over = await agent.get('/api/v1/auth/me');
    }

    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('RATE_LIMITED');
    // The client reads the header first and the body as a cross-origin-safe
    // fallback (see `apps/web/src/lib/apiClient.ts`), so BOTH must be present.
    expect(over.headers['retry-after']).toBe('20');
    expect(over.body.error.details).toEqual({ retryAfter: 20 });
  });

  it('exposes Retry-After to a cross-origin SPA', async () => {
    // The web app and the API are separate origins in both deployment modes
    // (§4.6). Without this the header is invisible to `fetch`, and the client's
    // backoff silently degrades to a fixed floor.
    const limited = await createTestApp({
      rateLimitsEnabled: true,
      env: { RATE_LIMIT_BURST_LIMIT: '3', RATE_LIMIT_BURST_WINDOW_SEC: '60' },
    });
    const web = limited.ctx.config.corsOrigins[0]!;
    const user = await limited.seedUser({ email: 'cors@bt.test', username: 'cors' });
    const agent = await loginAgent(limited.app, user);

    let over = await agent.get('/api/v1/auth/me').set('Origin', web);
    for (let i = 0; i < 10 && over.status !== 429; i += 1) {
      over = await agent.get('/api/v1/auth/me').set('Origin', web);
    }

    expect(over.status).toBe(429);
    expect(over.headers['access-control-expose-headers']).toContain('Retry-After');
  });
});

describe('the shipped ceilings clear ordinary use (§10)', () => {
  /**
   * The burst ceiling in force until 2026-09-02. One cold load of a widget
   * dashboard is ~50 requests, so a second tab reloading crossed this — which is
   * the "every other day" the owner reported.
   */
  const CEILING_BEFORE_THIS_PASS = 60;

  it('serves more reads in one burst window than the pre-2026-09-02 ceiling allowed', async () => {
    // Default ceilings, no env override — the shipped production numbers.
    const limited = await createTestApp({ rateLimitsEnabled: true });
    const user = await limited.seedUser({ email: 'burst@bt.test', username: 'burst' });
    // Drive the reads with an explicit cookie rather than a supertest agent:
    // dozens of sequential calls over the agent's single reused keep-alive
    // socket desynchronise its HTTP parser under load, which fails the run for
    // a transport reason that has nothing to do with the limiter.
    const cookie = await sessionCookie(limited.app, user);

    for (let i = 0; i < CEILING_BEFORE_THIS_PASS + 1; i += 1) {
      const res = await request(limited.app).get('/api/v1/auth/me').set('Cookie', cookie);
      expect(res.status).toBe(200);
    }

    // Everything above landed in ONE burst window and the guard never armed.
    const key = progressiveKeys('general_burst', limiterKeyForUser(user.id));
    expect(Number(await limited.ctx.redis.get(key.count))).toBeGreaterThan(
      CEILING_BEFORE_THIS_PASS,
    );
    expect(await limited.ctx.redis.get(key.cooldown)).toBeNull();
  }, 120_000);
});

describe('the strict limiters stay strict (§10, §6.1)', () => {
  it('still turns away credential stuffing from one address, across accounts', async () => {
    const limited = await createTestApp({
      rateLimitsEnabled: true,
      env: { RATE_LIMIT_LOGIN_IP_LIMIT: '3', RATE_LIMIT_LOGIN_IP_WINDOW_SEC: '60' },
    });
    await limited.seedUser({ email: 'victim@bt.test', username: 'victim' });

    // Wrong password, varied identifiers — the per-IP rail is what has to notice,
    // because no single account counter would.
    let status = 401;
    for (let i = 0; i < 4 && status !== 429; i += 1) {
      status = (
        await request(limited.app)
          .post('/api/v1/auth/login')
          .set(...XRW)
          .send({ identifier: `guess-${i}@bt.test`, password: 'not-the-password' })
      ).status;
    }
    expect(status).toBe(429);
  });
});
