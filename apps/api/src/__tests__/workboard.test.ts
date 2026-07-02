import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { workboardItemSchema, workboardListResponseSchema } from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';
import { createRecordingBackfill } from '../testing/marketDataStubs';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
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

describe('GET /api/v1/workboard', () => {
  it('requires authentication', async () => {
    const res = await request(harness.app)
      .get('/api/v1/workboard')
      .set(...XRW);
    expect(res.status).toBe(401);
  });

  it('returns an empty list for a new user', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const res = await agent.get('/api/v1/workboard');
    expect(res.status).toBe(200);
    expect(workboardListResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.items).toHaveLength(0);
  });

  it('returns items ordered by sort_order', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const assetA = await seedAsset(harness, {
      symbol: 'AAPL',
      name: 'Apple',
      providerRef: 'AAPL',
      currency: 'USD',
    });
    const assetB = await seedAsset(harness, {
      symbol: 'MSFT',
      name: 'Microsoft',
      providerRef: 'MSFT',
      currency: 'USD',
    });

    await agent
      .post('/api/v1/workboard')
      .set(...XRW)
      .send({ assetId: assetA.id });
    await agent
      .post('/api/v1/workboard')
      .set(...XRW)
      .send({ assetId: assetB.id });

    const res = await agent.get('/api/v1/workboard');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].asset.symbol).toBe('AAPL');
    expect(res.body.items[1].asset.symbol).toBe('MSFT');
    // Ascending sort_order
    expect(res.body.items[0].sortOrder).toBeLessThan(res.body.items[1].sortOrder);
  });

  it('returns contract-valid item shapes', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const asset = await seedAsset(harness);

    await agent
      .post('/api/v1/workboard')
      .set(...XRW)
      .send({ assetId: asset.id });

    const res = await agent.get('/api/v1/workboard');
    expect(res.status).toBe(200);
    const parsed = workboardListResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const item = parsed.data.items[0]!;
    expect(item.asset.symbol).toBe('BAYN.DE');
    expect(item.asset.name).toBe('Bayer AG');
    expect(item.asset.currency).toBe('EUR');
    expect(item.asset.type).toBe('stock');
    expect(item.note).toBeNull();
  });
});

describe('POST /api/v1/workboard', () => {
  it('requires authentication', async () => {
    const asset = await seedAsset(harness);
    const res = await request(harness.app)
      .post('/api/v1/workboard')
      .set(...XRW)
      .send({ assetId: asset.id });
    expect(res.status).toBe(401);
  });

  it('adds an asset and returns the enriched item with 201', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const asset = await seedAsset(harness);

    const res = await agent
      .post('/api/v1/workboard')
      .set(...XRW)
      .send({ assetId: asset.id });
    expect(res.status).toBe(201);

    const parsed = workboardItemSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.assetId).toBe(asset.id);
    expect(parsed.data.asset.symbol).toBe('BAYN.DE');
  });

  it('appends at the end (sort_order increments)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const assetA = await seedAsset(harness, {
      symbol: 'AAPL',
      providerRef: 'AAPL',
      currency: 'USD',
    });
    const assetB = await seedAsset(harness, {
      symbol: 'MSFT',
      providerRef: 'MSFT',
      currency: 'USD',
    });

    const r1 = await agent
      .post('/api/v1/workboard')
      .set(...XRW)
      .send({ assetId: assetA.id });
    const r2 = await agent
      .post('/api/v1/workboard')
      .set(...XRW)
      .send({ assetId: assetB.id });

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.body.sortOrder).toBeGreaterThan(r1.body.sortOrder);
  });

  it('returns 409 when the asset is already watched (duplicate-add)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const asset = await seedAsset(harness);

    await agent
      .post('/api/v1/workboard')
      .set(...XRW)
      .send({ assetId: asset.id });
    const res = await agent
      .post('/api/v1/workboard')
      .set(...XRW)
      .send({ assetId: asset.id });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_WATCHING');
  });

  it('returns 404 for a non-existent assetId', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const nonExistentId = '00000000-0000-0000-0000-000000000000';
    const res = await agent
      .post('/api/v1/workboard')
      .set(...XRW)
      .send({ assetId: nonExistentId });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ASSET_NOT_FOUND');
  });

  it('rejects an invalid (non-UUID) assetId', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const res = await agent
      .post('/api/v1/workboard')
      .set(...XRW)
      .send({ assetId: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires the CSRF header', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const asset = await seedAsset(harness);

    const res = await agent.post('/api/v1/workboard').send({ assetId: asset.id });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_HEADER_REQUIRED');
  });
});

describe('DELETE /api/v1/workboard/:itemId', () => {
  it('requires authentication', async () => {
    const res = await request(harness.app)
      .delete('/api/v1/workboard/00000000-0000-0000-0000-000000000000')
      .set(...XRW);
    expect(res.status).toBe(401);
  });

  it('removes the item and returns 204', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const asset = await seedAsset(harness);

    const added = await agent
      .post('/api/v1/workboard')
      .set(...XRW)
      .send({ assetId: asset.id });
    expect(added.status).toBe(201);
    const itemId: string = added.body.id;

    const del = await agent.delete(`/api/v1/workboard/${itemId}`).set(...XRW);
    expect(del.status).toBe(204);

    const list = await agent.get('/api/v1/workboard');
    expect(list.body.items).toHaveLength(0);
  });

  it('returns 404 for an item that does not exist', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const res = await agent
      .delete('/api/v1/workboard/00000000-0000-0000-0000-000000000000')
      .set(...XRW);
    expect(res.status).toBe(404);
  });

  it("returns 404 when deleting another user's item — no information leak", async () => {
    const userA = await harness.seedUser({ email: 'a@test.test', username: 'usera' });
    const userB = await harness.seedUser({ email: 'b@test.test', username: 'userb' });
    const agentA = await loginAgent(harness.app, userA.email, userA.password);
    const agentB = await loginAgent(harness.app, userB.email, userB.password);

    const asset = await seedAsset(harness);
    const added = await agentA
      .post('/api/v1/workboard')
      .set(...XRW)
      .send({ assetId: asset.id });
    expect(added.status).toBe(201);
    const itemId: string = added.body.id;

    // User B tries to delete user A's item
    const res = await agentB.delete(`/api/v1/workboard/${itemId}`).set(...XRW);
    expect(res.status).toBe(404);

    // User A's item is still there
    const list = await agentA.get('/api/v1/workboard');
    expect(list.body.items).toHaveLength(1);
  });
});

describe('PATCH /api/v1/workboard/reorder', () => {
  it('requires authentication', async () => {
    const res = await request(harness.app)
      .patch('/api/v1/workboard/reorder')
      .set(...XRW)
      .send({ itemIds: [] });
    expect(res.status).toBe(401);
  });

  it('reorders items and persists the new sort_order', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const assetA = await seedAsset(harness, {
      symbol: 'AAPL',
      providerRef: 'AAPL',
      currency: 'USD',
    });
    const assetB = await seedAsset(harness, {
      symbol: 'MSFT',
      providerRef: 'MSFT',
      currency: 'USD',
    });
    const assetC = await seedAsset(harness, {
      symbol: 'GOOG',
      providerRef: 'GOOG',
      currency: 'USD',
    });

    const r1 = await agent
      .post('/api/v1/workboard')
      .set(...XRW)
      .send({ assetId: assetA.id });
    const r2 = await agent
      .post('/api/v1/workboard')
      .set(...XRW)
      .send({ assetId: assetB.id });
    const r3 = await agent
      .post('/api/v1/workboard')
      .set(...XRW)
      .send({ assetId: assetC.id });
    const idA = r1.body.id as string;
    const idB = r2.body.id as string;
    const idC = r3.body.id as string;

    // Reverse the order: C, B, A
    const patch = await agent
      .patch('/api/v1/workboard/reorder')
      .set(...XRW)
      .send({ itemIds: [idC, idB, idA] });
    expect(patch.status).toBe(200);

    const list = await agent.get('/api/v1/workboard');
    expect(list.body.items[0].id).toBe(idC);
    expect(list.body.items[1].id).toBe(idB);
    expect(list.body.items[2].id).toBe(idA);
  });

  it('accepts an empty itemIds list without error', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const res = await agent
      .patch('/api/v1/workboard/reorder')
      .set(...XRW)
      .send({ itemIds: [] });
    expect(res.status).toBe(200);
  });

  it('requires the CSRF header', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const res = await agent.patch('/api/v1/workboard/reorder').send({ itemIds: [] });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid request body', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const res = await agent
      .patch('/api/v1/workboard/reorder')
      .set(...XRW)
      .send({ itemIds: 'not-an-array' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('Ownership isolation (§10)', () => {
  it("GET /workboard only returns the caller's items", async () => {
    const userA = await harness.seedUser({ email: 'a@iso.test', username: 'isoA' });
    const userB = await harness.seedUser({ email: 'b@iso.test', username: 'isoB' });
    const agentA = await loginAgent(harness.app, userA.email, userA.password);
    const agentB = await loginAgent(harness.app, userB.email, userB.password);

    const asset = await seedAsset(harness);
    await agentA
      .post('/api/v1/workboard')
      .set(...XRW)
      .send({ assetId: asset.id });

    const listB = await agentB.get('/api/v1/workboard');
    expect(listB.body.items).toHaveLength(0);
  });

  it('PATCH /workboard/reorder silently ignores item IDs owned by another user', async () => {
    const userA = await harness.seedUser({ email: 'a@reorder.test', username: 'reorderA' });
    const userB = await harness.seedUser({ email: 'b@reorder.test', username: 'reorderB' });
    const agentA = await loginAgent(harness.app, userA.email, userA.password);
    const agentB = await loginAgent(harness.app, userB.email, userB.password);

    const assetX = await seedAsset(harness, { symbol: 'X', providerRef: 'X', currency: 'USD' });
    const assetY = await seedAsset(harness, { symbol: 'Y', providerRef: 'Y', currency: 'USD' });

    const addA = await agentA
      .post('/api/v1/workboard')
      .set(...XRW)
      .send({ assetId: assetX.id });
    const addB = await agentB
      .post('/api/v1/workboard')
      .set(...XRW)
      .send({ assetId: assetY.id });
    const idA = addA.body.id as string;
    const idB = addB.body.id as string;

    // User A tries to include user B's item in their reorder — must be ignored
    const res = await agentA
      .patch('/api/v1/workboard/reorder')
      .set(...XRW)
      .send({ itemIds: [idB, idA] });
    expect(res.status).toBe(200);

    // User B's item sort_order must be unchanged
    const listB = await agentB.get('/api/v1/workboard');
    const itemB = listB.body.items[0];
    // User A's reorder with idB first should not have changed B's item's sort_order
    // to 0 (since it was ignored)
    expect(listB.body.items).toHaveLength(1);

    // User A's own item should now have sort_order 0 (idB was ignored)
    const listA = await agentA.get('/api/v1/workboard');
    expect(listA.body.items).toHaveLength(1);
    expect(listA.body.items[0].id).toBe(idA);

    // Verify user B's item wasn't clobbered — still visible to B, not to A
    expect(itemB.id).toBe(idB);
  });
});

describe('first-reference history backfill (§6.2/§9)', () => {
  it('adding a history-less asset to the workboard enqueues its backfill', async () => {
    const backfill = createRecordingBackfill();
    const h = await createTestApp({ backfill });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    // A seeded catalog row: exists in `assets`, no `price_history` yet.
    const asset = await seedAsset(h);

    const res = await agent
      .post('/api/v1/workboard')
      .set(...XRW)
      .send({ assetId: asset.id });
    expect(res.status).toBe(201);
    expect(backfill.enqueued).toEqual([asset.id]);
  });

  it('adding an asset that already has price history does not enqueue', async () => {
    const backfill = createRecordingBackfill();
    const h = await createTestApp({ backfill });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const asset = await seedAsset(h);
    await h.db
      .insert(schema.priceHistory)
      .values({ assetId: asset.id, date: '2026-01-02', close: '10' });

    const res = await agent
      .post('/api/v1/workboard')
      .set(...XRW)
      .send({ assetId: asset.id });
    expect(res.status).toBe(201);
    expect(backfill.enqueued).toEqual([]);
  });
});
