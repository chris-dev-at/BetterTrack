import request from 'supertest';
import type { Application } from 'express';
import { describe, expect, it } from 'vitest';

import {
  assetDetailResponseSchema,
  historyResponseSchema,
  quoteResponseSchema,
  type CachedResult,
  type HistoryRange,
  type PricePoint,
  type Quote,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';
import { createStubMarketData } from '../testing/marketDataStubs';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

const FETCHED_AT = Date.parse('2026-06-20T10:00:00.000Z');

const sampleQuote = (overrides: Partial<Quote> = {}): Quote => ({
  price: 187.5,
  currency: 'USD',
  prevClose: 185,
  dayChangePct: 1.35,
  asOf: '2026-06-20T09:59:00.000Z',
  ...overrides,
});

const cachedQuote = (overrides: Partial<CachedResult<Quote>> = {}): CachedResult<Quote> => ({
  value: sampleQuote(),
  stale: false,
  asOf: FETCHED_AT,
  ...overrides,
});

const sampleHistory = (): PricePoint[] => [
  { time: '2026-05-20T00:00:00.000Z', close: 170 },
  { time: '2026-06-20T00:00:00.000Z', close: 187.5 },
];

const cachedHistory = (
  overrides: Partial<CachedResult<PricePoint[]>> = {},
): CachedResult<PricePoint[]> => ({
  value: sampleHistory(),
  stale: false,
  asOf: FETCHED_AT,
  ...overrides,
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

const NONEXISTENT = '00000000-0000-0000-0000-000000000000';

describe('GET /api/v1/assets/:id', () => {
  it('requires authentication', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const res = await request(h.app).get(`/api/v1/assets/${NONEXISTENT}`);
    expect(res.status).toBe(401);
  });

  it('returns meta + latest quote with stale=false and an ISO asOf', async () => {
    const marketData = createStubMarketData({ quote: () => cachedQuote() });
    const h = await createTestApp({ marketData });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get(`/api/v1/assets/${asset.id}`);
    expect(res.status).toBe(200);
    const parsed = assetDetailResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.asset.id).toBe(asset.id);
    expect(parsed.data.asset.symbol).toBe('AAPL');
    expect(parsed.data.asset.isCustom).toBe(false);
    expect(parsed.data.quote?.price).toBe(187.5);
    expect(parsed.data.stale).toBe(false);
    expect(parsed.data.asOf).toBe('2026-06-20T10:00:00.000Z');
  });

  it('marks the quote stale when the provider serves a degraded copy', async () => {
    const marketData = createStubMarketData({ quote: () => cachedQuote({ stale: true }) });
    const h = await createTestApp({ marketData });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get(`/api/v1/assets/${asset.id}`);
    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(true);
  });

  it('degrades to a null quote (stale, no asOf) when the provider has nothing cached', async () => {
    const marketData = createStubMarketData({
      quote: () => {
        throw new Error('upstream down');
      },
    });
    const h = await createTestApp({ marketData });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get(`/api/v1/assets/${asset.id}`);
    expect(res.status).toBe(200);
    expect(res.body.quote).toBeNull();
    expect(res.body.stale).toBe(true);
    expect(res.body.asOf).toBeNull();
    // Meta still resolves from the stored row.
    expect(res.body.asset.symbol).toBe('AAPL');
  });

  it('returns 400 for a non-UUID id', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const res = await agent.get('/api/v1/assets/not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for an unknown asset', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const res = await agent.get(`/api/v1/assets/${NONEXISTENT}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ASSET_NOT_FOUND');
  });

  it("returns 404 for another user's custom asset — no IDOR (§10)", async () => {
    const marketData = createStubMarketData({ quote: () => cachedQuote() });
    const h = await createTestApp({ marketData });
    const owner = await h.seedUser({ email: 'owner@a.test', username: 'aowner' });
    const other = await h.seedUser({ email: 'other@a.test', username: 'aother' });

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

    const ownerAgent = await loginAgent(h.app, owner.email, owner.password);
    const otherAgent = await loginAgent(h.app, other.email, other.password);

    // Owner can read it; another user gets a 404 indistinguishable from missing.
    expect((await ownerAgent.get(`/api/v1/assets/${custom!.id}`)).status).toBe(200);
    const res = await otherAgent.get(`/api/v1/assets/${custom!.id}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ASSET_NOT_FOUND');
  });
});

describe('GET /api/v1/assets/:id/quote', () => {
  it('returns the quote with stale/asOf markers', async () => {
    const marketData = createStubMarketData({ quote: () => cachedQuote() });
    const h = await createTestApp({ marketData });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get(`/api/v1/assets/${asset.id}/quote`);
    expect(res.status).toBe(200);
    const parsed = quoteResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.quote.price).toBe(187.5);
    expect(parsed.data.stale).toBe(false);
    expect(parsed.data.asOf).toBe('2026-06-20T10:00:00.000Z');
  });

  it('returns 502 when the provider fails with nothing cached', async () => {
    const marketData = createStubMarketData({
      quote: () => {
        throw new Error('upstream down');
      },
    });
    const h = await createTestApp({ marketData });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get(`/api/v1/assets/${asset.id}/quote`);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_UNAVAILABLE');
  });
});

describe('GET /api/v1/assets/:id/history', () => {
  it('returns the series and maps range→interval per §5.3', async () => {
    const cases: Array<[HistoryRange, string]> = [
      ['1D', '1m'],
      ['1W', '15m'],
      ['1M', '30m'],
      ['6M', '1d'],
      ['1Y', '1d'],
      ['5Y', '1wk'],
      ['MAX', '1mo'],
    ];

    // One harness for the whole table — the stub records the range each call so
    // we verify the server picks the interval from the range, not the caller.
    let seenRange: HistoryRange | undefined;
    const marketData = createStubMarketData({
      history: (_ref, r) => {
        seenRange = r;
        return cachedHistory();
      },
    });
    const h = await createTestApp({ marketData });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    for (const [range, interval] of cases) {
      seenRange = undefined;
      const res = await agent.get(`/api/v1/assets/${asset.id}/history?range=${range}`);
      expect(res.status).toBe(200);
      const parsed = historyResponseSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      expect(seenRange).toBe(range);
      expect(parsed.data.range).toBe(range);
      expect(parsed.data.interval).toBe(interval);
      expect(parsed.data.points).toHaveLength(2);
      expect(parsed.data.asOf).toBe('2026-06-20T10:00:00.000Z');
    }
  });

  it('passes through the stale marker', async () => {
    const marketData = createStubMarketData({ history: () => cachedHistory({ stale: true }) });
    const h = await createTestApp({ marketData });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get(`/api/v1/assets/${asset.id}/history?range=1M`);
    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(true);
  });

  it('rejects a missing or invalid range', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    expect((await agent.get(`/api/v1/assets/${asset.id}/history`)).status).toBe(400);
    expect((await agent.get(`/api/v1/assets/${asset.id}/history?range=10Y`)).status).toBe(400);
  });

  it('returns 502 when the provider fails with nothing cached', async () => {
    const marketData = createStubMarketData({
      history: () => {
        throw new Error('upstream down');
      },
    });
    const h = await createTestApp({ marketData });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get(`/api/v1/assets/${asset.id}/history?range=1M`);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('returns 404 for an unknown asset before calling the provider', async () => {
    const marketData = createStubMarketData({ history: () => cachedHistory() });
    const h = await createTestApp({ marketData });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get(`/api/v1/assets/${NONEXISTENT}/history?range=1M`);
    expect(res.status).toBe(404);
    expect(marketData.calls.history).toBe(0);
  });
});
