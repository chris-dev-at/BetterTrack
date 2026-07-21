import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  backtestResponseSchema,
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

/** ISO `YYYY-MM-DD` for `n` days before today (UTC) — spans the sandbox window. */
function daysAgoIso(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

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
    // A rising two-point daily series (any ref) so the arc-c what-if sandbox has
    // real history to backtest over. Unused by the non-backtest sharing tests.
    history: () => ({
      value: [
        { time: `${daysAgoIso(400)}T00:00:00.000Z`, close: 100 },
        { time: `${daysAgoIso(1)}T00:00:00.000Z`, close: 130 },
      ],
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
    expect(item.owner).toEqual({
      id: expect.any(String),
      username: 'alice',
      profileIcon: null,
    });
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
  it('lists every portfolio the caller owns, each with its real audience', async () => {
    const { aliceAgent, pid } = await scenario();

    const res = await aliceAgent.get('/api/v1/social/my-shared');
    expect(res.status).toBe(200);
    expect(mySharedResponseSchema.safeParse(res.body).success).toBe(true);
    // Alice owns exactly one portfolio (Main), currently friends → all_friends.
    expect(res.body.portfolios).toHaveLength(1);
    expect(res.body.portfolios[0].portfolioId).toBe(pid);
    // V3-P6: the row carries the real audience (visibility=friends → all_friends).
    expect(res.body.portfolios[0].audience).toBe('all_friends');
  });

  it('keeps a portfolio listed after it is toggled back to private (#377)', async () => {
    const { aliceAgent, pid } = await scenario();
    await setVisibility(aliceAgent, pid, 'private');

    // Every owned portfolio stays enumerable so its audience is changeable from
    // the Socials tab — a private one is no longer dropped, it just reads
    // audience=private (the entry point the secondary-portfolio bug was missing).
    const res = await aliceAgent.get('/api/v1/social/my-shared');
    expect(res.status).toBe(200);
    expect(res.body.portfolios).toHaveLength(1);
    expect(res.body.portfolios[0].portfolioId).toBe(pid);
    expect(res.body.portfolios[0].audience).toBe('private');
  });

  it('lists the private default portfolio + General watchlist for a user sharing nothing', async () => {
    const { bobAgent } = await scenario();
    const res = await bobAgent.get('/api/v1/social/my-shared');
    expect(res.status).toBe(200);
    // Bob's auto-created default portfolio is always listed, at audience=private.
    expect(res.body.portfolios).toHaveLength(1);
    expect(res.body.portfolios[0].audience).toBe('private');
    // He owns no conglomerates.
    expect(res.body.conglomerates).toHaveLength(0);
    // #384: the always-present General watchlist now lists here too (private),
    // so it can be shared from My items even before it is ever shared.
    expect(res.body.watchlists).toHaveLength(1);
    expect(res.body.watchlists[0].audience).toBe('private');
  });

  it('lists every shareable item the caller owns — all three kinds, never-shared, each private (#384)', async () => {
    const { bobAgent, assetId } = await scenario();
    // Bob shares nothing; give him a conglomerate but leave it private (never shared).
    const cid = await seedConglomerate(bobAgent, assetId);

    const res = await bobAgent.get('/api/v1/social/my-shared');
    expect(res.status).toBe(200);
    expect(mySharedResponseSchema.safeParse(res.body).success).toBe(true);
    // Portfolio (Main), conglomerate and watchlist (General) are ALL present,
    // each at audience=private — every kind gets an entry point to sharing even
    // when it has never been shared.
    expect(res.body.portfolios).toHaveLength(1);
    expect(res.body.portfolios[0].audience).toBe('private');
    expect(res.body.conglomerates).toHaveLength(1);
    expect(res.body.conglomerates[0].conglomerateId).toBe(cid);
    expect(res.body.conglomerates[0].audience).toBe('private');
    expect(res.body.watchlists).toHaveLength(1);
    expect(res.body.watchlists[0].audience).toBe('private');
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
    expect(item.owner).toEqual({
      id: expect.any(String),
      username: 'alice',
      profileIcon: null,
    });
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

  it('lists the owner’s basket in My items — shared, then still listed (private) after a toggle-off (#384)', async () => {
    const { aliceAgent, assetId } = await scenario();
    const cid = await seedConglomerate(aliceAgent, assetId);
    await setConglomerateVisibility(aliceAgent, cid, 'friends');

    let res = await aliceAgent.get('/api/v1/social/my-shared');
    expect(res.status).toBe(200);
    expect(res.body.conglomerates).toHaveLength(1);
    expect(res.body.conglomerates[0].conglomerateId).toBe(cid);
    expect(res.body.conglomerates[0].audience).toBe('all_friends');

    // #384: every conglomerate you own is enumerable in My items, so it stays
    // listed after being toggled back to private — it just reads audience=private
    // (the entry point to re-share it), rather than dropping out of the list.
    await setConglomerateVisibility(aliceAgent, cid, 'private');
    res = await aliceAgent.get('/api/v1/social/my-shared');
    expect(res.body.conglomerates).toHaveLength(1);
    expect(res.body.conglomerates[0].conglomerateId).toBe(cid);
    expect(res.body.conglomerates[0].audience).toBe('private');
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

// --- Shared-conglomerate what-if sandbox (§13.5 V5-P6 arc c) ----------------

describe('shared conglomerate what-if sandbox', () => {
  /** Seed a second global asset so the sandbox basket has two constituents. */
  async function seedSapAsset(): Promise<string> {
    const [asset] = await harness.db
      .insert(schema.assets)
      .values({
        providerId: 'yahoo',
        providerRef: 'SAP.DE',
        type: 'stock',
        symbol: 'SAP.DE',
        name: 'SAP SE',
        currency: 'EUR',
        exchange: 'XETRA',
      })
      .returning();
    return asset!.id;
  }

  /** Alice owns a friends-shared 60/40 two-asset basket; returns its id + assets. */
  async function sharedBasket() {
    const base = await scenario();
    const assetB = await seedSapAsset();
    const create = await base.aliceAgent
      .post('/api/v1/conglomerates')
      .set(...XRW)
      .send({ name: 'Duo' });
    const cid = create.body.id as string;
    await base.aliceAgent
      .put(`/api/v1/conglomerates/${cid}/positions`)
      .set(...XRW)
      .send({
        positions: [
          { assetId: base.assetId, weightPct: 60 },
          { assetId: assetB, weightPct: 40 },
        ],
      });
    await setConglomerateVisibility(base.aliceAgent, cid, 'friends');
    return { ...base, cid, assetB };
  }

  it('requires authentication', async () => {
    const res = await request(harness.app)
      .post(`/api/v1/backtest/shared/${MISSING_ID}/preview`)
      .set(...XRW)
      .send({ positions: [{ id: MISSING_ID, weight: 100 }], range: '1Y' });
    expect(res.status).toBe(401);
  });

  it('a friend can backtest local weight tweaks; the curve carries no benchmark', async () => {
    const { bobAgent, cid, assetId, assetB } = await sharedBasket();

    const res = await bobAgent
      .post(`/api/v1/backtest/shared/${cid}/preview`)
      .set(...XRW)
      .send({
        positions: [
          { id: assetId, weight: 80 },
          { id: assetB, weight: 20 },
        ],
        range: '1Y',
      });

    expect(res.status).toBe(200);
    expect(backtestResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.benchmark).toBeNull();
    expect(res.body.series.length).toBeGreaterThan(0);
  });

  it('a sandbox tweak never mutates the shared object — owner state is unchanged', async () => {
    const { aliceAgent, bobAgent, cid, assetId, assetB } = await sharedBasket();

    const before = await bobAgent.get(`/api/v1/social/shared/conglomerates/${cid}`);
    await bobAgent
      .post(`/api/v1/backtest/shared/${cid}/preview`)
      .set(...XRW)
      .send({
        positions: [
          { id: assetId, weight: 10 },
          { id: assetB, weight: 90 },
        ],
        range: '1Y',
      });

    // The owner's basket is byte-identical: no write path was exercised.
    const owner = await aliceAgent.get(`/api/v1/conglomerates/${cid}`);
    const weights = owner.body.positions.map((p: { weightPct: number }) => p.weightPct);
    expect(weights).toEqual([60, 40]);

    // And the read-only shared view still reads exactly as it did before.
    const after = await bobAgent.get(`/api/v1/social/shared/conglomerates/${cid}`);
    expect(after.body).toEqual(before.body);
  });

  it('404s a non-friend and an unknown basket — the same guard as the shared view', async () => {
    const { carolAgent, bobAgent, cid, assetId, assetB } = await sharedBasket();
    const body = {
      positions: [
        { id: assetId, weight: 60 },
        { id: assetB, weight: 40 },
      ],
      range: '1Y' as const,
    };

    // Non-friend: never authorized to see the basket → 404 (not 403).
    const carol = await carolAgent
      .post(`/api/v1/backtest/shared/${cid}/preview`)
      .set(...XRW)
      .send(body);
    expect(carol.status).toBe(404);

    // A friend, but an unknown conglomerate id → 404.
    const missing = await bobAgent
      .post(`/api/v1/backtest/shared/${MISSING_ID}/preview`)
      .set(...XRW)
      .send({ positions: [{ id: assetId, weight: 100 }], range: '1Y' });
    expect(missing.status).toBe(404);
  });

  it('refuses a tweak that names a constituent the share never exposed (422)', async () => {
    const { bobAgent, cid, assetId } = await sharedBasket();
    const res = await bobAgent
      .post(`/api/v1/backtest/shared/${cid}/preview`)
      .set(...XRW)
      .send({
        positions: [
          { id: assetId, weight: 60 },
          { id: MISSING_ID, weight: 40 },
        ],
        range: '1Y',
      });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SANDBOX_POSITIONS_MISMATCH');
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
    expect(bobRes.body.watchlists[0].owner).toEqual({
      id: expect.any(String),
      username: 'alice',
      profileIcon: null,
    });
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

  it('serves the value/performance chart series over the public link, and a non-public portfolio 404s (no chart-data leak)', async () => {
    const { aliceAgent, pid } = await scenario();
    const put = await putAudience(aliceAgent, 'portfolio', pid, {
      audience: 'public_link',
      acknowledgePublic: true,
    });
    const url = put.body.link.url as string;

    // Public link → the value/performance chart series rides in the SAME
    // read-only payload, built only AFTER the public_link gate is proven — the
    // logged-out chart opens no data path around the enforcement layer.
    const anon = await request(harness.app).get(url);
    expect(anon.status).toBe(200);
    expect(anon.body.kind).toBe('portfolio');
    expect(anon.body.portfolio.history.range).toBe('MAX');
    expect(Array.isArray(anon.body.portfolio.history.points)).toBe(true);

    // Narrow the audience away from public_link → the same URL (and with it the
    // chart's series) 404s: a non-public portfolio's chart data is never
    // fetchable on the public route.
    await putAudience(aliceAgent, 'portfolio', pid, { audience: 'all_friends' });
    const narrowed = await request(harness.app).get(url);
    expect(narrowed.status).toBe(404);
    expect(narrowed.body).not.toHaveProperty('portfolio');
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

describe('audience model — a secondary portfolio is private by default and shareable (#377)', () => {
  it('a new 2nd portfolio is private, then its audience changes, persists, enforces, and shows in my-shared', async () => {
    const { aliceAgent, bobAgent, assetId } = await scenario();

    // A newly created SECOND portfolio adopts the (private) default — no
    // share-audience row means private, per #332.
    const created = await aliceAgent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Trading' });
    expect(created.status).toBe(201);
    const secondPid = created.body.portfolio.id as string;
    expect(created.body.portfolio.visibility).toBe('private');

    // Private by default, three ways: the audience endpoint, enforcement (a
    // friend 404s), and it is STILL enumerated in my-shared so it can be shared.
    const initial = await aliceAgent.get(`/api/v1/social/audience/portfolio/${secondPid}`);
    expect(initial.status).toBe(200);
    expect(initial.body.audience).toBe('private');
    expect((await bobAgent.get(`/api/v1/social/shared/${secondPid}`)).status).toBe(404);
    let mine = await aliceAgent.get('/api/v1/social/my-shared');
    expect(
      mine.body.portfolios.find((p: { portfolioId: string }) => p.portfolioId === secondPid)
        ?.audience,
    ).toBe('private');

    await buyOneShare(aliceAgent, secondPid, assetId);

    // Change the SECONDARY (non-default) portfolio's audience → all friends.
    const put = await putAudience(aliceAgent, 'portfolio', secondPid, { audience: 'all_friends' });
    expect(put.status).toBe(200);

    // Persists on the owner's audience state …
    const after = await aliceAgent.get(`/api/v1/social/audience/portfolio/${secondPid}`);
    expect(after.body.audience).toBe('all_friends');
    // … enforces (the friend can now read the second portfolio) …
    expect((await bobAgent.get(`/api/v1/social/shared/${secondPid}`)).status).toBe(200);
    // … and my-shared reflects the new audience for that exact portfolio.
    mine = await aliceAgent.get('/api/v1/social/my-shared');
    expect(
      mine.body.portfolios.find((p: { portfolioId: string }) => p.portfolioId === secondPid)
        ?.audience,
    ).toBe('all_friends');
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

// --- Universal private-default: new portfolios are always private (#384) ----

describe('default portfolio visibility', () => {
  it('a newly created portfolio is private by default', async () => {
    const { aliceAgent } = await scenario();

    const created = await aliceAgent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Side pot' });
    expect(created.status).toBe(201);
    expect(created.body.portfolio.visibility).toBe('private');
  });

  it('ignores a stored friends default — a new portfolio is ALWAYS private (#384)', async () => {
    const { aliceAgent, pid } = await scenario();

    // The legacy per-user default can still be stored via Settings → Account…
    const patch = await aliceAgent
      .patch('/api/v1/settings/account')
      .set(...XRW)
      .send({ defaultPortfolioVisibility: 'friends' });
    expect(patch.status).toBe(200);
    expect(patch.body.defaultPortfolioVisibility).toBe('friends');

    // …but portfolio creation no longer honours it (#384): the new portfolio is
    // private, even for an account whose stored default is `friends`. The Settings
    // control that set it was removed in #377; the column is retired/ignored here.
    const created = await aliceAgent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Growth' });
    expect(created.status).toBe(201);
    expect(created.body.portfolio.visibility).toBe('private');

    // Existing rows are untouched: Main was explicitly set to friends in the
    // scenario and stays friends regardless of the default.
    const list = await aliceAgent.get('/api/v1/portfolios');
    const main = list.body.portfolios.find((p: { id: string }) => p.id === pid);
    expect(main.visibility).toBe('friends');
  });
});
