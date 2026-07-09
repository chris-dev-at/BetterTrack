import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { profileSettingsResponseSchema, publicProfileResponseSchema } from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createStubMarketData } from '../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Public profiles + per-shared-item activity prefs (V3-P6, #374). The profile
 * REUSES the #332 audience model: it composes ONLY the owner's `public_link`
 * items, so a non-public item can never render — proven here by a sweep across
 * all three kinds. Disabling the profile 404s the slug instantly; enabling needs
 * the §16 acknowledgment. The activity toggle only writes a preference, and only
 * while the viewer is authorized to read the item (404 otherwise).
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

function stubMarketData() {
  return createStubMarketData({
    quote: () => ({
      value: {
        price: 120,
        currency: 'EUR',
        prevClose: 100,
        dayChangePct: 20,
        asOf: new Date().toISOString(),
      },
      stale: false,
      asOf: Date.now(),
    }),
  });
}

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp({ marketData: stubMarketData() });
});

type Agent = ReturnType<typeof request.agent>;

async function loginAgent(app: Application, identifier: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

async function befriend(from: Agent, to: Agent, toIdentifier: string): Promise<void> {
  await from
    .post('/api/v1/social/requests')
    .set(...XRW)
    .send({ identifier: toIdentifier });
  const inbox = await to.get('/api/v1/social/requests');
  const requestId = inbox.body.incoming[0]?.id as string;
  const res = await to
    .post(`/api/v1/social/requests/${requestId}/accept`)
    .set(...XRW)
    .send();
  expect(res.status).toBe(200);
}

async function defaultPortfolioId(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  return res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault).id as string;
}

async function defaultWatchlistId(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/workboard/watchlists');
  return res.body.watchlists.find((w: { isDefault: boolean }) => w.isDefault).id as string;
}

async function seedConglomerate(agent: Agent, assetId: string): Promise<string> {
  const create = await agent
    .post('/api/v1/conglomerates')
    .set(...XRW)
    .send({ name: 'Tech basket' });
  expect(create.status).toBe(201);
  const id = create.body.id as string;
  await agent
    .put(`/api/v1/conglomerates/${id}/positions`)
    .set(...XRW)
    .send({ positions: [{ assetId, weightPct: 100 }] });
  return id;
}

function putAudience(
  agent: Agent,
  kind: 'portfolio' | 'conglomerate' | 'watchlist',
  subjectId: string,
  body: { audience: string; friendIds?: string[]; acknowledgePublic?: boolean },
): Promise<request.Response> {
  return agent
    .put(`/api/v1/social/audience/${kind}/${subjectId}`)
    .set(...XRW)
    .send(body);
}

/** alice (owner) + bob (friend), an asset, a funded portfolio, a conglomerate, a watchlist. */
async function scenario() {
  const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
  const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
  const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
  const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
  await befriend(aliceAgent, bobAgent, 'bob');

  const pid = await defaultPortfolioId(aliceAgent);
  const [asset] = await harness.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: 'BAYN.DE',
      type: 'stock',
      symbol: 'BAYN.DE',
      name: 'Bayer AG',
      currency: 'EUR',
      exchange: 'XETRA',
    })
    .returning();
  await aliceAgent
    .post(`/api/v1/portfolios/${pid}/transactions`)
    .set(...XRW)
    .send({
      assetId: asset!.id,
      side: 'buy',
      quantity: 1,
      price: 100,
      executedAt: `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
    });
  const cid = await seedConglomerate(aliceAgent, asset!.id);
  const wid = await defaultWatchlistId(aliceAgent);
  const bobId = bob.id;
  return { aliceAgent, bobAgent, pid, cid, wid, bobId };
}

describe('per-shared-item activity alerts (V3-P6)', () => {
  it('persists the viewer preference and reflects it in Shared With Me', async () => {
    const { aliceAgent, bobAgent, pid } = await scenario();
    await putAudience(aliceAgent, 'portfolio', pid, { audience: 'all_friends' });

    // Default: off.
    let shared = await bobAgent.get('/api/v1/social/shared');
    expect(shared.body.portfolios[0].activityAlertsEnabled).toBe(false);

    // Enable.
    const on = await bobAgent
      .put(`/api/v1/social/shared/activity/portfolio/${pid}`)
      .set(...XRW)
      .send({ enabled: true });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ kind: 'portfolio', subjectId: pid, enabled: true });

    shared = await bobAgent.get('/api/v1/social/shared');
    expect(shared.body.portfolios[0].activityAlertsEnabled).toBe(true);

    // Disable.
    await bobAgent
      .put(`/api/v1/social/shared/activity/portfolio/${pid}`)
      .set(...XRW)
      .send({ enabled: false });
    shared = await bobAgent.get('/api/v1/social/shared');
    expect(shared.body.portfolios[0].activityAlertsEnabled).toBe(false);
  });

  it('404s (never 403) when the viewer is not authorized to read the item', async () => {
    const { aliceAgent, bobAgent, pid } = await scenario();
    // Portfolio stays private → bob cannot read it → cannot set a pref on it.
    await putAudience(aliceAgent, 'portfolio', pid, { audience: 'private' });
    const res = await bobAgent
      .put(`/api/v1/social/shared/activity/portfolio/${pid}`)
      .set(...XRW)
      .send({ enabled: true });
    expect(res.status).toBe(404);
  });
});

describe('public profile (V3-P6)', () => {
  it('404s a logged-out visitor while the profile is opted-out or the user is unknown', async () => {
    await scenario();
    expect((await request(harness.app).get('/api/v1/social/profiles/alice')).status).toBe(404);
    expect((await request(harness.app).get('/api/v1/social/profiles/nobody')).status).toBe(404);
  });

  it('enabling requires the acknowledgment (§16), then composes exactly the public_link items', async () => {
    const { aliceAgent, pid, cid, wid, bobId } = await scenario();

    // Audiences: portfolio public, conglomerate all-friends, watchlist specific.
    expect(
      (
        await putAudience(aliceAgent, 'portfolio', pid, {
          audience: 'public_link',
          acknowledgePublic: true,
        })
      ).status,
    ).toBe(200);
    await putAudience(aliceAgent, 'conglomerate', cid, { audience: 'all_friends' });
    await putAudience(aliceAgent, 'watchlist', wid, {
      audience: 'specific_friends',
      friendIds: [bobId],
    });

    // Enabling without the ack is rejected.
    const noAck = await aliceAgent
      .put('/api/v1/social/profile')
      .set(...XRW)
      .send({ isPublic: true });
    expect(noAck.status).toBe(400);

    // With the ack + a bio.
    const on = await aliceAgent
      .put('/api/v1/social/profile')
      .set(...XRW)
      .send({ isPublic: true, bio: 'Long-term investor.', acknowledgePublic: true });
    expect(on.status).toBe(200);
    expect(profileSettingsResponseSchema.safeParse(on.body).success).toBe(true);
    expect(on.body).toMatchObject({
      username: 'alice',
      isPublic: true,
      bio: 'Long-term investor.',
    });
    // Only the portfolio is public_link → publicItemCount is 1.
    expect(on.body.publicItemCount).toBe(1);

    // Logged-out read composes ONLY the public_link portfolio + bio.
    const pub = await request(harness.app).get('/api/v1/social/profiles/alice');
    expect(pub.status).toBe(200);
    expect(publicProfileResponseSchema.safeParse(pub.body).success).toBe(true);
    expect(pub.body.bio).toBe('Long-term investor.');
    expect(pub.body.portfolios).toHaveLength(1);
    expect(pub.body.portfolios[0].portfolioId).toBe(pid);
    expect(pub.body.portfolios[0].totalValueEur).toBeGreaterThan(0);

    // SWEEP: the all-friends conglomerate and specific-friends watchlist are NOT
    // public → they can never appear on the profile.
    expect(pub.body.conglomerates).toHaveLength(0);
    expect(pub.body.watchlists).toHaveLength(0);
  });

  it('the item drill-in obeys the same public_link gate across every kind', async () => {
    const { aliceAgent, pid, cid, wid, bobId } = await scenario();
    await putAudience(aliceAgent, 'portfolio', pid, {
      audience: 'public_link',
      acknowledgePublic: true,
    });
    await putAudience(aliceAgent, 'conglomerate', cid, { audience: 'all_friends' });
    await putAudience(aliceAgent, 'watchlist', wid, {
      audience: 'specific_friends',
      friendIds: [bobId],
    });
    await aliceAgent
      .put('/api/v1/social/profile')
      .set(...XRW)
      .send({ isPublic: true, acknowledgePublic: true });

    // Public portfolio → 200 with the read-only detail.
    const okItem = await request(harness.app).get(`/api/v1/social/profiles/alice/portfolio/${pid}`);
    expect(okItem.status).toBe(200);
    expect(okItem.body.kind).toBe('portfolio');

    // Non-public conglomerate + watchlist → 404 even though they are shared with friends.
    expect(
      (await request(harness.app).get(`/api/v1/social/profiles/alice/conglomerate/${cid}`)).status,
    ).toBe(404);
    expect(
      (await request(harness.app).get(`/api/v1/social/profiles/alice/watchlist/${wid}`)).status,
    ).toBe(404);
  });

  it("serves a public portfolio's chart series on the profile drill-in, and a non-public one's chart 404s (no chart-data leak)", async () => {
    const { aliceAgent, pid } = await scenario();
    await putAudience(aliceAgent, 'portfolio', pid, {
      audience: 'public_link',
      acknowledgePublic: true,
    });
    await aliceAgent
      .put('/api/v1/social/profile')
      .set(...XRW)
      .send({ isPublic: true, acknowledgePublic: true });

    // Public item → the value/performance chart series is present in the
    // read-only drill-in payload, served behind the same public_link gate as
    // the profile listing (no separate unauthenticated data path).
    const pub = await request(harness.app).get(`/api/v1/social/profiles/alice/portfolio/${pid}`);
    expect(pub.status).toBe(200);
    expect(pub.body.kind).toBe('portfolio');
    expect(pub.body.portfolio.history.range).toBe('MAX');
    expect(Array.isArray(pub.body.portfolio.history.points)).toBe(true);

    // Narrow the portfolio away from public_link → the whole drill-in payload
    // (its chart series included) 404s: a non-public portfolio's chart data is
    // never fetchable on the public route.
    await putAudience(aliceAgent, 'portfolio', pid, { audience: 'all_friends' });
    const narrowed = await request(harness.app).get(
      `/api/v1/social/profiles/alice/portfolio/${pid}`,
    );
    expect(narrowed.status).toBe(404);
    expect(narrowed.body).not.toHaveProperty('portfolio');
  });

  it('disabling the profile unpublishes the slug instantly (404)', async () => {
    const { aliceAgent, pid } = await scenario();
    await putAudience(aliceAgent, 'portfolio', pid, {
      audience: 'public_link',
      acknowledgePublic: true,
    });
    await aliceAgent
      .put('/api/v1/social/profile')
      .set(...XRW)
      .send({ isPublic: true, acknowledgePublic: true });
    expect((await request(harness.app).get('/api/v1/social/profiles/alice')).status).toBe(200);

    await aliceAgent
      .put('/api/v1/social/profile')
      .set(...XRW)
      .send({ isPublic: false });
    expect((await request(harness.app).get('/api/v1/social/profiles/alice')).status).toBe(404);
    // The item drill-in dies with it.
    expect(
      (await request(harness.app).get(`/api/v1/social/profiles/alice/portfolio/${pid}`)).status,
    ).toBe(404);
  });

  it('narrowing an item away from public_link drops it from the profile on the next read', async () => {
    const { aliceAgent, pid } = await scenario();
    await putAudience(aliceAgent, 'portfolio', pid, {
      audience: 'public_link',
      acknowledgePublic: true,
    });
    await aliceAgent
      .put('/api/v1/social/profile')
      .set(...XRW)
      .send({ isPublic: true, acknowledgePublic: true });
    expect(
      (await request(harness.app).get('/api/v1/social/profiles/alice')).body.portfolios,
    ).toHaveLength(1);

    // Narrow to all_friends → no longer public → gone from the profile immediately.
    await putAudience(aliceAgent, 'portfolio', pid, { audience: 'all_friends' });
    const pub = await request(harness.app).get('/api/v1/social/profiles/alice');
    expect(pub.body.portfolios).toHaveLength(0);
    expect(
      (await request(harness.app).get(`/api/v1/social/profiles/alice/portfolio/${pid}`)).status,
    ).toBe(404);
  });
});
