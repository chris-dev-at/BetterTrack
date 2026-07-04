import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  mySharedListResponseSchema,
  sharedPortfolioDetailResponseSchema,
  sharedPortfolioListResponseSchema,
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

  return { alice, bob, carol, aliceAgent, bobAgent, carolAgent, pid };
}

describe('GET /api/v1/social/shared (Shared With Me)', () => {
  it('requires authentication', async () => {
    const res = await request(harness.app).get('/api/v1/social/shared');
    expect(res.status).toBe(401);
  });

  it("lists exactly a friend's visibility=friends portfolios with owner + total value", async () => {
    const { bobAgent } = await scenario();

    const res = await bobAgent.get('/api/v1/social/shared');
    expect(res.status).toBe(200);
    expect(sharedPortfolioListResponseSchema.safeParse(res.body).success).toBe(true);
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
    expect(mySharedListResponseSchema.safeParse(res.body).success).toBe(true);
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
  });
});
