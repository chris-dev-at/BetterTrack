import request from 'supertest';
import type { Application } from 'express';
import { describe, expect, it } from 'vitest';

import {
  dividendsResponseSchema,
  earningsResponseSchema,
  marketIntelStatusResponseSchema,
  newsResponseSchema,
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
