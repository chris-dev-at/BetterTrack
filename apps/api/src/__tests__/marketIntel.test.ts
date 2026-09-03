import request from 'supertest';
import type { Application } from 'express';
import { describe, expect, it } from 'vitest';

import {
  dividendsResponseSchema,
  earningsCalendarResponseSchema,
  earningsResponseSchema,
  marketIntelStatusResponseSchema,
  newsResponseSchema,
  projectedDividendIncomeResponseSchema,
  splitsResponseSchema,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';
import {
  cachedIntel,
  createStubMarketData,
  sampleDividendEvents,
  sampleEarningsEvents,
  sampleNewsHeadlines,
  sampleSplitEvents,
} from '../testing/marketDataStubs';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const NONEXISTENT = '00000000-0000-0000-0000-000000000000';

/** A stub with all four intel families wired (so capabilities report available). */
const fullIntelStub = () =>
  createStubMarketData({
    dividends: () => cachedIntel(sampleDividendEvents()),
    earnings: () => cachedIntel(sampleEarningsEvents()),
    news: () => cachedIntel(sampleNewsHeadlines()),
    splits: () => cachedIntel(sampleSplitEvents()),
  });

async function loginAgent(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

async function seedGlobalAsset(
  h: TestHarness,
  overrides: Partial<typeof schema.assets.$inferInsert> = {},
) {
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
      currency: 'USD',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('failed to seed asset');
  return row;
}

describe('GET /api/v1/assets/:id/intel', () => {
  it('requires authentication', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const res = await request(h.app).get(`/api/v1/assets/${NONEXISTENT}/intel`);
    expect(res.status).toBe(401);
  });

  it('reports enabled + per-capability availability from the resolved provider', async () => {
    const h = await createTestApp({ marketData: fullIntelStub() });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get(`/api/v1/assets/${asset.id}/intel`);
    expect(res.status).toBe(200);
    const parsed = marketIntelStatusResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.enabled).toBe(true);
    expect(parsed.data.capabilities).toEqual({
      dividends: true,
      earnings: true,
      news: true,
      splits: true,
    });
  });

  it('returns 404 for an unknown asset', async () => {
    const h = await createTestApp({ marketData: fullIntelStub() });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const res = await agent.get(`/api/v1/assets/${NONEXISTENT}/intel`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ASSET_NOT_FOUND');
  });

  it("does not leak another user's custom asset (404, §10)", async () => {
    const h = await createTestApp({ marketData: fullIntelStub() });
    const owner = await h.seedUser({ email: 'mi-owner@a.test', username: 'miowner' });
    const other = await h.seedUser({ email: 'mi-other@a.test', username: 'miother' });
    const [custom] = await h.db
      .insert(schema.assets)
      .values({
        providerId: 'manual',
        providerRef: 'owner-house',
        ownerId: owner.id,
        type: 'custom',
        symbol: 'HOUSE',
        name: 'Owner House',
        currency: 'EUR',
      })
      .returning();
    const otherAgent = await loginAgent(h.app, other.email, other.password);
    const res = await otherAgent.get(`/api/v1/assets/${custom!.id}/intel`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/assets/:id/intel/* — the four families', () => {
  it('dividends: returns available data parsing against the contract', async () => {
    const h = await createTestApp({ marketData: fullIntelStub() });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get(`/api/v1/assets/${asset.id}/intel/dividends`);
    expect(res.status).toBe(200);
    const parsed = dividendsResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.available).toBe(true);
    expect(parsed.data.history.length).toBeGreaterThan(0);
    expect(parsed.data.forwardYield).toBe(0.0044);
  });

  it('earnings: returns available data parsing against the contract', async () => {
    const h = await createTestApp({ marketData: fullIntelStub() });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get(`/api/v1/assets/${asset.id}/intel/earnings`);
    expect(res.status).toBe(200);
    const parsed = earningsResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.available).toBe(true);
    expect(parsed.data.next?.estimated).toBe(true);
  });

  it('news: returns available headlines parsing against the contract', async () => {
    const h = await createTestApp({ marketData: fullIntelStub() });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get(`/api/v1/assets/${asset.id}/intel/news`);
    expect(res.status).toBe(200);
    const parsed = newsResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.available).toBe(true);
    expect(parsed.data.headlines.length).toBeGreaterThan(0);
  });

  it('splits: returns available data parsing against the contract', async () => {
    const h = await createTestApp({ marketData: fullIntelStub() });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get(`/api/v1/assets/${asset.id}/intel/splits`);
    expect(res.status).toBe(200);
    const parsed = splitsResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.available).toBe(true);
    expect(parsed.data.history.length).toBeGreaterThan(0);
  });

  it('splits: an ANNOUNCED (upcoming) split survives the service and the route', async () => {
    // Yahoo exposes only past splits (`mapSplitEvents` returns an empty
    // `upcoming`), so nothing in a live deployment proves the forward branch is
    // reachable. A fixture provider that DOES announce one does: the row shape
    // `mapSplitEvents` produces survives the read layer unmodified, all the way
    // into the response the asset page's "Announced" row renders from.
    const announced = {
      date: '2026-09-01T00:00:00.000Z',
      numerator: 2,
      denominator: 1,
      ratio: '2:1',
    };
    const h = await createTestApp({
      marketData: createStubMarketData({
        splits: () => cachedIntel(sampleSplitEvents({ upcoming: [announced] })),
      }),
    });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get(`/api/v1/assets/${asset.id}/intel/splits`);
    expect(res.status).toBe(200);
    const parsed = splitsResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.available).toBe(true);
    expect(parsed.data.upcoming).toEqual([announced]);
    // Announced and past stay separate families — no cross-contamination.
    expect(parsed.data.history).not.toContainEqual(announced);
  });
});

describe('market intel — unconfigured shapes', () => {
  it('a capability-less provider yields available:false + empty (not an error)', async () => {
    // No intel controls ⇒ the stub advertises no capabilities.
    const h = await createTestApp({ marketData: createStubMarketData() });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    const caps = await agent.get(`/api/v1/assets/${asset.id}/intel`);
    expect(caps.status).toBe(200);
    expect(caps.body.enabled).toBe(true);
    expect(caps.body.capabilities.dividends).toBe(false);

    const dividends = await agent.get(`/api/v1/assets/${asset.id}/intel/dividends`);
    expect(dividends.status).toBe(200);
    const parsed = dividendsResponseSchema.safeParse(dividends.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.available).toBe(false);
    expect(parsed.data.history).toEqual([]);
  });

  it('MARKET_INTEL_ENABLED=false ⇒ capabilities all false + endpoints unconfigured', async () => {
    // The provider advertises everything, but the global gate hides it.
    const h = await createTestApp({
      marketData: fullIntelStub(),
      env: { MARKET_INTEL_ENABLED: 'false' },
    });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    const caps = await agent.get(`/api/v1/assets/${asset.id}/intel`);
    expect(caps.status).toBe(200);
    expect(caps.body.enabled).toBe(false);
    expect(caps.body.capabilities).toEqual({
      dividends: false,
      earnings: false,
      news: false,
      splits: false,
    });

    const news = await agent.get(`/api/v1/assets/${asset.id}/intel/news`);
    expect(news.status).toBe(200);
    expect(news.body.available).toBe(false);
    expect(news.body.headlines).toEqual([]);
    // Gate off ⇒ the provider is never consulted.
    expect((h.ctx.marketData as ReturnType<typeof createStubMarketData>).calls.news).toBe(0);
  });

  it('default (no env) keeps the gate ON', async () => {
    const h = await createTestApp({ marketData: fullIntelStub() });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);
    const caps = await agent.get(`/api/v1/assets/${asset.id}/intel`);
    expect(caps.body.enabled).toBe(true);
  });

  it('a provider error degrades to available:false — never a 5xx', async () => {
    const marketData = createStubMarketData({
      dividends: () => {
        throw new Error('upstream down');
      },
    });
    const h = await createTestApp({ marketData });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get(`/api/v1/assets/${asset.id}/intel/dividends`);
    expect(res.status).toBe(200);
    const parsed = dividendsResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.available).toBe(false);
    expect(parsed.data.history).toEqual([]);
  });
});

describe('GET /api/v1/assets/intel/earnings-calendar (Workboard panel, arc b)', () => {
  /** Add `asset` to `user`'s default watchlist so it counts as "watched". */
  async function watch(h: TestHarness, userId: string, assetId: string) {
    const [wl] = await h.db
      .insert(schema.watchlists)
      .values({ userId, name: 'General', isDefault: true })
      .returning({ id: schema.watchlists.id });
    await h.db
      .insert(schema.workboardItems)
      .values({ userId, watchlistId: wl!.id, assetId, sortOrder: 0 });
  }

  it('requires authentication', async () => {
    const h = await createTestApp({ marketData: fullIntelStub() });
    const res = await request(h.app).get('/api/v1/assets/intel/earnings-calendar');
    expect(res.status).toBe(401);
  });

  it('lists a watched asset with its upcoming earnings date + estimated flag', async () => {
    const h = await createTestApp({ marketData: fullIntelStub() });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    await watch(h, user.id, asset.id);
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get('/api/v1/assets/intel/earnings-calendar');
    expect(res.status).toBe(200);
    const parsed = earningsCalendarResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.available).toBe(true);
    expect(parsed.data.entries).toHaveLength(1);
    expect(parsed.data.entries[0]).toMatchObject({
      assetId: asset.id,
      symbol: 'AAPL',
      held: false,
      watched: true,
      estimated: true,
    });
  });

  it('is empty (available:true) for a user with no held/watched assets', async () => {
    const h = await createTestApp({ marketData: fullIntelStub() });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get('/api/v1/assets/intel/earnings-calendar');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true, entries: [] });
  });

  it('MARKET_INTEL_ENABLED=false ⇒ available:false, empty (invisible when unconfigured)', async () => {
    const h = await createTestApp({
      marketData: fullIntelStub(),
      env: { MARKET_INTEL_ENABLED: 'false' },
    });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    await watch(h, user.id, asset.id);
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get('/api/v1/assets/intel/earnings-calendar');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, entries: [] });
  });
});

describe('GET /api/v1/assets/portfolio/dividend-projection — scope (V5-P6b, #1662)', () => {
  /** €1/share trailing, so a holding's yearly income is simply its quantity. */
  const oneEuroPerShare = () =>
    createStubMarketData({
      dividends: () =>
        cachedIntel(
          sampleDividendEvents({ currency: 'EUR', trailingAmount: 1, history: [], upcoming: [] }),
        ),
    });

  /** A portfolio holding `quantity` shares of a freshly-seeded EUR payer. */
  async function seedPortfolioWithHolding(h: TestHarness, userId: string, quantity: number) {
    const [portfolio] = await h.db
      .insert(schema.portfolios)
      .values({ userId, name: `P${quantity}` })
      .returning();
    const asset = await seedGlobalAsset(h, {
      providerRef: `PAYER${quantity}`,
      symbol: `PAY${quantity}`,
      name: `Payer ${quantity}`,
      currency: 'EUR',
    });
    await h.db.insert(schema.transactions).values({
      portfolioId: portfolio!.id,
      assetId: asset.id,
      side: 'buy',
      quantity: String(quantity),
      price: '10',
      executedAt: new Date('2026-01-05T00:00:00.000Z'),
    });
    return { portfolioId: portfolio!.id, assetId: asset.id };
  }

  it('scopes the projection to one portfolio, and stays user-wide without an id', async () => {
    const h = await createTestApp({ marketData: oneEuroPerShare() });
    const user = await h.seedUser();
    const first = await seedPortfolioWithHolding(h, user.id, 10);
    const second = await seedPortfolioWithHolding(h, user.id, 90);
    const agent = await loginAgent(h.app, user.email, user.password);

    // Unscoped: the cross-portfolio total the portfolio page's income line has
    // always shown — 10 + 90 = 100 €/yr. Pinned so the Forecast's scoping cannot
    // quietly change that surface.
    const all = await agent.get('/api/v1/assets/portfolio/dividend-projection');
    expect(all.status).toBe(200);
    const allParsed = projectedDividendIncomeResponseSchema.safeParse(all.body);
    expect(allParsed.success).toBe(true);
    if (!allParsed.success) return;
    expect(allParsed.data.available).toBe(true);
    expect(allParsed.data.yearlyTotalEur).toBe(100);
    expect(allParsed.data.holdings).toHaveLength(2);

    // Scoped: the shown portfolio's income ALONE. This is the figure the
    // Forecast adds to that portfolio's own net-worth curve.
    const scoped = await agent
      .get('/api/v1/assets/portfolio/dividend-projection')
      .query({ portfolioId: first.portfolioId });
    expect(scoped.status).toBe(200);
    const scopedParsed = projectedDividendIncomeResponseSchema.safeParse(scoped.body);
    expect(scopedParsed.success).toBe(true);
    if (!scopedParsed.success) return;
    expect(scopedParsed.data.yearlyTotalEur).toBe(10);
    expect(scopedParsed.data.holdings.map((holding) => holding.assetId)).toEqual([first.assetId]);

    const other = await agent
      .get('/api/v1/assets/portfolio/dividend-projection')
      .query({ portfolioId: second.portfolioId });
    expect(other.body.yearlyTotalEur).toBe(90);
    expect(other.body.monthlyTotalEur).toBe(7.5);
  });

  it("another user's portfolio id yields an empty projection, never their income", async () => {
    const h = await createTestApp({ marketData: oneEuroPerShare() });
    const owner = await h.seedUser({ email: 'dp-owner@a.test', username: 'dpowner' });
    const other = await h.seedUser({ email: 'dp-other@a.test', username: 'dpother' });
    const ownerPortfolio = await seedPortfolioWithHolding(h, owner.id, 10);
    const otherAgent = await loginAgent(h.app, other.email, other.password);

    const res = await otherAgent
      .get('/api/v1/assets/portfolio/dividend-projection')
      .query({ portfolioId: ownerPortfolio.portfolioId });
    expect(res.status).toBe(200);
    expect(res.body.yearlyTotalEur).toBe(0);
    expect(res.body.holdings).toEqual([]);
  });

  it('rejects a malformed portfolioId (400)', async () => {
    const h = await createTestApp({ marketData: oneEuroPerShare() });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent
      .get('/api/v1/assets/portfolio/dividend-projection')
      .query({ portfolioId: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
