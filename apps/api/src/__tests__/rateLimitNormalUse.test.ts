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

describe('the cost-metered reads are mounted in the real chain (§10 COST TABLE, #1643)', () => {
  /**
   * The four cost-metered endpoints, driven through the REAL middleware chain.
   * A unit test of `limiters.cost(...)` proves the guard; it cannot prove that
   * the guard is MOUNTED — and the rest of the API suite runs with
   * `rateLimits.enabled === false`, so every other test passes identically
   * whether or not the four `limiters.cost(...)` mounts exist.
   *
   * Each route puts the cost guard FIRST, ahead of multer / `validateBody` /
   * `validateParams`, so a request's own outcome (200, 400, 404) is irrelevant
   * here: what the assertions read is whether the guard let it through and what
   * it charged the `expensive` counter for it.
   */
  const COST = { socialShared: 10, analyticsSeries: 10, backtestPreview: 25, importCreate: 100 };
  /** `expensive`: 3000 units / minute (config/env.ts §10 COST TABLE). */
  const EXPENSIVE_LIMIT = 3000;

  it('charges each of the four endpoints its declared weight, and clears a normal minute', async () => {
    const limited = await createTestApp({ rateLimitsEnabled: true });
    const user = await limited.seedUser({ email: 'cost@bt.test', username: 'coster' });
    const cookie = await sessionCookie(limited.app, user);

    const created = await request(limited.app)
      .post('/api/v1/portfolios')
      .set(...XRW)
      .set('Cookie', cookie)
      .send({ name: 'Costed' });
    expect(created.status).toBe(201);
    const pid = created.body.portfolio.id as string;

    // A pessimistic ordinary minute at these four surfaces: the shared-with-me
    // list refetching on focus, an analytics panel being re-filtered, a few
    // debounced builder previews, one CSV upload.
    const SHARED = 6;
    const ANALYTICS = 6;
    const PREVIEWS = 4;
    const IMPORTS = 1;

    for (let i = 0; i < SHARED; i += 1) {
      const res = await request(limited.app).get('/api/v1/social/shared').set('Cookie', cookie);
      expect(res.status).toBe(200);
    }
    for (let i = 0; i < ANALYTICS; i += 1) {
      const res = await request(limited.app)
        .get(`/api/v1/analytics/portfolios/${pid}/series`)
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
    }
    for (let i = 0; i < PREVIEWS; i += 1) {
      // Past the guard, then rejected by `validateBody` — the 400 is proof the
      // request was NOT turned away by the limiter.
      const res = await request(limited.app)
        .post('/api/v1/backtest/preview')
        .set(...XRW)
        .set('Cookie', cookie)
        .send({});
      expect(res.status).toBe(400);
    }
    for (let i = 0; i < IMPORTS; i += 1) {
      const res = await request(limited.app)
        .post('/api/v1/imports')
        .set(...XRW)
        .set('Cookie', cookie);
      expect(res.status).toBe(400);
    }

    // Every one of the four mounts is present AND carries its own weight: drop
    // any single `limiters.cost(...)` and this total falls by that endpoint's
    // units. Nothing else in the app meters against `expensive`.
    const spent =
      SHARED * COST.socialShared +
      ANALYTICS * COST.analyticsSeries +
      PREVIEWS * COST.backtestPreview +
      IMPORTS * COST.importCreate;
    expect(spent).toBe(320);
    const key = progressiveKeys('expensive', limiterKeyForUser(user.id));
    expect(await limited.ctx.redis.get(key.count)).toBe(String(spent));
    // …and that realistic minute sits at roughly a tenth of the budget, so the
    // new dimension never fires during ordinary use.
    expect(spent * 9).toBeLessThan(EXPENSIVE_LIMIT);
    expect(await limited.ctx.redis.get(key.cooldown)).toBeNull();
  }, 120_000);

  it('turns a pathological caller away on COST before the request COUNT would have', async () => {
    const limited = await createTestApp({ rateLimitsEnabled: true });
    const user = await limited.seedUser({
      email: 'pathological@bt.test',
      username: 'pathological',
    });
    const bystander = await limited.seedUser({ email: 'bystander@bt.test', username: 'bystander' });
    const cookie = await sessionCookie(limited.app, user);

    // `limiters.cost('importCreate')` runs BEFORE multer, so a bodyless POST
    // spends its 100 units and is rejected for the missing file without the API
    // reading an upload: 30 of them exactly exhaust the minute's 3000 units.
    const drain = EXPENSIVE_LIMIT / COST.importCreate;
    expect(drain).toBe(30);
    for (let i = 0; i < drain; i += 1) {
      const res = await request(limited.app)
        .post('/api/v1/imports')
        .set(...XRW)
        .set('Cookie', cookie);
      expect(res.status).toBe(400);
    }

    const over = await request(limited.app)
      .post('/api/v1/imports')
      .set(...XRW)
      .set('Cookie', cookie);
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('RATE_LIMITED');
    expect(over.headers['retry-after']).toBe('20');
    expect(over.body.error.details).toEqual({ retryAfter: 20 });

    // The refusal came from the COST dimension: 31 requests is nowhere near
    // `generalBurst`'s 600/30 s or `general`'s 9000/15 min, and neither of their
    // ladders armed. That is the whole point of the dimension — the caller is
    // bounded by the WORK it asked for, not by how many requests carried it.
    expect(
      await limited.ctx.redis.get(
        progressiveKeys('expensive', limiterKeyForUser(user.id)).cooldown,
      ),
    ) //
      .toBe('1');
    for (const namespace of ['general', 'general_burst']) {
      expect(
        await limited.ctx.redis.get(
          progressiveKeys(namespace, limiterKeyForUser(user.id)).cooldown,
        ),
      ).toBeNull();
    }

    // While that cooldown is live the OTHER three mounts refuse too — same key,
    // same namespace — which is what proves each of them is wired to it.
    const shared = await request(limited.app).get('/api/v1/social/shared').set('Cookie', cookie);
    expect(shared.status).toBe(429);
    const analytics = await request(limited.app)
      .get('/api/v1/analytics/portfolios/00000000-0000-7000-8000-000000000000/series')
      .set('Cookie', cookie);
    expect(analytics.status).toBe(429);
    const preview = await request(limited.app)
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .set('Cookie', cookie)
      .send({});
    expect(preview.status).toBe(429);

    // …and the budget is PER USER: a second account on the same address reads
    // its shared list normally throughout.
    const bystanderCookie = await sessionCookie(limited.app, bystander);
    const unaffected = await request(limited.app)
      .get('/api/v1/social/shared')
      .set('Cookie', bystanderCookie);
    expect(unaffected.status).toBe(200);
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

  it('meters PIN SETTING on the login ladder, not the general per-user budget', async () => {
    // `PUT /auth/pin` runs an argon2id hash at 64 MiB per request. Under the
    // general limiter alone it allowed 600 req/min after the 2026-09-02
    // re-sizing — an authenticated amplification door where one cheap request
    // buys 64 MiB and a deliberately slow KDF. It rides the same strict ladder
    // as its `/pin/verify` sibling.
    const limited = await createTestApp({
      rateLimitsEnabled: true,
      env: { RATE_LIMIT_LOGIN_IP_LIMIT: '3', RATE_LIMIT_LOGIN_IP_WINDOW_SEC: '60' },
    });
    const user = await limited.seedUser({ email: 'pin@bt.test', username: 'pinner' });
    const cookie = await sessionCookie(limited.app, user);

    // The login above already spent one of the three; two sets fit, then the
    // per-IP rail closes — long before the general budget would have noticed.
    let status = 200;
    for (let i = 0; i < 6 && status !== 429; i += 1) {
      status = (
        await request(limited.app)
          .put('/api/v1/auth/pin')
          .set(...XRW)
          .set('Cookie', cookie)
          .send({ pin: '4731' })
      ).status;
    }
    expect(status).toBe(429);

    // …and the refusal came from the login rail, not the general one.
    const ip = progressiveKeys('login_ip', 'ip:::ffff:127.0.0.1').cooldown;
    const loopback = progressiveKeys('login_ip', 'ip:127.0.0.1').cooldown;
    const armed = (await limited.ctx.redis.get(ip)) ?? (await limited.ctx.redis.get(loopback));
    expect(armed).toBe('1');
    expect(
      await limited.ctx.redis.get(progressiveKeys('general', limiterKeyForUser(user.id)).cooldown),
    ).toBeNull();
  });
});
