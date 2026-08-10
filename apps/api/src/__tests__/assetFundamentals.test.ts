import request from 'supertest';
import type { Application } from 'express';
import { describe, expect, it } from 'vitest';

import {
  createApiKeyResponseSchema,
  fundamentalsResponseSchema,
  FUNDAMENTALS_MAX_LIMIT,
  type ApiKeyScope,
  type AssetFundamentals,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';
import {
  cachedIntel,
  createStubMarketData,
  sampleFundamentals,
  type StubMarketDataControls,
} from '../testing/marketDataStubs';

/**
 * `GET /assets/:id/intel/fundamentals` (INTEL1, board #76). Integration coverage
 * for the auth surface (session + bearer `market:read`), the §10 asset scoping,
 * period selection, limit clamping, `period` enum validation, and the
 * degrade-to-`available:false` contract every intel route shares.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const NONEXISTENT = '00000000-0000-0000-0000-000000000000';

/** A stub whose fundamentals capability is wired from the canned sample. */
const fundamentalsStub = (controls: StubMarketDataControls = {}) =>
  createStubMarketData({ fundamentals: () => cachedIntel(sampleFundamentals()), ...controls });

async function loginAgent(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

async function mintKey(
  h: TestHarness,
  identifier: string,
  password: string,
  scopes: ApiKeyScope[],
) {
  const agent = await loginAgent(h.app, identifier, password);
  const res = await agent
    .post('/api/v1/settings/api-keys')
    .set(...XRW)
    .send({ name: 'fundamentals-test', scopes });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return createApiKeyResponseSchema.parse(res.body).token;
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

/** An annual FY row anchored on a given year (for clamp/ordering assertions). */
function annualRow(year: number): AssetFundamentals['annual'][number] {
  return {
    fiscalPeriod: 'FY',
    fiscalYear: year,
    endDate: `${year}-09-30T00:00:00.000Z`,
    reportDate: null,
    revenue: year * 1_000_000,
    netIncome: year * 100_000,
    eps: null,
    grossProfit: null,
    operatingIncome: null,
    totalAssets: null,
    totalLiabilities: null,
    totalEquity: null,
    operatingCashFlow: null,
    freeCashFlow: null,
  };
}

describe('GET /api/v1/assets/:id/intel/fundamentals — auth', () => {
  it('requires authentication (401)', async () => {
    const h = await createTestApp({ marketData: fundamentalsStub() });
    const res = await request(h.app).get(`/api/v1/assets/${NONEXISTENT}/intel/fundamentals`);
    expect(res.status).toBe(401);
  });

  it('a session serves the data', async () => {
    const h = await createTestApp({ marketData: fundamentalsStub() });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get(`/api/v1/assets/${asset.id}/intel/fundamentals`);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });

  it('a bearer key WITH market:read serves the data', async () => {
    const h = await createTestApp({ marketData: fundamentalsStub() });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const token = await mintKey(h, user.email, user.password, ['market:read']);

    const res = await request(h.app)
      .get(`/api/v1/assets/${asset.id}/intel/fundamentals`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });

  it('a bearer key WITHOUT market:read is 403 INSUFFICIENT_SCOPE', async () => {
    const h = await createTestApp({ marketData: fundamentalsStub() });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    // A valid scope, but not the one /assets reads require.
    const token = await mintKey(h, user.email, user.password, ['portfolio:read']);

    const res = await request(h.app)
      .get(`/api/v1/assets/${asset.id}/intel/fundamentals`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
  });
});

describe('GET /api/v1/assets/:id/intel/fundamentals — behaviour', () => {
  it('returns available annual data parsing against the contract, most-recent-first', async () => {
    const h = await createTestApp({ marketData: fundamentalsStub() });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get(`/api/v1/assets/${asset.id}/intel/fundamentals`);
    expect(res.status).toBe(200);
    const parsed = fundamentalsResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.available).toBe(true);
    expect(parsed.data.period).toBe('annual');
    expect(parsed.data.currency).toBe('USD');
    expect(parsed.data.periods.length).toBeGreaterThan(0);
    // Descending by fiscal year (most-recent-first).
    const years = parsed.data.periods.map((p) => p.fiscalYear ?? 0);
    expect(years).toEqual([...years].sort((a, b) => b - a));
    expect(parsed.data.ratios.marketCap).toBe(3_100_000_000_000);
  });

  it('period=quarterly returns the quarterly series', async () => {
    const h = await createTestApp({ marketData: fundamentalsStub() });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent
      .get(`/api/v1/assets/${asset.id}/intel/fundamentals`)
      .query({ period: 'quarterly' });
    expect(res.status).toBe(200);
    expect(res.body.period).toBe('quarterly');
    expect(res.body.periods[0].fiscalPeriod).toMatch(/^Q[1-4]$/);
  });

  it('clamps limit to the max (a request for 50 yields at most 12)', async () => {
    // 15 annual rows so the cap is actually exercised.
    const many: AssetFundamentals = {
      ...sampleFundamentals(),
      annual: Array.from({ length: 15 }, (_, i) => annualRow(2025 - i)),
    };
    const h = await createTestApp({
      marketData: createStubMarketData({ fundamentals: () => cachedIntel(many) }),
    });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent
      .get(`/api/v1/assets/${asset.id}/intel/fundamentals`)
      .query({ limit: 50 });
    expect(res.status).toBe(200);
    expect(res.body.periods).toHaveLength(FUNDAMENTALS_MAX_LIMIT);
    // Still the newest 12 (2025 down to 2014).
    expect(res.body.periods[0].fiscalYear).toBe(2025);
  });

  it('honours a small explicit limit', async () => {
    const h = await createTestApp({ marketData: fundamentalsStub() });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent
      .get(`/api/v1/assets/${asset.id}/intel/fundamentals`)
      .query({ limit: 2 });
    expect(res.status).toBe(200);
    expect(res.body.periods).toHaveLength(2);
  });

  it('rejects an out-of-enum period with 400 VALIDATION_ERROR', async () => {
    const h = await createTestApp({ marketData: fundamentalsStub() });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent
      .get(`/api/v1/assets/${asset.id}/intel/fundamentals`)
      .query({ period: 'monthly' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for an unknown asset', async () => {
    const h = await createTestApp({ marketData: fundamentalsStub() });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const res = await agent.get(`/api/v1/assets/${NONEXISTENT}/intel/fundamentals`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ASSET_NOT_FOUND');
  });

  it("does not leak another user's custom asset (404, §10)", async () => {
    const h = await createTestApp({ marketData: fundamentalsStub() });
    const owner = await h.seedUser({ email: 'fund-owner@a.test', username: 'fundowner' });
    const other = await h.seedUser({ email: 'fund-other@a.test', username: 'fundother' });
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
    const res = await otherAgent.get(`/api/v1/assets/${custom!.id}/intel/fundamentals`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/assets/:id/intel/fundamentals — unconfigured shapes', () => {
  it('a capability-less provider yields available:false + empty periods + all-null ratios', async () => {
    // No `fundamentals` control ⇒ the provider lacks the capability.
    const h = await createTestApp({ marketData: createStubMarketData() });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get(`/api/v1/assets/${asset.id}/intel/fundamentals`);
    expect(res.status).toBe(200);
    const parsed = fundamentalsResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.available).toBe(false);
    expect(parsed.data.periods).toEqual([]);
    expect(parsed.data.currency).toBeNull();
    expect(parsed.data.ratios.marketCap).toBeNull();
  });

  it('MARKET_INTEL_ENABLED=false ⇒ available:false and the provider is never consulted', async () => {
    const marketData = fundamentalsStub();
    const h = await createTestApp({ marketData, env: { MARKET_INTEL_ENABLED: 'false' } });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get(`/api/v1/assets/${asset.id}/intel/fundamentals`);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.periods).toEqual([]);
    expect((h.ctx.marketData as ReturnType<typeof createStubMarketData>).calls.fundamentals).toBe(
      0,
    );
  });

  it('a provider error degrades to available:false — never a 5xx', async () => {
    const marketData = createStubMarketData({
      fundamentals: () => {
        throw new Error('upstream down');
      },
    });
    const h = await createTestApp({ marketData });
    const user = await h.seedUser();
    const asset = await seedGlobalAsset(h);
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get(`/api/v1/assets/${asset.id}/intel/fundamentals`);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.periods).toEqual([]);
  });
});
