import request from 'supertest';
import type { Application } from 'express';
import { describe, expect, it } from 'vitest';

import { portfolioSplitBasisResponseSchema, type SplitEvents } from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { cachedIntel, createStubMarketData } from '../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * `GET /portfolios/:id/split-basis` (§16 2026-09-03, #1694).
 *
 * Valuation is pinned to the raw traded close, so the PRICE side of a corporate
 * action is correct. The QUANTITY side cannot be fixed without rewriting the
 * user's ledger, which this app never does — so a held position that lived
 * through a split it never booked is named here instead of being mis-valued in
 * silence.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

const SPLIT_4_FOR_1: SplitEvents = {
  history: [{ date: '2026-03-02T00:00:00.000Z', numerator: 4, denominator: 1, ratio: '4:1' }],
  upcoming: [],
};

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
  expect(def).toBeTruthy();
  return def.id as string;
}

async function seedAsset(h: TestHarness) {
  const [row] = await h.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: 'AAPL',
      ownerId: null,
      type: 'stock',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      exchange: 'NASDAQ',
      currency: 'EUR',
    })
    .returning();
  if (!row) throw new Error('failed to seed asset');
  return row;
}

async function seedBuy(
  h: TestHarness,
  portfolioId: string,
  assetId: string,
  quantity: number,
  executedAt: string,
) {
  await h.db.insert(schema.transactions).values({
    portfolioId,
    assetId,
    side: 'buy',
    quantity: String(quantity),
    price: '200',
    fee: '0',
    executedAt: new Date(executedAt),
  });
}

const splitsStub = (splits: SplitEvents = SPLIT_4_FOR_1) =>
  createStubMarketData({ splits: () => cachedIntel(splits) });

describe('GET /api/v1/portfolios/:portfolioId/split-basis', () => {
  it('requires authentication', async () => {
    const h = await createTestApp({ marketData: splitsStub() });
    const res = await request(h.app).get(
      '/api/v1/portfolios/00000000-0000-0000-0000-000000000000/split-basis',
    );
    expect(res.status).toBe(401);
  });

  it('names a held position whose transactions predate an unbooked split', async () => {
    const h = await createTestApp({ marketData: splitsStub() });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const portfolioId = await defaultPortfolioId(agent);
    const asset = await seedAsset(h);
    await seedBuy(h, portfolioId, asset.id, 10, '2026-01-05T00:00:00.000Z');

    const res = await agent.get(`/api/v1/portfolios/${portfolioId}/split-basis`);
    expect(res.status).toBe(200);
    const body = portfolioSplitBasisResponseSchema.parse(res.body);
    expect(body.available).toBe(true);
    expect(body.positions).toHaveLength(1);
    expect(body.positions[0]?.asset.symbol).toBe('AAPL');
    expect(body.positions[0]?.quantity).toBe(10);
    expect(body.positions[0]?.splits).toEqual([
      { date: '2026-03-02', numerator: 4, denominator: 1, ratio: '4:1' },
    ]);
  });

  it('stays quiet when the position was opened after the split', async () => {
    const h = await createTestApp({ marketData: splitsStub() });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const portfolioId = await defaultPortfolioId(agent);
    const asset = await seedAsset(h);
    await seedBuy(h, portfolioId, asset.id, 10, '2026-04-01T00:00:00.000Z');

    const res = await agent.get(`/api/v1/portfolios/${portfolioId}/split-basis`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true, positions: [] });
  });

  it('reports "cannot tell" when no held asset has a splits-capable provider', async () => {
    // No `splits` control ⇒ the stub advertises no splits capability, which is
    // exactly a provider that cannot answer. `available: false` must never read
    // as an all-clear.
    const h = await createTestApp({ marketData: createStubMarketData() });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const portfolioId = await defaultPortfolioId(agent);
    const asset = await seedAsset(h);
    await seedBuy(h, portfolioId, asset.id, 10, '2026-01-05T00:00:00.000Z');

    const res = await agent.get(`/api/v1/portfolios/${portfolioId}/split-basis`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, positions: [] });
  });

  it('spends no provider budget on a portfolio with no transactions', async () => {
    const marketData = splitsStub();
    const h = await createTestApp({ marketData });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const portfolioId = await defaultPortfolioId(agent);

    const res = await agent.get(`/api/v1/portfolios/${portfolioId}/split-basis`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, positions: [] });
    expect(marketData.calls.splits).toBe(0);
  });

  it('404s another user’s portfolio (no IDOR)', async () => {
    const h = await createTestApp({ marketData: splitsStub() });
    const owner = await h.seedUser();
    const ownerAgent = await loginAgent(h.app, owner.email, owner.password);
    const portfolioId = await defaultPortfolioId(ownerAgent);

    const other = await h.seedUser({ email: 'other@bettertrack.test', username: 'otheruser' });
    const otherAgent = await loginAgent(h.app, other.email, other.password);
    const res = await otherAgent.get(`/api/v1/portfolios/${portfolioId}/split-basis`);
    expect(res.status).toBe(404);
  });
});
