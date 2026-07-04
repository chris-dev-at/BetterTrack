import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  portfolioHistoryResponseSchema,
  portfolioListResponseSchema,
  portfolioResponseSchema,
  portfolioSummarySchema,
  transactionListResponseSchema,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createRecordingBackfill, createStubMarketData } from '../testing/marketDataStubs';
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

/** Resolve the caller's default ("Main") portfolio id via the scoped list endpoint. */
async function defaultPortfolioId(agent: ReturnType<typeof request.agent>): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  expect(res.status).toBe(200);
  const def = res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault);
  expect(def).toBeTruthy();
  return def.id as string;
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

// ─── Portfolio list + single portfolio + PATCH ────────────────────────────────

describe('GET /api/v1/portfolios (list, scoped model)', () => {
  it('requires authentication', async () => {
    const res = await request(harness.app).get('/api/v1/portfolios');
    expect(res.status).toBe(401);
  });

  it('returns the auto-created default portfolio for a new user', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const res = await agent.get('/api/v1/portfolios');
    expect(res.status).toBe(200);
    expect(portfolioListResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.portfolios).toHaveLength(1);
    const [main] = res.body.portfolios;
    expect(main.name).toBe('Main');
    expect(main.isDefault).toBe(true);
    expect(main.visibility).toBe('private');
    expect(main.sortOrder).toBe(0);
  });

  it('surfaces a second portfolio inserted directly via SQL with no code change', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    // Materialise the default first (the list endpoint does this lazily).
    await agent.get('/api/v1/portfolios');

    // A future multi-portfolio feature only inserts a row — the scoped model
    // makes it appear immediately with zero handler changes (§13 P3 done-when).
    await harness.db
      .insert(schema.portfolios)
      .values({ userId: user.id, name: 'Trading', visibility: 'friends', sortOrder: 1 });

    const res = await agent.get('/api/v1/portfolios');
    expect(res.status).toBe(200);
    expect(res.body.portfolios).toHaveLength(2);
    const names = res.body.portfolios.map((p: { name: string }) => p.name);
    expect(names).toEqual(['Main', 'Trading']); // ordered by sort_order
    const trading = res.body.portfolios.find((p: { name: string }) => p.name === 'Trading');
    expect(trading.isDefault).toBe(false);
    expect(trading.visibility).toBe('friends');
  });
});

describe('GET /api/v1/portfolios/:id (single, ownership-scoped)', () => {
  it('returns an empty portfolio for a new user', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);

    const res = await agent.get(`/api/v1/portfolios/${pid}`);
    expect(res.status).toBe(200);
    expect(portfolioResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.holdings).toHaveLength(0);
    expect(res.body.totals.marketValueEur).toBe(0);
  });

  it('404s a portfolio id owned by another user (no IDOR, not 403)', async () => {
    const owner = await harness.seedUser({ email: 'owner@bt.test', username: 'owner' });
    const ownerAgent = await loginAgent(harness.app, owner.email, owner.password);
    const ownerPid = await defaultPortfolioId(ownerAgent);

    const intruder = await harness.seedUser({ email: 'evil@bt.test', username: 'evil' });
    const intruderAgent = await loginAgent(harness.app, intruder.email, intruder.password);

    const res = await intruderAgent.get(`/api/v1/portfolios/${ownerPid}`);
    expect(res.status).toBe(404);
    const hist = await intruderAgent.get(`/api/v1/portfolios/${ownerPid}/history?range=MAX`);
    expect(hist.status).toBe(404);
    const txns = await intruderAgent.get(`/api/v1/portfolios/${ownerPid}/transactions`);
    expect(txns.status).toBe(404);
  });
});

describe('PATCH /api/v1/portfolios/:id (name + visibility)', () => {
  it('updates name and visibility, and is ownership-scoped', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);

    const res = await agent
      .patch(`/api/v1/portfolios/${pid}`)
      .set(...XRW)
      .send({ name: 'My Money', visibility: 'friends' });
    expect(res.status).toBe(200);
    expect(portfolioSummarySchema.safeParse(res.body.portfolio).success).toBe(true);
    expect(res.body.portfolio.name).toBe('My Money');
    expect(res.body.portfolio.visibility).toBe('friends');
    // Default is a stable property of the row (§6.8), not derived from its name:
    // renaming the auto-created portfolio keeps it the default.
    expect(res.body.portfolio.isDefault).toBe(true);

    // The change persists across a fresh read — and, crucially, renaming the
    // default must NOT resurrect a phantom empty "Main": still exactly one row.
    const list = await agent.get('/api/v1/portfolios');
    expect(list.body.portfolios).toHaveLength(1);
    const updated = list.body.portfolios.find((p: { id: string }) => p.id === pid);
    expect(updated.name).toBe('My Money');
    expect(updated.visibility).toBe('friends');
    expect(updated.isDefault).toBe(true);
  });

  it('404s when patching another user’s portfolio', async () => {
    const owner = await harness.seedUser({ email: 'owner@bt.test', username: 'owner' });
    const ownerAgent = await loginAgent(harness.app, owner.email, owner.password);
    const ownerPid = await defaultPortfolioId(ownerAgent);

    const intruder = await harness.seedUser({ email: 'evil@bt.test', username: 'evil' });
    const intruderAgent = await loginAgent(harness.app, intruder.email, intruder.password);

    const res = await intruderAgent
      .patch(`/api/v1/portfolios/${ownerPid}`)
      .set(...XRW)
      .send({ visibility: 'friends' });
    expect(res.status).toBe(404);
  });
});

// ─── Transactions (scoped under a portfolio) ──────────────────────────────────

describe('POST /api/v1/portfolios/:id/transactions', () => {
  it('requires authentication', async () => {
    const res = await request(harness.app)
      .post('/api/v1/portfolios/11111111-1111-7111-8111-111111111111/transactions')
      .set(...XRW)
      .send({
        assetId: '00000000-0000-0000-0000-000000000000',
        side: 'buy',
        quantity: 1,
        price: 1,
      });
    expect(res.status).toBe(401);
  });

  it('404s posting to a portfolio the caller does not own', async () => {
    const owner = await harness.seedUser({ email: 'owner@bt.test', username: 'owner' });
    const ownerAgent = await loginAgent(harness.app, owner.email, owner.password);
    const ownerPid = await defaultPortfolioId(ownerAgent);
    const asset = await seedAsset(harness);

    const intruder = await harness.seedUser({ email: 'evil@bt.test', username: 'evil' });
    const intruderAgent = await loginAgent(harness.app, intruder.email, intruder.password);

    const res = await intruderAgent
      .post(`/api/v1/portfolios/${ownerPid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 1, price: 1, executedAt: tsOffset(-1) });
    expect(res.status).toBe(404);
  });

  it('creates a single transaction', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(harness);

    const res = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
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
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(harness);

    const res = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
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

    const list = await agent.get(`/api/v1/portfolios/${pid}/transactions`);
    expect(list.status).toBe(200);
    expect(transactionListResponseSchema.safeParse(list.body).success).toBe(true);
    expect(list.body.items).toHaveLength(3);
  });

  it('rejects a SELL that would make the held quantity negative', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(harness);

    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 3.5, price: 50, executedAt: tsOffset(-3) });

    const res = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'sell', quantity: 5, price: 60, executedAt: tsOffset(-2) });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OVERSELL');
    expect(res.body.error.message).toContain('only hold 3.5');
  });

  it('rejects a back-dated SELL that over-sells at an earlier point in time', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(harness);

    // Buy 10 today; a SELL of 5 dated *before* the buy over-sells at that moment.
    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 10, price: 50, executedAt: tsOffset(-1) });

    const res = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'sell', quantity: 5, price: 60, executedAt: tsOffset(-5) });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OVERSELL');
  });

  it('rejects a transaction against an unknown asset', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);

    const res = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
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

describe('GET /api/v1/portfolios/:id/transactions (pagination)', () => {
  it('paginates newest-first with a cursor', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(harness);

    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({
        transactions: [
          { assetId: asset.id, side: 'buy', quantity: 1, price: 10, executedAt: tsOffset(-3) },
          { assetId: asset.id, side: 'buy', quantity: 1, price: 11, executedAt: tsOffset(-2) },
          { assetId: asset.id, side: 'buy', quantity: 1, price: 12, executedAt: tsOffset(-1) },
        ],
      });

    const first = await agent.get(`/api/v1/portfolios/${pid}/transactions?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await agent.get(
      `/api/v1/portfolios/${pid}/transactions?limit=2&cursor=${first.body.nextCursor}`,
    );
    expect(second.status).toBe(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
  });
});

describe('PATCH/DELETE /api/v1/portfolios/:id/transactions/:txId', () => {
  it('updates a transaction', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(harness);

    const created = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 10, price: 50, executedAt: tsOffset(-3) });
    const id = created.body.transactions[0].id;

    const res = await agent
      .patch(`/api/v1/portfolios/${pid}/transactions/${id}`)
      .set(...XRW)
      .send({ quantity: 12, note: 'topped up' });
    expect(res.status).toBe(200);
    expect(res.body.transaction.quantity).toBe(12);
    expect(res.body.transaction.note).toBe('topped up');
  });

  it('rejects an edit that would over-sell', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(harness);

    const buy = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 10, price: 50, executedAt: tsOffset(-3) });
    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'sell', quantity: 8, price: 60, executedAt: tsOffset(-2) });

    // Shrinking the BUY to 5 would make the existing SELL of 8 invalid.
    const res = await agent
      .patch(`/api/v1/portfolios/${pid}/transactions/${buy.body.transactions[0].id}`)
      .set(...XRW)
      .send({ quantity: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OVERSELL');
  });

  it('deletes a transaction, but refuses when it would over-sell', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(harness);

    const buy = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 10, price: 50, executedAt: tsOffset(-3) });
    const sell = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'sell', quantity: 8, price: 60, executedAt: tsOffset(-2) });

    // Deleting the BUY would leave the SELL of 8 over-selling.
    const blocked = await agent
      .delete(`/api/v1/portfolios/${pid}/transactions/${buy.body.transactions[0].id}`)
      .set(...XRW);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.code).toBe('OVERSELL');

    // Deleting the SELL first is fine.
    const ok = await agent
      .delete(`/api/v1/portfolios/${pid}/transactions/${sell.body.transactions[0].id}`)
      .set(...XRW);
    expect(ok.status).toBe(204);
  });

  it('does not expose another user’s transactions (IDOR)', async () => {
    const owner = await harness.seedUser({ email: 'owner@bt.test', username: 'owner' });
    const ownerAgent = await loginAgent(harness.app, owner.email, owner.password);
    const ownerPid = await defaultPortfolioId(ownerAgent);
    const asset = await seedAsset(harness);
    const created = await ownerAgent
      .post(`/api/v1/portfolios/${ownerPid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 1, price: 1, executedAt: tsOffset(-1) });
    const id = created.body.transactions[0].id;

    const intruder = await harness.seedUser({ email: 'evil@bt.test', username: 'evil' });
    const intruderAgent = await loginAgent(harness.app, intruder.email, intruder.password);
    const intruderPid = await defaultPortfolioId(intruderAgent);

    // The intruder's own portfolio does not contain the owner's txn → 404.
    const patch = await intruderAgent
      .patch(`/api/v1/portfolios/${intruderPid}/transactions/${id}`)
      .set(...XRW)
      .send({ quantity: 999 });
    expect(patch.status).toBe(404);

    const del = await intruderAgent
      .delete(`/api/v1/portfolios/${intruderPid}/transactions/${id}`)
      .set(...XRW);
    expect(del.status).toBe(404);
  });
});

describe('GET /api/v1/portfolios/:id (holdings + totals)', () => {
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
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(stubHarness, { currency: 'EUR' });

    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 1, price: 100, executedAt: tsOffset(-3) });

    const res = await agent.get(`/api/v1/portfolios/${pid}`);
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

describe('GET /api/v1/portfolios/:id/history (value over time + cache)', () => {
  it('returns an empty series for a new user', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const res = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(res.status).toBe(200);
    expect(portfolioHistoryResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.points).toHaveLength(0);
  });

  it('builds the EUR value series and invalidates the cache on writes', async () => {
    // The unconfigured stub throws on getHistory — a provider outage with no
    // cached copy — so the series must degrade to the stored price_history rows.
    const h = await createTestApp({ marketData: createStubMarketData() });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(h, { currency: 'EUR' });

    // Two stored daily closes for the asset (the outage fallback layer).
    await h.db.insert(schema.priceHistory).values([
      { assetId: asset.id, date: dayOffset(-2), close: '100' },
      { assetId: asset.id, date: dayOffset(-1), close: '110' },
    ]);

    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 2, price: 100, executedAt: tsOffset(-2) });

    const first = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(first.status).toBe(200);
    expect(portfolioHistoryResponseSchema.safeParse(first.body).success).toBe(true);
    const firstStart = first.body.points[0];
    expect(firstStart.date).toBe(dayOffset(-2));
    expect(firstStart.valueEur).toBeCloseTo(200, 6); // 2 × 100

    // A second buy must invalidate the cached series and change the result.
    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 2, price: 110, executedAt: tsOffset(-2) });

    const second = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(second.status).toBe(200);
    expect(second.body.points[0].valueEur).toBeCloseTo(400, 6); // 4 × 100
  });

  it('degrades (no 500) for a non-EUR holding with no historical FX', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    // Historical FX for non-base currencies is not yet supported (§5.4); a USD
    // holding with value points must not crash the series.
    const asset = await seedAsset(h, {
      currency: 'USD',
      providerRef: 'AAPL',
      symbol: 'AAPL',
      exchange: 'NASDAQ',
    });
    await h.db.insert(schema.priceHistory).values([
      { assetId: asset.id, date: dayOffset(-2), close: '100' },
      { assetId: asset.id, date: dayOffset(-1), close: '110' },
    ]);
    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 2, price: 100, executedAt: tsOffset(-2) });

    const res = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(res.status).toBe(200);
    expect(portfolioHistoryResponseSchema.safeParse(res.body).success).toBe(true);
    // The unconvertible USD holding is dropped from the series rather than 500ing.
    expect(res.body.points).toHaveLength(0);
  });

  it('keeps EUR holdings in the series while dropping unconvertible non-EUR ones', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const eur = await seedAsset(h, { currency: 'EUR' });
    const usd = await seedAsset(h, {
      currency: 'USD',
      providerRef: 'AAPL',
      symbol: 'AAPL',
      exchange: 'NASDAQ',
    });
    await h.db.insert(schema.priceHistory).values([
      { assetId: eur.id, date: dayOffset(-1), close: '100' },
      { assetId: usd.id, date: dayOffset(-1), close: '999' },
    ]);
    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({
        transactions: [
          { assetId: eur.id, side: 'buy', quantity: 2, price: 100, executedAt: tsOffset(-1) },
          { assetId: usd.id, side: 'buy', quantity: 5, price: 999, executedAt: tsOffset(-1) },
        ],
      });

    const res = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(res.status).toBe(200);
    expect(res.body.points.length).toBeGreaterThan(0);
    // Only the EUR holding contributes (2 × 100) on every point; the USD leg
    // (5 × 999) is degraded out rather than 500ing the request.
    for (const point of res.body.points) {
      expect(point.valueEur).toBeCloseTo(200, 6);
    }
  });
});

describe('GET /api/v1/portfolios/:id/history (performance-% mode, #125)', () => {
  it('neutralizes deposits: a top-up doubles the value curve but leaves performance flat', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(h, { currency: 'EUR' });

    // Flat price through the deposit, then a +10 % move.
    await h.db.insert(schema.priceHistory).values([
      { assetId: asset.id, date: dayOffset(-3), close: '100' },
      { assetId: asset.id, date: dayOffset(-2), close: '100' },
      { assetId: asset.id, date: dayOffset(-1), close: '110' },
    ]);
    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({
        transactions: [
          { assetId: asset.id, side: 'buy', quantity: 10, price: 100, executedAt: tsOffset(-3) },
          { assetId: asset.id, side: 'buy', quantity: 10, price: 100, executedAt: tsOffset(-2) },
        ],
      });

    const res = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(res.status).toBe(200);
    expect(portfolioHistoryResponseSchema.safeParse(res.body).success).toBe(true);

    // Same daily grid as the value curve.
    expect(res.body.performance.map((p: { date: string }) => p.date)).toEqual(
      res.body.points.map((p: { date: string }) => p.date),
    );

    // The absolute curve jumps 1 000 → 2 000 on the deposit day…
    expect(res.body.points[0].valueEur).toBeCloseTo(1000, 6);
    expect(res.body.points[1].valueEur).toBeCloseTo(2000, 6);
    // …while performance stays at 0 % until the market actually moves.
    expect(res.body.performance[0].pct).toBeCloseTo(0, 9);
    expect(res.body.performance[1].pct).toBeCloseTo(0, 9);
    expect(res.body.performance[2].pct).toBeCloseTo(10, 9);
    // Carry-forward day (today, no newer close): still +10 %.
    expect(res.body.performance.at(-1).pct).toBeCloseTo(10, 9);
  });

  it('re-bases a range slice to 0 % at the window start (1M shows that month’s TWR)', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(h, { currency: 'EUR' });

    // +20 % happens well BEFORE the 1M window, +25 % (120 → 150) inside it.
    await h.db.insert(schema.priceHistory).values([
      { assetId: asset.id, date: dayOffset(-60), close: '100' },
      { assetId: asset.id, date: dayOffset(-45), close: '120' },
      { assetId: asset.id, date: dayOffset(-1), close: '150' },
    ]);
    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 1, price: 100, executedAt: tsOffset(-60) });

    const max = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(max.status).toBe(200);
    // Since inception: 100 → 150.
    expect(max.body.performance[0].pct).toBeCloseTo(0, 9);
    expect(max.body.performance.at(-1).pct).toBeCloseTo(50, 9);

    const month = await agent.get(`/api/v1/portfolios/${pid}/history?range=1M`);
    expect(month.status).toBe(200);
    expect(portfolioHistoryResponseSchema.safeParse(month.body).success).toBe(true);
    // The window starts at 0 % — not at the +20 % the portfolio was already up —
    // and ends at the move that happened inside the window (120 → 150 = +25 %).
    expect(month.body.performance[0].pct).toBeCloseTo(0, 9);
    expect(month.body.performance.at(-1).pct).toBeCloseTo(25, 9);
  });

  it('MAX keeps since-inception semantics: day one’s execution→close move is not re-based away', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(h, { currency: 'EUR' });

    // Bought intraday at 100/unit; that day CLOSED at 104, latest close 150.
    // True since-inception TWR is +50 %. Re-basing MAX to its first plotted
    // point would divide out the day-one +4 % and wrongly report +44.23 %.
    await h.db.insert(schema.priceHistory).values([
      { assetId: asset.id, date: dayOffset(-3), close: '104' },
      { assetId: asset.id, date: dayOffset(-1), close: '150' },
    ]);
    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 10, price: 100, executedAt: tsOffset(-3) });

    const max = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(max.status).toBe(200);
    expect(portfolioHistoryResponseSchema.safeParse(max.body).success).toBe(true);
    expect(max.body.performance[0].pct).toBeCloseTo(4, 9);
    expect(max.body.performance.at(-1).pct).toBeCloseTo(50, 9);

    // A sliced window still re-bases to its first plotted point (return since
    // that day's close) even when it happens to contain inception — only MAX
    // carries the since-inception anchor.
    const month = await agent.get(`/api/v1/portfolios/${pid}/history?range=1M`);
    expect(month.status).toBe(200);
    expect(month.body.performance[0].pct).toBeCloseTo(0, 9);
    expect(month.body.performance.at(-1).pct).toBeCloseTo((150 / 104 - 1) * 100, 9);
  });
});

describe('GET /api/v1/portfolios/:id/history (provider-fed daily curve, #108)', () => {
  /** Deterministic daily closes for the last 7 calendar days (−6 … today). */
  function marketCloses(): Map<string, number> {
    return new Map(
      [-6, -5, -4, -3, -2, -1, 0].map((offset, i) => [dayOffset(offset), 100 + i * 2]),
    );
  }

  /** CachedResult wrapper for stubbed provider history points. */
  function cachedHistory(points: Array<{ time: string; close: number }>) {
    return { value: points, stale: false, asOf: Date.now() };
  }

  it('feeds real provider daily history: the curve moves between transactions and a mid-range buy bends it', async () => {
    const closes = marketCloses();
    const marketData = createStubMarketData({
      history: () =>
        cachedHistory(
          [...closes].map(([date, close]) => ({ time: `${date}T00:00:00.000Z`, close })),
        ),
    });
    const h = await createTestApp({ marketData });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(h, { currency: 'EUR' });
    // Deliberately NO price_history rows: every point must come from the provider.

    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({
        transactions: [
          { assetId: asset.id, side: 'buy', quantity: 1, price: 100, executedAt: tsOffset(-6) },
          { assetId: asset.id, side: 'buy', quantity: 1, price: 106, executedAt: tsOffset(-3) },
        ],
      });

    const res = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(res.status).toBe(200);
    expect(portfolioHistoryResponseSchema.safeParse(res.body).success).toBe(true);

    // One point per calendar day across the whole span, not just at transactions.
    expect(res.body.points).toHaveLength(7);
    // total_t = Σ quantity_t × price_t: 1 unit until the mid-range buy, 2 after —
    // the buy bends the curve from its date forward.
    for (const point of res.body.points) {
      const qty = point.date >= dayOffset(-3) ? 2 : 1;
      expect(point.valueEur).toBeCloseTo(qty * closes.get(point.date)!, 6);
    }
    // The curve moves on a day with no transaction at all (market movement).
    expect(res.body.points[1].valueEur).not.toBe(res.body.points[0].valueEur);
  });

  it('serves a custom asset through the real manual provider with carry-forward between value points', async () => {
    // Default harness: the manual provider is local (our own DB), so this is the
    // real end-to-end path with zero network.
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(harness, {
      providerId: 'manual',
      providerRef: 'test-custom-ref',
      type: 'custom',
      symbol: 'HOUSE',
      name: 'My house',
      currency: 'EUR',
      exchange: null,
      ownerId: user.id,
    });
    await harness.db.insert(schema.priceHistory).values([
      { assetId: asset.id, date: dayOffset(-6), close: '1000' },
      { assetId: asset.id, date: dayOffset(-2), close: '1200' },
    ]);
    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 1, price: 1000, executedAt: tsOffset(-6) });

    const res = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(res.status).toBe(200);
    expect(res.body.points).toHaveLength(7);
    for (const point of res.body.points) {
      // The value steps at the second value point and carries forward in between.
      const expected = point.date >= dayOffset(-2) ? 1200 : 1000;
      expect(point.valueEur).toBeCloseTo(expected, 6);
    }
  });

  it('combines market and custom assets into one curve with no special-casing', async () => {
    const closes = marketCloses();
    const marketData = createStubMarketData({
      history: (ref) =>
        ref.providerId === 'manual'
          ? cachedHistory([
              { time: tsOffset(-6), close: 1000 },
              { time: tsOffset(-2), close: 1200 },
            ])
          : cachedHistory(
              [...closes].map(([date, close]) => ({ time: `${date}T00:00:00.000Z`, close })),
            ),
    });
    const h = await createTestApp({ marketData });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const stock = await seedAsset(h, { currency: 'EUR' });
    const house = await seedAsset(h, {
      providerId: 'manual',
      providerRef: 'house-ref',
      type: 'custom',
      symbol: 'HOUSE',
      name: 'My house',
      currency: 'EUR',
      ownerId: user.id,
    });

    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({
        transactions: [
          { assetId: stock.id, side: 'buy', quantity: 2, price: 100, executedAt: tsOffset(-6) },
          { assetId: house.id, side: 'buy', quantity: 1, price: 1000, executedAt: tsOffset(-6) },
        ],
      });

    const res = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(res.status).toBe(200);
    expect(res.body.points).toHaveLength(7);
    for (const point of res.body.points) {
      const houseValue = point.date >= dayOffset(-2) ? 1200 : 1000;
      expect(point.valueEur).toBeCloseTo(2 * closes.get(point.date)! + houseValue, 6);
    }
  });

  it('prefers provider closes over stored rows and fills provider gaps from stored rows', async () => {
    // Provider covers only days −6 … −3; stored rows have a conflicting close on
    // day −5 (must lose to the provider) and a day −1 close (must fill the gap).
    const marketData = createStubMarketData({
      history: () =>
        cachedHistory([-6, -5, -4, -3].map((offset) => ({ time: tsOffset(offset), close: 100 }))),
    });
    const h = await createTestApp({ marketData });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(h, { currency: 'EUR' });
    await h.db.insert(schema.priceHistory).values([
      { assetId: asset.id, date: dayOffset(-5), close: '999' },
      { assetId: asset.id, date: dayOffset(-1), close: '55' },
    ]);

    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 1, price: 100, executedAt: tsOffset(-6) });

    const res = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(res.status).toBe(200);
    const byDate = new Map(
      (res.body.points as Array<{ date: string; valueEur: number }>).map((p) => [p.date, p]),
    );
    expect(byDate.get(dayOffset(-5))!.valueEur).toBeCloseTo(100, 6); // provider wins
    expect(byDate.get(dayOffset(-2))!.valueEur).toBeCloseTo(100, 6); // carry-forward
    expect(byDate.get(dayOffset(-1))!.valueEur).toBeCloseTo(55, 6); // stored fills the gap
    expect(byDate.get(dayOffset(0))!.valueEur).toBeCloseTo(55, 6);
  });
});

describe('GET /api/v1/portfolios/:id/history (2-year reconstruction + overlay, #122)', () => {
  /** CachedResult wrapper for stubbed provider history points. */
  function cachedHistory(points: Array<{ time: string; close: number }>) {
    return { value: points, stale: false, asOf: Date.now() };
  }

  /** UTC weekday (0 = Sunday … 6 = Saturday) of an ISO day. */
  function weekdayOf(day: string): number {
    return new Date(`${day}T00:00:00.000Z`).getUTCDay();
  }

  /**
   * A deterministic **trading-day** fixture over the last two years: one close
   * per weekday from −730 … 0, none on weekends — like a real exchange, so the
   * series must carry Friday's close across Saturday/Sunday.
   */
  function twoYearWeekdayCloses(): Map<string, number> {
    const closes = new Map<string, number>();
    for (let offset = -730; offset <= 0; offset += 1) {
      const day = dayOffset(offset);
      const dow = weekdayOf(day);
      if (dow === 0 || dow === 6) continue;
      closes.set(day, 100 + (offset + 730) * 0.1); // strictly increasing, unique
    }
    return closes;
  }

  /** Expected carried-forward close for `day` (latest fixture close ≤ `day`). */
  function carriedClose(closes: Map<string, number>, day: string): number | null {
    let best: number | null = null;
    for (const [date, close] of closes) if (date <= day) best = close;
    return best;
  }

  function twoYearHarnessStub() {
    const closes = twoYearWeekdayCloses();
    const marketData = createStubMarketData({
      history: () =>
        cachedHistory(
          [...closes].map(([date, close]) => ({ time: `${date}T00:00:00.000Z`, close })),
        ),
    });
    return { closes, marketData };
  }

  it('a buy dated 2 years ago yields a daily series spanning the full range, tracking the real price fixture across weekends', async () => {
    const { closes, marketData } = twoYearHarnessStub();
    const h = await createTestApp({ marketData });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(h, { currency: 'EUR' });

    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({
        assetId: asset.id,
        side: 'buy',
        quantity: 10,
        price: 100,
        executedAt: tsOffset(-730),
      });

    const res = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(res.status).toBe(200);
    expect(portfolioHistoryResponseSchema.safeParse(res.body).success).toBe(true);

    // One point per calendar day from the transaction date to today — 731 days.
    expect(res.body.points).toHaveLength(731);
    expect(res.body.points[0].date).toBe(dayOffset(-730));
    expect(res.body.points[730].date).toBe(dayOffset(0));

    // Every day is valued at 10 × the latest close on or before it: weekdays
    // track the fixture exactly; weekends carry Friday's close forward.
    for (const point of res.body.points as Array<{ date: string; valueEur: number }>) {
      const expected = carriedClose(closes, point.date);
      expect(expected).not.toBeNull();
      expect(point.valueEur).toBeCloseTo(10 * expected!, 6);
    }
    // No overlay requested → no per-asset series in the payload.
    expect(res.body.assets).toBeUndefined();
  });

  it('overlay=true returns each asset own daily price series, date-aligned with the curve', async () => {
    const { closes, marketData } = twoYearHarnessStub();
    const h = await createTestApp({ marketData });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(h, { currency: 'EUR' });

    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({
        assetId: asset.id,
        side: 'buy',
        quantity: 10,
        price: 100,
        executedAt: tsOffset(-730),
      });

    const res = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX&overlay=true`);
    expect(res.status).toBe(200);
    expect(portfolioHistoryResponseSchema.safeParse(res.body).success).toBe(true);

    expect(res.body.assets).toHaveLength(1);
    const overlay = res.body.assets[0];
    expect(overlay.assetId).toBe(asset.id);
    expect(overlay.symbol).toBe('BAYN.DE');
    expect(overlay.currency).toBe('EUR');

    // Point-for-point aligned with the portfolio curve (same daily grid), with
    // the same carry-forward over weekends, in the asset's native prices.
    expect(overlay.points).toHaveLength(res.body.points.length);
    for (let i = 0; i < overlay.points.length; i += 1) {
      expect(overlay.points[i].date).toBe(res.body.points[i].date);
      expect(overlay.points[i].close).toBeCloseTo(carriedClose(closes, overlay.points[i].date)!, 6);
    }
  });

  it('range slicing applies to overlays too, keeping them aligned with the curve', async () => {
    const { marketData } = twoYearHarnessStub();
    const h = await createTestApp({ marketData });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(h, { currency: 'EUR' });

    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({
        assetId: asset.id,
        side: 'buy',
        quantity: 1,
        price: 100,
        executedAt: tsOffset(-730),
      });

    const res = await agent.get(`/api/v1/portfolios/${pid}/history?range=1M&overlay=true`);
    expect(res.status).toBe(200);
    // ~1 month of days, far fewer than the 2-year span.
    expect(res.body.points.length).toBeGreaterThan(20);
    expect(res.body.points.length).toBeLessThan(40);
    expect(res.body.assets[0].points.map((p: { date: string }) => p.date)).toEqual(
      res.body.points.map((p: { date: string }) => p.date),
    );
  });

  it('back-dating a transaction later immediately extends the history (cache invalidated on write)', async () => {
    const { marketData } = twoYearHarnessStub();
    const h = await createTestApp({ marketData });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(h, { currency: 'EUR' });

    // A recent buy first: the series starts a few days ago (and gets cached).
    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 1, price: 170, executedAt: tsOffset(-3) });
    const before = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(before.status).toBe(200);
    expect(before.body.points[0].date).toBe(dayOffset(-3));

    // The owner then records a purchase from two years ago: the very next read
    // must serve the full reconstructed history, not the cached short series.
    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({
        assetId: asset.id,
        side: 'buy',
        quantity: 1,
        price: 100,
        executedAt: tsOffset(-730),
      });
    const after = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(after.status).toBe(200);
    expect(after.body.points[0].date).toBe(dayOffset(-730));
    expect(after.body.points).toHaveLength(731);
  });

  it('rejects an invalid overlay token instead of guessing', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const res = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX&overlay=yes`);
    expect(res.status).toBe(400);
  });
});

describe('first-reference history backfill (§6.2/§9)', () => {
  it('creating transactions enqueues one backfill per distinct history-less asset', async () => {
    const backfill = createRecordingBackfill();
    const h = await createTestApp({ marketData: createStubMarketData(), backfill });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    // Seeded catalog rows: present in `assets`, no `price_history` yet.
    const bayer = await seedAsset(h);
    const apple = await seedAsset(h, { symbol: 'AAPL', providerRef: 'AAPL', currency: 'USD' });

    const res = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({
        transactions: [
          { assetId: bayer.id, side: 'buy', quantity: 2, price: 50, executedAt: tsOffset(-3) },
          { assetId: bayer.id, side: 'buy', quantity: 1, price: 55, executedAt: tsOffset(-2) },
          { assetId: apple.id, side: 'buy', quantity: 4, price: 100, executedAt: tsOffset(-2) },
        ],
      });

    expect(res.status).toBe(201);
    expect([...backfill.enqueued].sort()).toEqual([bayer.id, apple.id].sort());
  });

  it('transacting on an asset that already has price history does not enqueue', async () => {
    const backfill = createRecordingBackfill();
    const h = await createTestApp({ marketData: createStubMarketData(), backfill });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(h);
    await h.db
      .insert(schema.priceHistory)
      .values({ assetId: asset.id, date: dayOffset(-10), close: '48' });

    const res = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 1, price: 50, executedAt: tsOffset(-3) });

    expect(res.status).toBe(201);
    expect(backfill.enqueued).toEqual([]);
  });
});
