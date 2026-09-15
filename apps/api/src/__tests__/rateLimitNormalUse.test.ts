import type { Application } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { FRIEND_GROUP_MEMBERS_MAX } from '@bettertrack/contracts';

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
   * Every cost-metered endpoint, driven through the REAL middleware chain. A
   * unit test of `limiters.cost(...)` proves the guard; it cannot prove that the
   * guard is MOUNTED — and the rest of the API suite runs with
   * `rateLimits.enabled === false`, so every other test passes identically
   * whether or not those `limiters.cost(...)` mounts exist.
   *
   * Each route puts the cost guard FIRST, ahead of multer / `validateBody` /
   * `validateParams`, so a request's own outcome (200, 400, 404) is irrelevant
   * here: what the assertions read is whether the guard let it through and what
   * it charged the `expensive` counter for it.
   */
  const COST = {
    socialShared: 10,
    /** Shared by the thread PAGE read and its collapsed head (#1855). */
    socialThread: 7,
    /** The audience write's per-recipient fan-out (#1855). */
    socialAudienceSet: 20,
    analyticsSeries: 10,
    backtestPreview: 25,
    /** Per SERIES — the comparison route multiplies by the body's id count (#1755). */
    backtestCompare: 20,
    backtestSharedSandbox: 25,
    /** The Invest Calculator's 250-asset fan-out (#1877). */
    conglomerateAllocate: 15,
    importCreate: 100,
  };
  /**
   * `backtestPreview` is priced per 50-position basket unit (#1877) — the §6.5
   * write cap — so a Builder draft costs one unit and a nested blueprint's
   * resolved flatten costs up to five.
   */
  const PREVIEW_BASKET_UNIT = 50;
  /** `expensive`: 4000 units / minute (config/env.ts §10 COST TABLE). */
  const EXPENSIVE_LIMIT = 4000;
  /** A syntactically valid conglomerate id — the sandbox route validates params. */
  const SOME_ID = '018f0000-0000-7000-8000-000000000001';

  it('charges each metered endpoint its declared weight, and clears a normal minute', async () => {
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

    // A pessimistic ordinary minute at these surfaces: the shared-with-me list
    // refetching on focus, an analytics panel being re-filtered, a few debounced
    // builder previews, one CSV upload, one three-basket comparison, a couple
    // of what-if tweaks on a friend's shared basket, and an expanded comment
    // thread refetching on its own 30 s poll.
    const SHARED = 6;
    const THREADS = 3;
    const SUMMARIES = 3;
    const AUDIENCE_SETS = 2;
    const ANALYTICS = 6;
    const PREVIEWS = 4;
    const IMPORTS = 1;
    const COMPARE_SERIES = 3;
    const SANDBOXES = 2;
    const ALLOCATES = 2;

    for (let i = 0; i < SHARED; i += 1) {
      const res = await request(limited.app).get('/api/v1/social/shared').set('Cookie', cookie);
      expect(res.status).toBe(200);
    }
    for (let i = 0; i < THREADS; i += 1) {
      // The owner's own portfolio: a 200 proves the read ran, and the counter
      // below proves `limiters.cost('socialThread')` is mounted on it (#1829).
      const res = await request(limited.app)
        .get(`/api/v1/social/items/portfolio/${pid}/thread`)
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
    }
    for (let i = 0; i < SUMMARIES; i += 1) {
      // The collapsed head. It shipped metered by NOTHING while its sibling
      // above paid for the same access resolution (#1855).
      const res = await request(limited.app)
        .get(`/api/v1/social/items/portfolio/${pid}/thread/summary`)
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
    }
    for (let i = 0; i < AUDIENCE_SETS; i += 1) {
      // Past the cost guard, then rejected by `validateBody`: the 400 is proof
      // the meter — not the audience layer — is what the request cleared.
      const res = await request(limited.app)
        .put(`/api/v1/social/audience/portfolio/${pid}`)
        .set(...XRW)
        .set('Cookie', cookie)
        .send({});
      expect(res.status).toBe(400);
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
    {
      // One comparison over three baskets. The guard runs before `validateBody`,
      // so the ids alone are enough to price it and the body is then a 400.
      const res = await request(limited.app)
        .post('/api/v1/backtest/compare')
        .set(...XRW)
        .set('Cookie', cookie)
        .send({ conglomerateIds: [SOME_ID, SOME_ID, SOME_ID] });
      expect(res.status).toBe(400);
    }
    for (let i = 0; i < SANDBOXES; i += 1) {
      const res = await request(limited.app)
        .post(`/api/v1/backtest/shared/${SOME_ID}/preview`)
        .set(...XRW)
        .set('Cookie', cookie)
        .send({});
      expect(res.status).toBe(400);
    }
    for (let i = 0; i < ALLOCATES; i += 1) {
      // The Invest Calculator, metered by nothing at all until #1877. The guard
      // is mounted ahead of `validateParams`, so the 400 is again proof the
      // request cleared the meter rather than the allocation layer.
      const res = await request(limited.app)
        .post(`/api/v1/conglomerates/${SOME_ID}/allocate`)
        .set(...XRW)
        .set('Cookie', cookie)
        .send({});
      expect(res.status).toBe(400);
    }

    // Every mount is present AND carries its own weight: drop any single
    // `limiters.cost(...)` and this total falls by that endpoint's units.
    const spent =
      SHARED * COST.socialShared +
      THREADS * COST.socialThread +
      SUMMARIES * COST.socialThread +
      AUDIENCE_SETS * COST.socialAudienceSet +
      ANALYTICS * COST.analyticsSeries +
      PREVIEWS * COST.backtestPreview +
      IMPORTS * COST.importCreate +
      COMPARE_SERIES * COST.backtestCompare +
      SANDBOXES * COST.backtestSharedSandbox +
      ALLOCATES * COST.conglomerateAllocate;
    expect(spent).toBe(542);
    const key = progressiveKeys('expensive', limiterKeyForUser(user.id));
    expect(await limited.ctx.redis.get(key.count)).toBe(String(spent));

    // …and NOTHING ELSE in the app meters against `expensive`. Until #1755 that
    // sentence was a comment sitting next to a total that omitted the two most
    // expensive reads in the app, and until #1855 it was still satisfied BY the
    // thread head's omission rather than in spite of it — the omission was
    // pinned, not caught. Both now carry weights above, so what is left below is
    // genuinely unmetered work: an ordinary read from a route with no cost mount
    // leaves the work counter exactly where the metered calls left it.
    for (const path of ['/api/v1/conglomerates', '/api/v1/portfolios', '/api/v1/auth/me']) {
      expect((await request(limited.app).get(path).set('Cookie', cookie)).status).toBe(200);
    }
    expect(await limited.ctx.redis.get(key.count)).toBe(String(spent));
    // …and that realistic minute still sits at roughly a SEVENTH of the budget,
    // so the dimension never fires during ordinary use. It was a tenth before
    // #1755 added two more surfaces to the same pessimistic minute, and an
    // eighth before #1829 added the thread; the ratio moves because the minute
    // gets bigger, not because the ceiling gets looser.
    expect(spent * 7).toBeLessThan(EXPENSIVE_LIMIT);
    expect(await limited.ctx.redis.get(key.cooldown)).toBeNull();
  }, 120_000);

  it('prices a preview by the basket it carries, not by the request (#1877)', async () => {
    const limited = await createTestApp({ rateLimitsEnabled: true });
    const user = await limited.seedUser({ email: 'flatten@bt.test', username: 'flattener' });
    const cookie = await sessionCookie(limited.app, user);
    const key = progressiveKeys('expensive', limiterKeyForUser(user.id));

    // A Builder draft — the shape this weight was set for — is one unit.
    const draft = await request(limited.app)
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .set('Cookie', cookie)
      .send({ positions: Array.from({ length: PREVIEW_BASKET_UNIT }, () => ({})) });
    expect(draft.status).toBe(400);
    expect(await limited.ctx.redis.get(key.count)).toBe(String(COST.backtestPreview));

    // A nested blueprint's resolved flatten is FOUR of those baskets, and since
    // the preview bound became MAX_FLATTENED_POSITIONS it may arrive in one
    // request. Read off the raw body, so the price is set before `validateBody`
    // has a chance to reject the garbage positions.
    const flattened = await request(limited.app)
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .set('Cookie', cookie)
      .send({ positions: Array.from({ length: 4 * PREVIEW_BASKET_UNIT }, () => ({})) });
    expect(flattened.status).toBe(400);
    expect(await limited.ctx.redis.get(key.count)).toBe(String(COST.backtestPreview * 5));

    // A caller cannot name its own price: past the contract's own bound the
    // multiplier is clamped at the cap the request is about to be refused at.
    const oversized = await request(limited.app)
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .set('Cookie', cookie)
      .send({ positions: Array.from({ length: 1_000 }, () => ({})) });
    expect(oversized.status).toBe(400);
    expect(await limited.ctx.redis.get(key.count)).toBe(String(COST.backtestPreview * 10));
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
    // reading an upload: 40 of them spend the minute's 4000 units exactly, so
    // the 41st has nothing left to buy.
    const drain = Math.floor(EXPENSIVE_LIMIT / COST.importCreate);
    expect(drain).toBe(40);
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

    // The refusal came from the COST dimension: 41 requests is nowhere near
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

    // While that cooldown is live the OTHER mounts refuse too — same key, same
    // namespace — which is what proves each of them is wired to it.
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
    const compare = await request(limited.app)
      .post('/api/v1/backtest/compare')
      .set(...XRW)
      .set('Cookie', cookie)
      .send({});
    expect(compare.status).toBe(429);
    const sandbox = await request(limited.app)
      .post('/api/v1/backtest/shared/018f0000-0000-7000-8000-000000000001/preview')
      .set(...XRW)
      .set('Cookie', cookie)
      .send({});
    expect(sandbox.status).toBe(429);
    // …including the two mounts #1855 added.
    const summary = await request(limited.app)
      .get(`/api/v1/social/items/portfolio/${SOME_ID}/thread/summary`)
      .set('Cookie', cookie);
    expect(summary.status).toBe(429);
    const audience = await request(limited.app)
      .put(`/api/v1/social/audience/portfolio/${SOME_ID}`)
      .set(...XRW)
      .set('Cookie', cookie)
      .send({});
    expect(audience.status).toBe(429);

    // …and the budget is PER USER: a second account on the same address reads
    // its shared list normally throughout.
    const bystanderCookie = await sessionCookie(limited.app, bystander);
    const unaffected = await request(limited.app)
      .get('/api/v1/social/shared')
      .set('Cookie', bystanderCookie);
    expect(unaffected.status).toBe(200);
  }, 120_000);

  it('prices a comparison by its SERIES COUNT and refuses a burst the request count waves through', async () => {
    // The N-way comparison is the most expensive read in the app — up to six
    // baskets, each flattening to 250 assets, each its own engine run — and it
    // shipped metered by nothing but the app-wide request counter at 600/min
    // (#1755). Its price therefore has to scale with what the body asks for.
    const limited = await createTestApp({ rateLimitsEnabled: true });
    const user = await limited.seedUser({ email: 'comparer@bt.test', username: 'comparer' });
    const cookie = await sessionCookie(limited.app, user);
    const key = progressiveKeys('expensive', limiterKeyForUser(user.id));

    const compare = (series: number) =>
      request(limited.app)
        .post('/api/v1/backtest/compare')
        .set(...XRW)
        .set('Cookie', cookie)
        .send({ conglomerateIds: Array.from({ length: series }, () => SOME_ID) });

    // The guard runs ahead of `validateBody` (these bodies are 400s), so what is
    // read here is purely what the meter charged: two baskets, then six.
    expect((await compare(2)).status).toBe(400);
    expect(await limited.ctx.redis.get(key.count)).toBe(String(2 * COST.backtestCompare));
    expect((await compare(6)).status).toBe(400);
    expect(await limited.ctx.redis.get(key.count)).toBe(String(8 * COST.backtestCompare));

    // A six-way comparison spends 120 units, so ~29 of them exhaust the minute.
    const six = 6 * COST.backtestCompare;
    const remaining = Math.floor((EXPENSIVE_LIMIT - 8 * COST.backtestCompare) / six);
    for (let i = 0; i < remaining; i += 1) {
      expect((await compare(6)).status).toBe(400);
    }
    const over = await compare(6);
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('RATE_LIMITED');

    // That burst is 30 requests. `general` allows 600/min and `generalBurst`
    // 600/30 s, so the COUNT dimension would have waved every one of them
    // through — neither ladder armed. Only the WORK budget noticed.
    expect(remaining + 3).toBeLessThan(60);
    for (const namespace of ['general', 'general_burst']) {
      expect(
        await limited.ctx.redis.get(
          progressiveKeys(namespace, limiterKeyForUser(user.id)).cooldown,
        ),
      ).toBeNull();
    }
  }, 120_000);
});

/**
 * The V5-P8 interaction surface, driven through the REAL middleware chain
 * (#1855). V5-P8 mounted comments, item reactions, comment reactions, comment
 * moderation and the whole friend-circle surface on `limiters.social` — the
 * anti-probing bucket that exists to make bulk email→username guessing
 * expensive, and which §10 exempts from the normal-use sizing rule. These tests
 * are the ones a unit test of the schedules cannot write: they read which
 * NAMESPACE each route actually spends from.
 */
describe('the V5-P8 interaction writes have a budget of their own (#1855)', () => {
  /** A syntactically valid subject id — the routes validate their params. */
  const SOME_ID = '018f0000-0000-7000-8000-000000000001';

  const addMember = (app: Application, cookie: string[], groupId: string) =>
    request(app)
      .post(`/api/v1/social/groups/${groupId}/members`)
      .set(...XRW)
      .set('Cookie', cookie)
      .send({ userId: SOME_ID });

  it('lets one request per member reach the 200-member circle the contract advertises', async () => {
    // `FRIEND_GROUP_MEMBERS_MAX` is 200 and there is NO bulk endpoint, so the
    // ceiling is only reachable one POST at a time. On the 30/hour anti-probing
    // bucket that was ~7 hours of perfectly paced clicking — and the same hour
    // also closed the user's friend requests, comments and reactions.
    const limited = await createTestApp({ rateLimitsEnabled: true });
    const user = await limited.seedUser({ email: 'circle@bt.test', username: 'circler' });
    const cookie = await sessionCookie(limited.app, user);

    const created = await request(limited.app)
      .post('/api/v1/social/groups')
      .set(...XRW)
      .set('Cookie', cookie)
      .send({ name: 'Inner circle' });
    expect(created.status).toBe(201);
    const groupId = created.body.id as string;

    // Each add clears the limiter and is then refused by the service for the
    // non-friend it names (§6.9) — a 4xx that is not 429 is the whole assertion.
    for (let i = 0; i < FRIEND_GROUP_MEMBERS_MAX; i += 1) {
      const res = await addMember(limited.app, cookie, groupId);
      expect(res.status).not.toBe(429);
    }

    // The create + 200 adds all landed in ONE window and nothing armed.
    const key = progressiveKeys('social_write', limiterKeyForUser(user.id));
    expect(Number(await limited.ctx.redis.get(key.count))).toBeGreaterThan(
      FRIEND_GROUP_MEMBERS_MAX,
    );
    expect(await limited.ctx.redis.get(key.cooldown)).toBeNull();
    // …and none of it was charged to the anti-probing bucket, which is still
    // untouched: filling a circle must not spend a friend-request allowance.
    expect(
      await limited.ctx.redis.get(progressiveKeys('social', limiterKeyForUser(user.id)).count),
    ).toBeNull();
  }, 120_000);

  it('leaves the interaction writes open when the friend-request rail is spent', async () => {
    const limited = await createTestApp({ rateLimitsEnabled: true });
    const user = await limited.seedUser({ email: 'prober@bt.test', username: 'prober' });
    const cookie = await sessionCookie(limited.app, user);

    // Exhaust the strict bucket the honest way: 30 friend requests in an hour.
    let status = 202;
    for (let i = 0; i < 40 && status !== 429; i += 1) {
      status = (
        await request(limited.app)
          .post('/api/v1/social/requests')
          .set(...XRW)
          .set('Cookie', cookie)
          .send({ identifier: `nobody-${i}@bt.test` })
      ).status;
    }
    expect(status).toBe(429);

    // The V5-P8 writes are untouched: each clears its own limiter and is then
    // answered by the audience layer (404 for an item the caller cannot see).
    const comment = await request(limited.app)
      .post(`/api/v1/social/items/portfolio/${SOME_ID}/comments`)
      .set(...XRW)
      .set('Cookie', cookie)
      .send({ body: 'hi' });
    expect(comment.status).not.toBe(429);
    const reaction = await request(limited.app)
      .post(`/api/v1/social/items/portfolio/${SOME_ID}/reactions`)
      .set(...XRW)
      .set('Cookie', cookie)
      .send({ emoji: '🔥' });
    expect(reaction.status).not.toBe(429);
  });

  it('leaves the friend-request rail open when the interaction budget is spent', async () => {
    const limited = await createTestApp({ rateLimitsEnabled: true });
    const user = await limited.seedUser({ email: 'chatty@bt.test', username: 'chatty' });
    const cookie = await sessionCookie(limited.app, user);

    // Arming the cooldown IS the state 1200 writes would leave behind; draining
    // it request by request would take a thousand round trips to prove the same
    // thing. What matters is which namespace each route reads.
    await limited.ctx.redis.set(
      progressiveKeys('social_write', limiterKeyForUser(user.id)).cooldown,
      '1',
      'EX',
      60,
    );

    // Every V5-P8 interaction write is refused — which is what proves each of
    // them is wired to this namespace rather than to the strict one.
    const refused = [
      request(limited.app)
        .post(`/api/v1/social/items/portfolio/${SOME_ID}/comments`)
        .set(...XRW)
        .set('Cookie', cookie)
        .send({ body: 'hi' }),
      request(limited.app)
        .post(`/api/v1/social/items/portfolio/${SOME_ID}/reactions`)
        .set(...XRW)
        .set('Cookie', cookie)
        .send({ emoji: '🔥' }),
      request(limited.app)
        .post(`/api/v1/social/comments/${SOME_ID}/reactions`)
        .set(...XRW)
        .set('Cookie', cookie)
        .send({ emoji: '🔥' }),
      request(limited.app)
        .delete(`/api/v1/social/comments/${SOME_ID}`)
        .set(...XRW)
        .set('Cookie', cookie),
      request(limited.app)
        .post('/api/v1/social/groups')
        .set(...XRW)
        .set('Cookie', cookie)
        .send({ name: 'Blocked' }),
      addMember(limited.app, cookie, SOME_ID),
    ];
    for (const pending of refused) {
      expect((await pending).status).toBe(429);
    }

    // …and friend-request creation is NOT: its budget is a different namespace,
    // and a spent emoji allowance may not close the rail §10 sized for probing.
    const friendRequest = await request(limited.app)
      .post('/api/v1/social/requests')
      .set(...XRW)
      .set('Cookie', cookie)
      .send({ identifier: 'someone@bt.test' });
    expect(friendRequest.status).not.toBe(429);
  });

  it("stops an audience replay loop long before it can fan out at general's rate", async () => {
    // `PUT /social/audience/:kind/:subjectId` has the largest fan-out of any
    // V5-P8 write — the owner's whole friendship set, a roster of up to 200, a
    // transition lock per derived recipient and one notification emit each — and
    // it shipped metered by nothing but the app-wide request counter, i.e. at
    // 600 req/min, while a single emoji toggle was capped at 30/hour.
    const limited = await createTestApp({ rateLimitsEnabled: true });
    const user = await limited.seedUser({ email: 'audience@bt.test', username: 'audiencer' });
    const cookie = await sessionCookie(limited.app, user);

    const put = () =>
      request(limited.app)
        .put(`/api/v1/social/audience/portfolio/${SOME_ID}`)
        .set(...XRW)
        .set('Cookie', cookie)
        .send({});

    // 20 units each, so the minute's 4000 buy 200 calls — the guard runs ahead
    // of `validateBody`, so the 400s below are proof the meter is what let them
    // through, not the handler.
    const allowed = Math.floor(4000 / 20);
    expect(allowed).toBe(200);
    for (let i = 0; i < allowed; i += 1) {
      expect((await put()).status).toBe(400);
    }
    const over = await put();
    expect(over.status).toBe(429);

    // The COUNT dimension would have waved all 201 through: `general` allows
    // 600/min and `generalBurst` 600/30 s, and neither ladder armed. The write
    // is now bounded by the fan-out it asks for, at a THIRD of that rate.
    expect(allowed * 3).toBeLessThanOrEqual(600);
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
