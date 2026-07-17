import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../data/schema';
import { createStubMarketData } from '../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Route-level round-trips for the V5-P1b conditional read layer (issue #555):
 * portfolio summary, portfolio series and catalog search carry ETag +
 * Last-Modified and honour If-None-Match / If-Modified-Since, a data-changing
 * write flips the validator, a fresh "today" quote is never masked, and no
 * validator is reused across users.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

/** ISO day `offset` days before today (UTC). */
function dayOffset(offset: number): string {
  const day = new Date().toISOString().slice(0, 10);
  const ms = Date.parse(`${day}T00:00:00.000Z`) + offset * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** ISO-8601 timestamp at UTC midnight `offset` days before today. */
function tsOffset(offset: number): string {
  return `${dayOffset(offset)}T00:00:00.000Z`;
}

async function loginAgent(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

async function defaultPortfolioId(agent: ReturnType<typeof request.agent>): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  expect(res.status).toBe(200);
  const def = res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault);
  return def.id as string;
}

async function seedAsset(h: TestHarness, symbol: string, ownerId: string | null = null) {
  const [row] = await h.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: symbol,
      ownerId,
      type: 'stock',
      symbol,
      name: `${symbol} Corp`,
      currency: 'EUR',
      exchange: 'XETRA',
    })
    .returning();
  return row!.id;
}

/** A deterministic EUR market-data stub (fixed quote, empty provider history). */
function deterministicMarketData(priceRef: { price: number }) {
  return createStubMarketData({
    quote: () => ({
      value: {
        price: priceRef.price,
        currency: 'EUR',
        prevClose: 100,
        dayChangePct: 0,
        asOf: '2026-07-17T00:00:00.000Z',
      },
      stale: false,
      asOf: 1,
    }),
    history: () => ({ value: [], stale: false, asOf: 1 }),
  });
}

/** Buy a fixed asset so the portfolio has holdings + a series. Returns the txn id. */
async function buyInto(
  agent: ReturnType<typeof request.agent>,
  pid: string,
  assetId: string,
  quantity: number,
): Promise<string> {
  const res = await agent
    .post(`/api/v1/portfolios/${pid}/transactions`)
    .set(...XRW)
    .send({ assetId, side: 'buy', quantity, price: 100, executedAt: tsOffset(-3) });
  expect(res.status).toBe(201);
  return res.body.transactions[0].id as string;
}

describe('conditional reads — portfolio summary (GET /api/v1/portfolios/:id)', () => {
  let harness: TestHarness;
  const priceRef = { price: 120 };

  beforeEach(async () => {
    priceRef.price = 120;
    harness = await createTestApp({ marketData: deterministicMarketData(priceRef) });
  });

  it('carries ETag + Last-Modified and serves a 304 on an unchanged summary', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const assetId = await seedAsset(harness, 'SUMA');
    await buyInto(agent, pid, assetId, 1);

    const first = await agent.get(`/api/v1/portfolios/${pid}`);
    expect(first.status).toBe(200);
    expect(first.headers.etag).toMatch(/^W\/"/);
    expect(first.headers['last-modified']).toBeTruthy();
    expect(first.headers['cache-control']).toBe('private, no-cache');
    expect(first.headers.vary).toContain('Cookie');

    const revalidate = await agent
      .get(`/api/v1/portfolios/${pid}`)
      .set('If-None-Match', first.headers.etag as string);
    expect(revalidate.status).toBe(304);
    expect(revalidate.text).toBe('');
    expect(revalidate.headers.etag).toBe(first.headers.etag);
  });

  it('flips the validator when a transaction is edited', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const assetId = await seedAsset(harness, 'SUMB');
    const txId = await buyInto(agent, pid, assetId, 1);

    const before = await agent.get(`/api/v1/portfolios/${pid}`);
    const etag = before.headers.etag;

    const patch = await agent
      .patch(`/api/v1/portfolios/${pid}/transactions/${txId}`)
      .set(...XRW)
      .send({ quantity: 5 });
    expect(patch.status).toBe(200);

    const after = await agent.get(`/api/v1/portfolios/${pid}`).set('If-None-Match', etag as string);
    expect(after.status).toBe(200);
    expect(after.headers.etag).not.toBe(etag);
  });

  it('never masks a fresh "today" quote behind a 304', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const assetId = await seedAsset(harness, 'SUMC');
    await buyInto(agent, pid, assetId, 1);

    const first = await agent.get(`/api/v1/portfolios/${pid}`);
    const etag = first.headers.etag;

    // A new live quote arrives (no write, no invalidation).
    priceRef.price = 200;

    const revalidate = await agent
      .get(`/api/v1/portfolios/${pid}`)
      .set('If-None-Match', etag as string)
      // Even an If-Modified-Since in the future must not mask the fresh quote.
      .set('If-Modified-Since', new Date(Date.now() + 86_400_000).toUTCString());
    expect(revalidate.status).toBe(200);
    expect(revalidate.headers.etag).not.toBe(etag);
    expect(revalidate.body.holdings[0].price).toBe(200);
  });

  it('does not reuse a validator across users', async () => {
    const userA = await harness.seedUser();
    const agentA = await loginAgent(harness.app, userA.email, userA.password);
    const pidA = await defaultPortfolioId(agentA);
    const assetA = await seedAsset(harness, 'SUMD');
    await buyInto(agentA, pidA, assetA, 1);
    const resA = await agentA.get(`/api/v1/portfolios/${pidA}`);

    const userB = await harness.seedUser({ email: 'user-b@bettertrack.test', username: 'userb' });
    const agentB = await loginAgent(harness.app, userB.email, userB.password);
    const pidB = await defaultPortfolioId(agentB);
    const assetB = await seedAsset(harness, 'SUME');
    await buyInto(agentB, pidB, assetB, 1);

    // B presents A's ETag against B's own portfolio: must be a 200, never a 304.
    const cross = await agentB
      .get(`/api/v1/portfolios/${pidB}`)
      .set('If-None-Match', resA.headers.etag as string);
    expect(cross.status).toBe(200);
    expect(cross.headers.etag).not.toBe(resA.headers.etag);
  });
});

describe('conditional reads — portfolio series (GET /api/v1/portfolios/:id/history)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp({ marketData: deterministicMarketData({ price: 120 }) });
  });

  it('carries validators and serves a 304 on an unchanged series', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const assetId = await seedAsset(harness, 'SERA');
    await buyInto(agent, pid, assetId, 1);

    // Warm-up read: the first series read refills the snapshot rows, so both
    // compared reads below are served from the same (snapshot) path.
    await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);

    const first = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(first.status).toBe(200);
    expect(first.headers.etag).toMatch(/^W\/"/);
    expect(first.headers['last-modified']).toBeTruthy();

    const revalidate = await agent
      .get(`/api/v1/portfolios/${pid}/history?range=MAX`)
      .set('If-None-Match', first.headers.etag as string);
    expect(revalidate.status).toBe(304);
    expect(revalidate.text).toBe('');
  });

  it('flips the series validator when the underlying data changes (snapshot invalidation)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const assetId = await seedAsset(harness, 'SERB');
    // Stored closes so the series carries real, quantity-scaled values.
    await harness.db.insert(schema.priceHistory).values([
      { assetId, date: dayOffset(-2), close: '100' },
      { assetId, date: dayOffset(-1), close: '110' },
    ]);
    const txId = await buyInto(agent, pid, assetId, 1);

    const before = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    const etag = before.headers.etag;

    const patch = await agent
      .patch(`/api/v1/portfolios/${pid}/transactions/${txId}`)
      .set(...XRW)
      .send({ quantity: 9 });
    expect(patch.status).toBe(200);

    const after = await agent
      .get(`/api/v1/portfolios/${pid}/history?range=MAX`)
      .set('If-None-Match', etag as string);
    expect(after.status).toBe(200);
    expect(after.headers.etag).not.toBe(etag);
  });
});

describe('conditional reads — catalog search (GET /api/v1/search)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp({ marketData: createStubMarketData() });
    // ≥3 market matches so `enriching` stays false and the body is stable.
    await seedAsset(harness, 'CONDA');
    await seedAsset(harness, 'CONDB');
    await seedAsset(harness, 'CONDC');
  });

  it('carries validators and serves a 304 via If-None-Match and If-Modified-Since', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const first = await agent.get('/api/v1/search?q=COND');
    expect(first.status).toBe(200);
    expect(first.body.enriching).toBe(false);
    expect(first.headers.etag).toMatch(/^W\/"/);
    expect(first.headers['last-modified']).toBeTruthy();
    expect(first.headers['cache-control']).toBe('private, no-cache');

    const byEtag = await agent
      .get('/api/v1/search?q=COND')
      .set('If-None-Match', first.headers.etag as string);
    expect(byEtag.status).toBe(304);
    expect(byEtag.text).toBe('');

    // No live "today" on search — If-Modified-Since gates a 304 too.
    const byDate = await agent
      .get('/api/v1/search?q=COND')
      .set('If-Modified-Since', first.headers['last-modified'] as string);
    expect(byDate.status).toBe(304);
  });

  it('does not leak a catalog validator across the auth boundary', async () => {
    const userA = await harness.seedUser();
    const agentA = await loginAgent(harness.app, userA.email, userA.password);
    const resA = await agentA.get('/api/v1/search?q=COND');

    const userB = await harness.seedUser({ email: 'user-b@bettertrack.test', username: 'userb' });
    const agentB = await loginAgent(harness.app, userB.email, userB.password);
    const resB = await agentB.get('/api/v1/search?q=COND');

    // Identical catalog view, but the identity-salted ETags never collide.
    expect(resA.headers.etag).not.toBe(resB.headers.etag);
    const cross = await agentB
      .get('/api/v1/search?q=COND')
      .set('If-None-Match', resA.headers.etag as string);
    expect(cross.status).toBe(200);
  });
});
