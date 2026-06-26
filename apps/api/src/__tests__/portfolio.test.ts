import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  portfolioHistoryResponseSchema,
  portfolioResponseSchema,
  transactionListResponseSchema,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createStubMarketData } from '../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

/** ISO day `offset` days before today (UTC). */
function dayOffset(offset: number): string {
  const ms = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  return new Date(ms + offset * 86_400_000).toISOString().slice(0, 10);
}

/** ISO-8601 timestamp at UTC midnight of a day `offset` days before today. */
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

async function seedAsset(
  h: TestHarness,
  overrides: Partial<typeof schema.assets.$inferInsert> = {},
) {
  const [row] = await h.db
    .insert(schema.assets)
    .values({
      providerId: overrides.providerId ?? 'yahoo',
      providerRef: overrides.providerRef ?? 'BAYN.DE',
      type: overrides.type ?? 'stock',
      symbol: overrides.symbol ?? 'BAYN.DE',
      name: overrides.name ?? 'Bayer AG',
      currency: overrides.currency ?? 'EUR',
      exchange: overrides.exchange ?? 'XETRA',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('Failed to seed asset');
  return row;
}

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

describe('POST /api/v1/portfolio/transactions', () => {
  it('requires authentication', async () => {
    const res = await request(harness.app)
      .post('/api/v1/portfolio/transactions')
      .set(...XRW)
      .send({
        assetId: '00000000-0000-0000-0000-000000000000',
        side: 'buy',
        quantity: 1,
        price: 1,
      });
    expect(res.status).toBe(401);
  });

  it('creates a single transaction', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const asset = await seedAsset(harness);

    const res = await agent
      .post('/api/v1/portfolio/transactions')
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 10, price: 50, executedAt: tsOffset(-3) });

    expect(res.status).toBe(201);
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.transactions[0].side).toBe('buy');
    expect(res.body.transactions[0].quantity).toBe(10);
    expect(res.body.transactions[0].asset.id).toBe(asset.id);
  });

  it('creates transactions in bulk (the buy flow)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const asset = await seedAsset(harness);

    const res = await agent
      .post('/api/v1/portfolio/transactions')
      .set(...XRW)
      .send({
        transactions: [
          { assetId: asset.id, side: 'buy', quantity: 5, price: 50, executedAt: tsOffset(-5) },
          { assetId: asset.id, side: 'buy', quantity: 5, price: 60, executedAt: tsOffset(-4) },
          { assetId: asset.id, side: 'sell', quantity: 3, price: 70, executedAt: tsOffset(-3) },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.transactions).toHaveLength(3);

    const list = await agent.get('/api/v1/portfolio/transactions');
    expect(list.status).toBe(200);
    expect(transactionListResponseSchema.safeParse(list.body).success).toBe(true);
    expect(list.body.items).toHaveLength(3);
  });

  it('rejects a SELL that would make the held quantity negative', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const asset = await seedAsset(harness);

    await agent
      .post('/api/v1/portfolio/transactions')
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 3.5, price: 50, executedAt: tsOffset(-3) });

    const res = await agent
      .post('/api/v1/portfolio/transactions')
      .set(...XRW)
      .send({ assetId: asset.id, side: 'sell', quantity: 5, price: 60, executedAt: tsOffset(-2) });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OVERSELL');
    expect(res.body.error.message).toContain('only hold 3.5');
  });

  it('rejects a back-dated SELL that over-sells at an earlier point in time', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const asset = await seedAsset(harness);

    // Buy 10 today; a SELL of 5 dated *before* the buy over-sells at that moment.
    await agent
      .post('/api/v1/portfolio/transactions')
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 10, price: 50, executedAt: tsOffset(-1) });

    const res = await agent
      .post('/api/v1/portfolio/transactions')
      .set(...XRW)
      .send({ assetId: asset.id, side: 'sell', quantity: 5, price: 60, executedAt: tsOffset(-5) });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OVERSELL');
  });

  it('rejects a transaction against an unknown asset', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const res = await agent
      .post('/api/v1/portfolio/transactions')
      .set(...XRW)
      .send({
        assetId: '11111111-1111-7111-8111-111111111111',
        side: 'buy',
        quantity: 1,
        price: 1,
        executedAt: tsOffset(0),
      });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ASSET_NOT_FOUND');
  });
});

describe('GET /api/v1/portfolio/transactions (pagination)', () => {
  it('paginates newest-first with a cursor', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const asset = await seedAsset(harness);

    await agent
      .post('/api/v1/portfolio/transactions')
      .set(...XRW)
      .send({
        transactions: [
          { assetId: asset.id, side: 'buy', quantity: 1, price: 10, executedAt: tsOffset(-3) },
          { assetId: asset.id, side: 'buy', quantity: 1, price: 11, executedAt: tsOffset(-2) },
          { assetId: asset.id, side: 'buy', quantity: 1, price: 12, executedAt: tsOffset(-1) },
        ],
      });

    const first = await agent.get('/api/v1/portfolio/transactions?limit=2');
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await agent.get(
      `/api/v1/portfolio/transactions?limit=2&cursor=${first.body.nextCursor}`,
    );
    expect(second.status).toBe(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
  });
});

describe('PATCH/DELETE /api/v1/portfolio/transactions/:id', () => {
  it('updates a transaction', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const asset = await seedAsset(harness);

    const created = await agent
      .post('/api/v1/portfolio/transactions')
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 10, price: 50, executedAt: tsOffset(-3) });
    const id = created.body.transactions[0].id;

    const res = await agent
      .patch(`/api/v1/portfolio/transactions/${id}`)
      .set(...XRW)
      .send({ quantity: 12, note: 'topped up' });
    expect(res.status).toBe(200);
    expect(res.body.transaction.quantity).toBe(12);
    expect(res.body.transaction.note).toBe('topped up');
  });

  it('rejects an edit that would over-sell', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const asset = await seedAsset(harness);

    const buy = await agent
      .post('/api/v1/portfolio/transactions')
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 10, price: 50, executedAt: tsOffset(-3) });
    await agent
      .post('/api/v1/portfolio/transactions')
      .set(...XRW)
      .send({ assetId: asset.id, side: 'sell', quantity: 8, price: 60, executedAt: tsOffset(-2) });

    // Shrinking the BUY to 5 would make the existing SELL of 8 invalid.
    const res = await agent
      .patch(`/api/v1/portfolio/transactions/${buy.body.transactions[0].id}`)
      .set(...XRW)
      .send({ quantity: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OVERSELL');
  });

  it('deletes a transaction, but refuses when it would over-sell', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const asset = await seedAsset(harness);

    const buy = await agent
      .post('/api/v1/portfolio/transactions')
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 10, price: 50, executedAt: tsOffset(-3) });
    const sell = await agent
      .post('/api/v1/portfolio/transactions')
      .set(...XRW)
      .send({ assetId: asset.id, side: 'sell', quantity: 8, price: 60, executedAt: tsOffset(-2) });

    // Deleting the BUY would leave the SELL of 8 over-selling.
    const blocked = await agent
      .delete(`/api/v1/portfolio/transactions/${buy.body.transactions[0].id}`)
      .set(...XRW);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.code).toBe('OVERSELL');

    // Deleting the SELL first is fine.
    const ok = await agent
      .delete(`/api/v1/portfolio/transactions/${sell.body.transactions[0].id}`)
      .set(...XRW);
    expect(ok.status).toBe(204);
  });

  it('does not expose another user’s transactions (IDOR)', async () => {
    const owner = await harness.seedUser({ email: 'owner@bt.test', username: 'owner' });
    const ownerAgent = await loginAgent(harness.app, owner.email, owner.password);
    const asset = await seedAsset(harness);
    const created = await ownerAgent
      .post('/api/v1/portfolio/transactions')
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 1, price: 1, executedAt: tsOffset(-1) });
    const id = created.body.transactions[0].id;

    const intruder = await harness.seedUser({ email: 'evil@bt.test', username: 'evil' });
    const intruderAgent = await loginAgent(harness.app, intruder.email, intruder.password);

    const patch = await intruderAgent
      .patch(`/api/v1/portfolio/transactions/${id}`)
      .set(...XRW)
      .send({ quantity: 999 });
    expect(patch.status).toBe(404);

    const del = await intruderAgent.delete(`/api/v1/portfolio/transactions/${id}`).set(...XRW);
    expect(del.status).toBe(404);
  });
});

describe('GET /api/v1/portfolio (holdings + totals)', () => {
  it('returns an empty portfolio for a new user', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const res = await agent.get('/api/v1/portfolio');
    expect(res.status).toBe(200);
    expect(portfolioResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.holdings).toHaveLength(0);
    expect(res.body.totals.marketValueEur).toBe(0);
  });

  it('derives holdings + totals from the transaction log and a live quote', async () => {
    // Deterministic EUR quote with a prior close, so day change is exercised too.
    const marketData = createStubMarketData({
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
    const stubHarness = await createTestApp({ marketData });
    const user = await stubHarness.seedUser();
    const agent = await loginAgent(stubHarness.app, user.email, user.password);
    const asset = await seedAsset(stubHarness, { currency: 'EUR' });

    await agent
      .post('/api/v1/portfolio/transactions')
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 1, price: 100, executedAt: tsOffset(-3) });

    const res = await agent.get('/api/v1/portfolio');
    expect(res.status).toBe(200);
    expect(portfolioResponseSchema.safeParse(res.body).success).toBe(true);

    const [holding] = res.body.holdings;
    expect(holding.quantity).toBe(1);
    expect(holding.avgCost).toBe(100);
    expect(holding.price).toBe(120);
    expect(holding.marketValueEur).toBe(120);
    expect(holding.costBasisEur).toBe(100);
    expect(holding.unrealizedPnlEur).toBe(20);
    expect(holding.unrealizedPnlPct).toBe(20);
    expect(holding.dayChangeEur).toBe(20);

    expect(res.body.totals.marketValueEur).toBe(120);
    expect(res.body.totals.investedEur).toBe(100);
    expect(res.body.totals.unrealizedPnlEur).toBe(20);
    expect(res.body.totals.unrealizedPnlPct).toBe(20);
    expect(res.body.totals.dayChangeEur).toBe(20);
    expect(res.body.totals.dayChangePct).toBe(20);
  });
});

describe('GET /api/v1/portfolio/history (value over time + cache)', () => {
  it('returns an empty series for a new user', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const res = await agent.get('/api/v1/portfolio/history?range=MAX');
    expect(res.status).toBe(200);
    expect(portfolioHistoryResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.points).toHaveLength(0);
  });

  it('builds the EUR value series and invalidates the cache on writes', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const asset = await seedAsset(harness, { currency: 'EUR' });

    // Two daily closes for the asset (the value series reads price_history).
    await harness.db.insert(schema.priceHistory).values([
      { assetId: asset.id, date: dayOffset(-2), close: '100' },
      { assetId: asset.id, date: dayOffset(-1), close: '110' },
    ]);

    await agent
      .post('/api/v1/portfolio/transactions')
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 2, price: 100, executedAt: tsOffset(-2) });

    const first = await agent.get('/api/v1/portfolio/history?range=MAX');
    expect(first.status).toBe(200);
    expect(portfolioHistoryResponseSchema.safeParse(first.body).success).toBe(true);
    const firstStart = first.body.points[0];
    expect(firstStart.date).toBe(dayOffset(-2));
    expect(firstStart.valueEur).toBeCloseTo(200, 6); // 2 × 100

    // A second buy must invalidate the cached series and change the result.
    await agent
      .post('/api/v1/portfolio/transactions')
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 2, price: 110, executedAt: tsOffset(-2) });

    const second = await agent.get('/api/v1/portfolio/history?range=MAX');
    expect(second.status).toBe(200);
    expect(second.body.points[0].valueEur).toBeCloseTo(400, 6); // 4 × 100
  });

  it('degrades (no 500) for a non-EUR holding with no historical FX', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    // Historical FX for non-base currencies is not yet supported (§5.4); a USD
    // holding with value points must not crash the series.
    const asset = await seedAsset(harness, {
      currency: 'USD',
      providerRef: 'AAPL',
      symbol: 'AAPL',
      exchange: 'NASDAQ',
    });
    await harness.db.insert(schema.priceHistory).values([
      { assetId: asset.id, date: dayOffset(-2), close: '100' },
      { assetId: asset.id, date: dayOffset(-1), close: '110' },
    ]);
    await agent
      .post('/api/v1/portfolio/transactions')
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 2, price: 100, executedAt: tsOffset(-2) });

    const res = await agent.get('/api/v1/portfolio/history?range=MAX');
    expect(res.status).toBe(200);
    expect(portfolioHistoryResponseSchema.safeParse(res.body).success).toBe(true);
    // The unconvertible USD holding is dropped from the series rather than 500ing.
    expect(res.body.points).toHaveLength(0);
  });

  it('keeps EUR holdings in the series while dropping unconvertible non-EUR ones', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const eur = await seedAsset(harness, { currency: 'EUR' });
    const usd = await seedAsset(harness, {
      currency: 'USD',
      providerRef: 'AAPL',
      symbol: 'AAPL',
      exchange: 'NASDAQ',
    });
    await harness.db.insert(schema.priceHistory).values([
      { assetId: eur.id, date: dayOffset(-1), close: '100' },
      { assetId: usd.id, date: dayOffset(-1), close: '999' },
    ]);
    await agent
      .post('/api/v1/portfolio/transactions')
      .set(...XRW)
      .send({
        transactions: [
          { assetId: eur.id, side: 'buy', quantity: 2, price: 100, executedAt: tsOffset(-1) },
          { assetId: usd.id, side: 'buy', quantity: 5, price: 999, executedAt: tsOffset(-1) },
        ],
      });

    const res = await agent.get('/api/v1/portfolio/history?range=MAX');
    expect(res.status).toBe(200);
    expect(res.body.points.length).toBeGreaterThan(0);
    // Only the EUR holding contributes (2 × 100) on every point; the USD leg
    // (5 × 999) is degraded out rather than 500ing the request.
    for (const point of res.body.points) {
      expect(point.valueEur).toBeCloseTo(200, 6);
    }
  });
});
