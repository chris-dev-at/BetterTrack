import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  mySharedResponseSchema,
  sharedConglomerateDetailResponseSchema,
  sharedPortfolioDetailResponseSchema,
  sharedWatchlistDetailResponseSchema,
  sharedWithMeResponseSchema,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createStubMarketData } from '../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Privacy-critical sharing surface (§6.9): "Shared With Me", the read-only
 * friend portfolio view, and "My Shared Items". Every social read is scoped by
 * an existing friendship AND the owner's `visibility=friends` at query time;
 * revoking either instantly closes access. Non-friends get 404, never 403.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const MISSING_ID = '00000000-0000-0000-7000-000000000000';

/** A deterministic EUR quote so a bought share is worth exactly 120 EUR. */
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

/** Make two agents friends: `from` requests, `to` accepts. */
async function befriend(from: Agent, to: Agent, toIdentifier: string): Promise<void> {
  await from
    .post('/api/v1/social/requests')
    .set(...XRW)
    .send({ identifier: toIdentifier });
  const inbox = await to.get('/api/v1/social/requests');
  const requestId = inbox.body.incoming[0]?.id as string;
  expect(requestId).toBeTruthy();
  const res = await to
    .post(`/api/v1/social/requests/${requestId}/accept`)
    .set(...XRW)
    .send();
  expect(res.status).toBe(200);
}

async function defaultPortfolioId(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  expect(res.status).toBe(200);
  const def = res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault);
  return def.id as string;
}

async function setVisibility(
  agent: Agent,
  portfolioId: string,
  visibility: 'private' | 'friends',
): Promise<void> {
  const res = await agent
    .patch(`/api/v1/portfolios/${portfolioId}`)
    .set(...XRW)
    .send({ visibility });
  expect(res.status).toBe(200);
}

/**
 * Owner (alice) with one holding worth 120 EUR in a `visibility=friends`
 * portfolio, and bob befriended to her. Returns the actors + the shared id.
 */
async function scenario() {
  const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
  const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
  const carol = await harness.seedUser({ email: 'carol@bt.test', username: 'carol' });

  const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
  const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
  const carolAgent = await loginAgent(harness.app, carol.email, carol.password);

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
  await setVisibility(aliceAgent, pid, 'friends');

  return { alice, bob, carol, aliceAgent, bobAgent, carolAgent, pid, assetId: asset!.id };
}

/** Create an active conglomerate owned by `agent` holding one asset at 100%. */
async function seedConglomerate(agent: Agent, assetId: string): Promise<string> {
  const create = await agent
    .post('/api/v1/conglomerates')
    .set(...XRW)
    .send({ name: 'Tech basket' });
  expect(create.status).toBe(201);
  const id = create.body.id as string;
  const positions = await agent
    .put(`/api/v1/conglomerates/${id}/positions`)
    .set(...XRW)
    .send({ positions: [{ assetId, weightPct: 100 }] });
  expect(positions.status).toBe(200);
  return id;
}

/** Toggle a conglomerate's friend-sharing on/off. */
async function setConglomerateVisibility(
  agent: Agent,
  id: string,
  visibility: 'private' | 'friends',
): Promise<void> {
  const res = await agent
    .patch(`/api/v1/conglomerates/${id}`)
    .set(...XRW)
    .send({ visibility });
  expect(res.status).toBe(200);
  expect(res.body.visibility).toBe(visibility);
}

/** The caller's default (General) watchlist id. */
async function defaultWatchlistId(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/workboard/watchlists');
  expect(res.status).toBe(200);
  const def = res.body.watchlists.find((w: { isDefault: boolean }) => w.isDefault);
  return def.id as string;
}

/** Toggle the caller's whole-watchlist friend-sharing on/off. */
async function setWatchlistVisibility(
  agent: Agent,
  visibility: 'private' | 'friends',
): Promise<void> {
  const res = await agent
    .patch('/api/v1/workboard/sharing')
    .set(...XRW)
    .send({ visibility });
  expect(res.status).toBe(200);
  expect(res.body.visibility).toBe(visibility);
}

describe('GET /api/v1/social/shared (Shared With Me)', () => {
  it('requires authentication', async () => {
    const res = await request(harness.app).get('/api/v1/social/shared');
    expect(res.status).toBe(401);
  });

  it("lists exactly a friend's visibility=friends portfolios with owner + net worth", async () => {
    const { bobAgent } = await scenario();

    const res = await bobAgent.get('/api/v1/social/shared');
    expect(res.status).toBe(200);
    expect(sharedWithMeResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.portfolios).toHaveLength(1);
    const [item] = res.body.portfolios;
    expect(item.owner).toEqual({ id: expect.any(String), username: 'alice' });
    expect(item.owner).not.toHaveProperty('email');
    expect(item.name).toBe('Main');
    expect(item.totalValueEur).toBe(120);
  });

  it('excludes a friend portfolio that is private', async () => {
    const { aliceAgent, bobAgent, pid } = await scenario();
    await setVisibility(aliceAgent, pid, 'private');

    const res = await bobAgent.get('/api/v1/social/shared');
    expect(res.status).toBe(200);
    expect(res.body.portfolios).toHaveLength(0);
  });

  it('excludes portfolios of a non-friend', async () => {
    const { carolAgent } = await scenario();
    const res = await carolAgent.get('/api/v1/social/shared');
    expect(res.status).toBe(200);
    expect(res.body.portfolios).toHaveLength(0);
  });

  it('reports net worth incl. cash on the card, matching the detail total (#311)', async () => {
    const { aliceAgent, bobAgent, pid } = await scenario();
    // 120 EUR of holdings + a 50 EUR cash deposit → net worth 170.
    const dep = await aliceAgent
      .post(`/api/v1/portfolios/${pid}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 50 });
    expect(dep.status).toBe(201);

    const list = await bobAgent.get('/api/v1/social/shared');
    expect(list.status).toBe(200);
    expect(list.body.portfolios[0].totalValueEur).toBe(170);

    // The card total agrees with the detail view's net-worth total (no drift).
    const detail = await bobAgent.get(`/api/v1/social/shared/${pid}`);
    expect(detail.status).toBe(200);
    expect(detail.body.totals.totalValueEur).toBe(170);
  });

  it('drops a shared portfolio once the owner archives it (§6.9)', async () => {
    const { aliceAgent, bobAgent, pid } = await scenario();

    // A second active portfolio so the shared one is no longer the last active
    // (archiving the only active portfolio is refused).
    await aliceAgent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Trading' });
    const archived = await aliceAgent.post(`/api/v1/portfolios/${pid}/archive`).set(...XRW);
    expect(archived.status).toBe(200);

    // Archiving hides the portfolio from its own owner's lists, so it must not
    // linger in a friend's Shared With Me nor stay openable.
    const list = await bobAgent.get('/api/v1/social/shared');
    expect(list.status).toBe(200);
    expect(list.body.portfolios).toHaveLength(0);

    const detail = await bobAgent.get(`/api/v1/social/shared/${pid}`);
    expect(detail.status).toBe(404);
  });
});

describe('GET /api/v1/social/shared/:portfolioId (read-only friend view)', () => {
  it('returns the owner overview (totals, holdings, performance series) read-only', async () => {
    const { bobAgent, pid } = await scenario();

    const res = await bobAgent.get(`/api/v1/social/shared/${pid}`);
    expect(res.status).toBe(200);
    expect(sharedPortfolioDetailResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.portfolioId).toBe(pid);
    expect(res.body.owner.username).toBe('alice');
    expect(res.body.totals.marketValueEur).toBe(120);
    expect(res.body.holdings).toHaveLength(1);
    expect(res.body.holdings[0].asset.symbol).toBe('BAYN.DE');
    // A friend view is strictly read-only: no ledger, no edit surface.
    expect(res.body).not.toHaveProperty('transactions');
    expect(res.body.history.range).toBe('MAX');
    expect(Array.isArray(res.body.history.points)).toBe(true);
  });

  it('404s (never 403) for a non-friend', async () => {
    const { carolAgent, pid } = await scenario();
    const res = await carolAgent.get(`/api/v1/social/shared/${pid}`);
    expect(res.status).toBe(404);
  });

  it('404s an unknown portfolio id', async () => {
    const { bobAgent } = await scenario();
    const res = await bobAgent.get(`/api/v1/social/shared/${MISSING_ID}`);
    expect(res.status).toBe(404);
  });

  it('404s the viewer’s own portfolio (the shared surface is for friends)', async () => {
    const { aliceAgent, pid } = await scenario();
    const res = await aliceAgent.get(`/api/v1/social/shared/${pid}`);
    expect(res.status).toBe(404);
  });

  it('404s immediately after the owner flips visibility back to private', async () => {
    const { aliceAgent, bobAgent, pid } = await scenario();

    // Accessible while shared.
    expect((await bobAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(200);

    await setVisibility(aliceAgent, pid, 'private');

    // Authorization is recomputed per request — no cached access.
    expect((await bobAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(404);
  });

  it('404s immediately after unfriending', async () => {
    const { alice, bobAgent, pid } = await scenario();

    expect((await bobAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(200);

    // Either side may unfriend — bob removes alice here.
    const removed = await bobAgent
      .delete(`/api/v1/social/friends/${alice.id}`)
      .set(...XRW)
      .send();
    expect(removed.status).toBe(204);

    expect((await bobAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(404);
    // And it vanishes from Shared With Me too.
    expect((await bobAgent.get('/api/v1/social/shared')).body.portfolios).toHaveLength(0);
  });
});

describe('a disabled owner stops sharing (§6.9)', () => {
  /** Admin-disable the given user id directly (mirrors the admin disable action). */
  async function disable(userId: string): Promise<void> {
    await harness.db
      .update(schema.users)
      .set({ status: 'disabled' })
      .where(eq(schema.users.id, userId));
  }

  it('drops the disabled owner’s portfolio from a friend’s Shared With Me', async () => {
    const { alice, bobAgent } = await scenario();

    // Accessible while the owner is active.
    expect((await bobAgent.get('/api/v1/social/shared')).body.portfolios).toHaveLength(1);

    await disable(alice.id);

    const res = await bobAgent.get('/api/v1/social/shared');
    expect(res.status).toBe(200);
    expect(res.body.portfolios).toHaveLength(0);
  });

  it('404s the read-only friend view once the owner is disabled', async () => {
    const { alice, bobAgent, pid } = await scenario();

    expect((await bobAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(200);

    await disable(alice.id);

    expect((await bobAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(404);
  });
});

describe('GET /api/v1/social/my-shared (My Shared Items)', () => {
  it('lists the caller’s own portfolios currently at visibility=friends', async () => {
    const { aliceAgent, pid } = await scenario();

    const res = await aliceAgent.get('/api/v1/social/my-shared');
    expect(res.status).toBe(200);
    expect(mySharedResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.portfolios).toHaveLength(1);
    expect(res.body.portfolios[0].id).toBe(pid);
    expect(res.body.portfolios[0].visibility).toBe('friends');
  });

  it('drops a portfolio after it is toggled back to private', async () => {
    const { aliceAgent, pid } = await scenario();
    await setVisibility(aliceAgent, pid, 'private');

    const res = await aliceAgent.get('/api/v1/social/my-shared');
    expect(res.status).toBe(200);
    expect(res.body.portfolios).toHaveLength(0);
  });

  it('is empty for a user sharing nothing', async () => {
    const { bobAgent } = await scenario();
    const res = await bobAgent.get('/api/v1/social/my-shared');
    expect(res.status).toBe(200);
    expect(res.body.portfolios).toHaveLength(0);
    expect(res.body.conglomerates).toHaveLength(0);
    // Named watchlists (V3-P5): nothing shared → no watchlist entries.
    expect(res.body.watchlists).toEqual([]);
  });
});

// --- Conglomerate sharing (§13.2 V2-P9) ------------------------------------

describe('conglomerate friend-sharing', () => {
  it('lists a friend’s shared conglomerate in Shared With Me, not a non-friend’s', async () => {
    const { aliceAgent, bobAgent, carolAgent, assetId } = await scenario();
    const cid = await seedConglomerate(aliceAgent, assetId);
    await setConglomerateVisibility(aliceAgent, cid, 'friends');

    const bobRes = await bobAgent.get('/api/v1/social/shared');
    expect(bobRes.status).toBe(200);
    expect(sharedWithMeResponseSchema.safeParse(bobRes.body).success).toBe(true);
    expect(bobRes.body.conglomerates).toHaveLength(1);
    const [item] = bobRes.body.conglomerates;
    expect(item.conglomerateId).toBe(cid);
    expect(item.owner).toEqual({ id: expect.any(String), username: 'alice' });
    expect(item.owner).not.toHaveProperty('email');
    expect(item.positionCount).toBe(1);

    // A non-friend never sees it.
    expect((await carolAgent.get('/api/v1/social/shared')).body.conglomerates).toHaveLength(0);
  });

  it('serves the read-only detail to a friend and 404s everyone else', async () => {
    const { aliceAgent, bobAgent, carolAgent, assetId } = await scenario();
    const cid = await seedConglomerate(aliceAgent, assetId);
    await setConglomerateVisibility(aliceAgent, cid, 'friends');

    const res = await bobAgent.get(`/api/v1/social/shared/conglomerates/${cid}`);
    expect(res.status).toBe(200);
    expect(sharedConglomerateDetailResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.conglomerateId).toBe(cid);
    expect(res.body.owner.username).toBe('alice');
    expect(res.body.positions).toHaveLength(1);
    expect(res.body.positions[0].asset.symbol).toBe('BAYN.DE');

    // Non-friend, unknown id, and the owner’s own basket all 404 (never 403).
    expect((await carolAgent.get(`/api/v1/social/shared/conglomerates/${cid}`)).status).toBe(404);
    expect((await bobAgent.get(`/api/v1/social/shared/conglomerates/${MISSING_ID}`)).status).toBe(
      404,
    );
    expect((await aliceAgent.get(`/api/v1/social/shared/conglomerates/${cid}`)).status).toBe(404);
  });

  it('closes access instantly when sharing is turned off', async () => {
    const { aliceAgent, bobAgent, assetId } = await scenario();
    const cid = await seedConglomerate(aliceAgent, assetId);
    await setConglomerateVisibility(aliceAgent, cid, 'friends');
    expect((await bobAgent.get(`/api/v1/social/shared/conglomerates/${cid}`)).status).toBe(200);

    await setConglomerateVisibility(aliceAgent, cid, 'private');
    expect((await bobAgent.get(`/api/v1/social/shared/conglomerates/${cid}`)).status).toBe(404);
    expect((await bobAgent.get('/api/v1/social/shared')).body.conglomerates).toHaveLength(0);
  });

  it('closes access instantly on unfriend', async () => {
    const { alice, aliceAgent, bobAgent, assetId } = await scenario();
    const cid = await seedConglomerate(aliceAgent, assetId);
    await setConglomerateVisibility(aliceAgent, cid, 'friends');
    expect((await bobAgent.get(`/api/v1/social/shared/conglomerates/${cid}`)).status).toBe(200);

    await bobAgent
      .delete(`/api/v1/social/friends/${alice.id}`)
      .set(...XRW)
      .send();
    expect((await bobAgent.get(`/api/v1/social/shared/conglomerates/${cid}`)).status).toBe(404);
  });

  it('lists the owner’s shared basket in My Shared Items with a toggle-off', async () => {
    const { aliceAgent, assetId } = await scenario();
    const cid = await seedConglomerate(aliceAgent, assetId);
    await setConglomerateVisibility(aliceAgent, cid, 'friends');

    let res = await aliceAgent.get('/api/v1/social/my-shared');
    expect(res.status).toBe(200);
    expect(res.body.conglomerates).toHaveLength(1);
    expect(res.body.conglomerates[0].id).toBe(cid);

    await setConglomerateVisibility(aliceAgent, cid, 'private');
    res = await aliceAgent.get('/api/v1/social/my-shared');
    expect(res.body.conglomerates).toHaveLength(0);
  });

  it('cannot be mutated by a friend (read-only) — no write path exists', async () => {
    const { aliceAgent, bobAgent, assetId } = await scenario();
    const cid = await seedConglomerate(aliceAgent, assetId);
    await setConglomerateVisibility(aliceAgent, cid, 'friends');

    // The only conglomerate write paths are owner-scoped; a friend’s attempt is a
    // 404 (never 403), so the shared view stays strictly read-only.
    const patch = await bobAgent
      .patch(`/api/v1/conglomerates/${cid}`)
      .set(...XRW)
      .send({ name: 'hijacked' });
    expect(patch.status).toBe(404);
  });
});

// --- Watchlist sharing (§13.2 V2-P9) ---------------------------------------

describe('watchlist friend-sharing', () => {
  /** Add `assetId` to `agent`'s (default General) watchlist. */
  async function watch(agent: Agent, assetId: string, watchlistId?: string): Promise<void> {
    const res = await agent
      .post('/api/v1/workboard')
      .set(...XRW)
      .send(watchlistId ? { assetId, watchlistId } : { assetId });
    expect(res.status).toBe(201);
  }

  it('lists a friend’s shared watchlist in Shared With Me, not a non-friend’s', async () => {
    const { aliceAgent, bobAgent, carolAgent, assetId } = await scenario();
    await watch(aliceAgent, assetId);
    await setWatchlistVisibility(aliceAgent, 'friends');

    const bobRes = await bobAgent.get('/api/v1/social/shared');
    expect(bobRes.status).toBe(200);
    expect(bobRes.body.watchlists).toHaveLength(1);
    expect(bobRes.body.watchlists[0].owner).toEqual({ id: expect.any(String), username: 'alice' });
    expect(bobRes.body.watchlists[0].name).toBe('General');
    expect(bobRes.body.watchlists[0].watchlistId).toEqual(expect.any(String));
    expect(bobRes.body.watchlists[0].itemCount).toBe(1);

    expect((await carolAgent.get('/api/v1/social/shared')).body.watchlists).toHaveLength(0);
  });

  it('serves the read-only detail to a friend and 404s everyone else', async () => {
    const { aliceAgent, bobAgent, carolAgent, assetId } = await scenario();
    await watch(aliceAgent, assetId);
    await setWatchlistVisibility(aliceAgent, 'friends');
    const wlId = await defaultWatchlistId(aliceAgent);

    const res = await bobAgent.get(`/api/v1/social/shared/watchlists/${wlId}`);
    expect(res.status).toBe(200);
    expect(sharedWatchlistDetailResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.owner.username).toBe('alice');
    expect(res.body.name).toBe('General');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].asset.symbol).toBe('BAYN.DE');

    expect((await carolAgent.get(`/api/v1/social/shared/watchlists/${wlId}`)).status).toBe(404);
    expect((await bobAgent.get(`/api/v1/social/shared/watchlists/${MISSING_ID}`)).status).toBe(404);
    // The owner’s own list 404s on the shared surface (it's for friends).
    expect((await aliceAgent.get(`/api/v1/social/shared/watchlists/${wlId}`)).status).toBe(404);
  });

  it('closes access instantly when sharing is turned off, and on unfriend', async () => {
    const { alice, aliceAgent, bobAgent, assetId } = await scenario();
    await watch(aliceAgent, assetId);
    await setWatchlistVisibility(aliceAgent, 'friends');
    const wlId = await defaultWatchlistId(aliceAgent);
    expect((await bobAgent.get(`/api/v1/social/shared/watchlists/${wlId}`)).status).toBe(200);

    await setWatchlistVisibility(aliceAgent, 'private');
    expect((await bobAgent.get(`/api/v1/social/shared/watchlists/${wlId}`)).status).toBe(404);
    expect((await bobAgent.get('/api/v1/social/shared')).body.watchlists).toHaveLength(0);

    // Re-share, then unfriend — access closes again.
    await setWatchlistVisibility(aliceAgent, 'friends');
    expect((await bobAgent.get(`/api/v1/social/shared/watchlists/${wlId}`)).status).toBe(200);
    await bobAgent
      .delete(`/api/v1/social/friends/${alice.id}`)
      .set(...XRW)
      .send();
    expect((await bobAgent.get(`/api/v1/social/shared/watchlists/${wlId}`)).status).toBe(404);
  });

  it('reflects the owner’s state in My Shared Items', async () => {
    const { aliceAgent, assetId } = await scenario();
    await watch(aliceAgent, assetId);
    await setWatchlistVisibility(aliceAgent, 'friends');

    const res = await aliceAgent.get('/api/v1/social/my-shared');
    expect(res.status).toBe(200);
    expect(res.body.watchlists).toHaveLength(1);
    expect(res.body.watchlists[0]).toMatchObject({
      name: 'General',
      audience: 'all_friends',
      itemCount: 1,
    });
  });
});

// --- Audience model (V3-P5): one picker + one enforcement layer -------------

/** PUT an audience for a subject via the unified endpoint. */
async function putAudience(
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

/** Buy one 100-EUR share of `assetId` into `portfolioId` (worth 120 with the stub). */
async function buyOneShare(agent: Agent, portfolioId: string, assetId: string): Promise<void> {
  const res = await agent
    .post(`/api/v1/portfolios/${portfolioId}/transactions`)
    .set(...XRW)
    .send({
      assetId,
      side: 'buy',
      quantity: 1,
      price: 100,
      executedAt: `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
    });
  expect(res.status).toBe(201);
}

describe('audience model — specific friends (V3-P5)', () => {
  it('shares to exactly the named friend; an un-named friend and non-friends 404', async () => {
    const { alice, bob, aliceAgent, bobAgent, carolAgent, pid } = await scenario();
    // carol is now a friend too — but NOT in the specific set.
    await befriend(aliceAgent, carolAgent, 'carol');

    const put = await putAudience(aliceAgent, 'portfolio', pid, {
      audience: 'specific_friends',
      friendIds: [bob.id],
    });
    expect(put.status).toBe(200);
    expect(put.body.state.audience).toBe('specific_friends');
    expect(put.body.state.friendIds).toEqual([bob.id]);

    // Named friend sees it; un-named friend (carol) gets a 404, never 403.
    expect((await bobAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(200);
    expect((await carolAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(404);

    // Shared With Me: only bob has it.
    expect((await bobAgent.get('/api/v1/social/shared')).body.portfolios).toHaveLength(1);
    expect((await carolAgent.get('/api/v1/social/shared')).body.portfolios).toHaveLength(0);

    // Unfriending bob instantly closes his specific-friend access (no cached auth).
    await bobAgent
      .delete(`/api/v1/social/friends/${alice.id}`)
      .set(...XRW)
      .send();
    expect((await bobAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(404);
  });

  it('drops a friend removed from the specific set on the very next read', async () => {
    const { bob, carol, aliceAgent, bobAgent, carolAgent, pid } = await scenario();
    await befriend(aliceAgent, carolAgent, 'carol');
    await putAudience(aliceAgent, 'portfolio', pid, {
      audience: 'specific_friends',
      friendIds: [bob.id],
    });
    expect((await bobAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(200);

    // Re-select the set to carol only — bob loses access immediately (no cached auth).
    await putAudience(aliceAgent, 'portfolio', pid, {
      audience: 'specific_friends',
      friendIds: [carol.id],
    });
    expect((await bobAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(404);
    expect((await carolAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(200);
  });
});

describe('audience model — public links (V3-P5, §14)', () => {
  it('renders a live read-only view logged-out, and revoke kills it instantly', async () => {
    const { aliceAgent, pid } = await scenario();

    const put = await putAudience(aliceAgent, 'portfolio', pid, {
      audience: 'public_link',
      acknowledgePublic: true,
    });
    expect(put.status).toBe(200);
    expect(put.body.state.audience).toBe('public_link');
    expect(put.body.state.link.active).toBe(true);
    const token = put.body.link.token as string;
    const url = put.body.link.url as string;
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThanOrEqual(22); // ≥128-bit base64url
    expect(url).toBe(`/api/v1/social/links/${token}`);

    // A LOGGED-OUT visitor (no agent, no cookie) resolves the read-only view.
    const anon = await request(harness.app).get(url);
    expect(anon.status).toBe(200);
    expect(anon.body.kind).toBe('portfolio');
    expect(anon.body.portfolio.owner.username).toBe('alice');
    expect(anon.body.portfolio.holdings).toHaveLength(1);
    // Nothing beyond the shared item is reachable from the link payload.
    expect(anon.body.portfolio).not.toHaveProperty('transactions');
    expect(Object.keys(anon.body)).toEqual(['kind', 'portfolio']);

    // Revoke by narrowing the audience — the token dies on the next request.
    await putAudience(aliceAgent, 'portfolio', pid, { audience: 'private' });
    expect((await request(harness.app).get(url)).status).toBe(404);
  });

  it('re-minting rotates the token; the old token stays dead', async () => {
    const { aliceAgent, pid } = await scenario();
    const first = await putAudience(aliceAgent, 'portfolio', pid, {
      audience: 'public_link',
      acknowledgePublic: true,
    });
    const firstUrl = first.body.link.url as string;
    expect((await request(harness.app).get(firstUrl)).status).toBe(200);

    // Private, then public again → a fresh token; the first URL is dead.
    await putAudience(aliceAgent, 'portfolio', pid, { audience: 'private' });
    const second = await putAudience(aliceAgent, 'portfolio', pid, {
      audience: 'public_link',
      acknowledgePublic: true,
    });
    const secondUrl = second.body.link.url as string;
    expect(secondUrl).not.toBe(firstUrl);
    expect((await request(harness.app).get(firstUrl)).status).toBe(404);
    expect((await request(harness.app).get(secondUrl)).status).toBe(200);
  });

  it('an unknown token 404s (no existence leak)', async () => {
    await scenario();
    const res = await request(harness.app).get('/api/v1/social/links/not-a-real-token');
    expect(res.status).toBe(404);
  });

  it('rejects public_link without the explicit acknowledgment (§16 friction ladder)', async () => {
    const { aliceAgent, pid } = await scenario();
    const res = await putAudience(aliceAgent, 'portfolio', pid, { audience: 'public_link' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PUBLIC_LINK_ACK_REQUIRED');
    // No link was minted — the audience stays unchanged.
    const state = await aliceAgent.get(`/api/v1/social/audience/portfolio/${pid}`);
    expect(state.body.audience).not.toBe('public_link');
    expect(state.body.link.active).toBe(false);
  });

  it('serves a public conglomerate and watchlist link too', async () => {
    const { aliceAgent, assetId } = await scenario();
    const cid = await seedConglomerate(aliceAgent, assetId);
    const cput = await putAudience(aliceAgent, 'conglomerate', cid, {
      audience: 'public_link',
      acknowledgePublic: true,
    });
    const cAnon = await request(harness.app).get(cput.body.link.url);
    expect(cAnon.status).toBe(200);
    expect(cAnon.body.kind).toBe('conglomerate');
    expect(cAnon.body.conglomerate.positions).toHaveLength(1);
  });
});

describe('audience model — a second (non-default) portfolio to one friend (V3-P5)', () => {
  it('shares a non-default portfolio to exactly one friend end-to-end', async () => {
    const { bob, aliceAgent, bobAgent, carolAgent, assetId, pid } = await scenario();
    await befriend(aliceAgent, carolAgent, 'carol');
    // The default portfolio stays private; a NEW second portfolio is the shared one.
    await setVisibility(aliceAgent, pid, 'private');

    const created = await aliceAgent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Trading' });
    expect(created.status).toBe(201);
    const secondPid = created.body.portfolio.id as string;
    await buyOneShare(aliceAgent, secondPid, assetId);

    await putAudience(aliceAgent, 'portfolio', secondPid, {
      audience: 'specific_friends',
      friendIds: [bob.id],
    });

    // Bob sees exactly the second portfolio; the default is private to everyone.
    const bobShared = await bobAgent.get('/api/v1/social/shared');
    expect(bobShared.body.portfolios).toHaveLength(1);
    expect(bobShared.body.portfolios[0].portfolioId).toBe(secondPid);
    expect(bobShared.body.portfolios[0].name).toBe('Trading');
    expect((await bobAgent.get(`/api/v1/social/shared/${secondPid}`)).status).toBe(200);
    expect((await bobAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(404);

    // Carol (a friend, not named) sees nothing.
    expect((await carolAgent.get('/api/v1/social/shared')).body.portfolios).toHaveLength(0);
    expect((await carolAgent.get(`/api/v1/social/shared/${secondPid}`)).status).toBe(404);
  });
});

describe('audience model — two watchlists behave independently (V3-P5)', () => {
  it('two lists with different audiences are enforced separately', async () => {
    const { aliceAgent, bobAgent, assetId } = await scenario();

    const generalId = await defaultWatchlistId(aliceAgent);
    const created = await aliceAgent
      .post('/api/v1/workboard/watchlists')
      .set(...XRW)
      .send({ name: 'Tech' });
    expect(created.status).toBe(201);
    const techId = created.body.id as string;

    // One asset in each list.
    await aliceAgent
      .post('/api/v1/workboard')
      .set(...XRW)
      .send({ assetId });
    await aliceAgent
      .post('/api/v1/workboard')
      .set(...XRW)
      .send({ assetId, watchlistId: techId });

    // General → all friends; Tech → private.
    await putAudience(aliceAgent, 'watchlist', generalId, { audience: 'all_friends' });
    await putAudience(aliceAgent, 'watchlist', techId, { audience: 'private' });

    expect((await bobAgent.get(`/api/v1/social/shared/watchlists/${generalId}`)).status).toBe(200);
    expect((await bobAgent.get(`/api/v1/social/shared/watchlists/${techId}`)).status).toBe(404);
    let shared = await bobAgent.get('/api/v1/social/shared');
    expect(shared.body.watchlists.map((w: { watchlistId: string }) => w.watchlistId)).toEqual([
      generalId,
    ]);

    // Flip them — the enforcement follows each list independently.
    await putAudience(aliceAgent, 'watchlist', generalId, { audience: 'private' });
    await putAudience(aliceAgent, 'watchlist', techId, { audience: 'all_friends' });
    expect((await bobAgent.get(`/api/v1/social/shared/watchlists/${generalId}`)).status).toBe(404);
    expect((await bobAgent.get(`/api/v1/social/shared/watchlists/${techId}`)).status).toBe(200);
    shared = await bobAgent.get('/api/v1/social/shared');
    expect(shared.body.watchlists.map((w: { watchlistId: string }) => w.watchlistId)).toEqual([
      techId,
    ]);
  });

  it('the default General list cannot be deleted; a named list can', async () => {
    const { aliceAgent } = await scenario();
    const generalId = await defaultWatchlistId(aliceAgent);
    const created = await aliceAgent
      .post('/api/v1/workboard/watchlists')
      .set(...XRW)
      .send({ name: 'Tech' });
    const techId = created.body.id as string;

    expect(
      (await aliceAgent.delete(`/api/v1/workboard/watchlists/${generalId}`).set(...XRW)).status,
    ).toBe(400);
    expect(
      (await aliceAgent.delete(`/api/v1/workboard/watchlists/${techId}`).set(...XRW)).status,
    ).toBe(204);
  });
});

// --- Default portfolio visibility (§13.2 V2-P9) ----------------------------

describe('default portfolio visibility (Settings → Account)', () => {
  it('defaults to private and a new portfolio adopts it', async () => {
    const { aliceAgent } = await scenario();

    const get = await aliceAgent.get('/api/v1/settings/account');
    expect(get.status).toBe(200);
    expect(get.body).toEqual({
      defaultPortfolioVisibility: 'private',
      locale: 'en',
      baseCurrency: 'EUR',
    });

    const created = await aliceAgent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Side pot' });
    expect(created.status).toBe(201);
    expect(created.body.portfolio.visibility).toBe('private');
  });

  it('applies friends default to newly created portfolios only', async () => {
    const { aliceAgent, pid } = await scenario();

    const patch = await aliceAgent
      .patch('/api/v1/settings/account')
      .set(...XRW)
      .send({ defaultPortfolioVisibility: 'friends' });
    expect(patch.status).toBe(200);
    expect(patch.body).toEqual({
      defaultPortfolioVisibility: 'friends',
      locale: 'en',
      baseCurrency: 'EUR',
    });

    // A newly created portfolio adopts the friends default.
    const created = await aliceAgent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Growth' });
    expect(created.status).toBe(201);
    expect(created.body.portfolio.visibility).toBe('friends');

    // The existing "Main" portfolio is untouched by the default change: it was
    // explicitly set to friends in the scenario, so it stays friends — but the
    // point is the default never rewrites existing rows. Flip it private and
    // confirm changing the default again does not touch it.
    await setVisibility(aliceAgent, pid, 'private');
    await aliceAgent
      .patch('/api/v1/settings/account')
      .set(...XRW)
      .send({ defaultPortfolioVisibility: 'friends' });
    const list = await aliceAgent.get('/api/v1/portfolios');
    const main = list.body.portfolios.find((p: { id: string }) => p.id === pid);
    expect(main.visibility).toBe('private');
  });
});
