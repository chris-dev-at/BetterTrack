import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { customAssetSchema, valuePointsResponseSchema } from '@bettertrack/contracts';

import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

function dayOffset(offset: number): string {
  const ms = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  return new Date(ms + offset * 86_400_000).toISOString().slice(0, 10);
}

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

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

describe('POST /api/v1/custom-assets', () => {
  it('requires authentication', async () => {
    const res = await request(harness.app)
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({ name: 'My House', category: 'real_estate', currency: 'EUR' });
    expect(res.status).toBe(401);
  });

  it('creates a custom asset without an initial purchase', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const res = await agent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({ name: 'My House', category: 'real_estate', currency: 'EUR' });

    expect(res.status).toBe(201);
    expect(customAssetSchema.safeParse(res.body.asset).success).toBe(true);
    expect(res.body.asset.type).toBe('custom');
    expect(res.body.asset.category).toBe('real_estate');
    expect(res.body.transactionId).toBeNull();
  });

  it('records the optional initial purchase as a BUY transaction', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const res = await agent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({
        name: 'Vintage Car',
        category: 'vehicle',
        currency: 'EUR',
        initialPurchase: { quantity: 1, price: 30000, executedAt: tsOffset(-10) },
      });

    expect(res.status).toBe(201);
    expect(res.body.transactionId).not.toBeNull();

    const txns = await agent.get('/api/v1/portfolio/transactions');
    expect(txns.status).toBe(200);
    expect(txns.body.items).toHaveLength(1);
    expect(txns.body.items[0].assetId).toBe(res.body.asset.id);
    expect(txns.body.items[0].side).toBe('buy');
    expect(txns.body.items[0].price).toBe(30000);
  });
});

describe('PATCH/DELETE /api/v1/custom-assets/:id', () => {
  it('updates name and category', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await agent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({ name: 'Coins', category: 'collectible', currency: 'EUR' });
    const id = created.body.asset.id;

    const res = await agent
      .patch(`/api/v1/custom-assets/${id}`)
      .set(...XRW)
      .send({ name: 'Rare Coins', category: 'other' });
    expect(res.status).toBe(200);
    expect(res.body.asset.name).toBe('Rare Coins');
    expect(res.body.asset.category).toBe('other');
  });

  it('deletes a custom asset', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await agent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({ name: 'Boat', category: 'vehicle', currency: 'EUR' });
    const id = created.body.asset.id;

    const del = await agent.delete(`/api/v1/custom-assets/${id}`).set(...XRW);
    expect(del.status).toBe(204);

    const after = await agent.get(`/api/v1/custom-assets/${id}/value-points`);
    expect(after.status).toBe(404);
  });

  it('does not expose another user’s custom asset (IDOR)', async () => {
    const owner = await harness.seedUser({ email: 'owner@bt.test', username: 'owner' });
    const ownerAgent = await loginAgent(harness.app, owner.email, owner.password);
    const created = await ownerAgent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({ name: 'Cottage', category: 'real_estate', currency: 'EUR' });
    const id = created.body.asset.id;

    const intruder = await harness.seedUser({ email: 'evil@bt.test', username: 'evil' });
    const intruderAgent = await loginAgent(harness.app, intruder.email, intruder.password);

    const patch = await intruderAgent
      .patch(`/api/v1/custom-assets/${id}`)
      .set(...XRW)
      .send({ name: 'Mine now' });
    expect(patch.status).toBe(404);

    const points = await intruderAgent.get(`/api/v1/custom-assets/${id}/value-points`);
    expect(points.status).toBe(404);
  });
});

describe('GET/PUT /api/v1/custom-assets/:id/value-points', () => {
  it('replaces the value-point set and rejects duplicate days', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await agent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({ name: 'My House', category: 'real_estate', currency: 'EUR' });
    const id = created.body.asset.id;

    const empty = await agent.get(`/api/v1/custom-assets/${id}/value-points`);
    expect(empty.status).toBe(200);
    expect(empty.body.points).toHaveLength(0);

    const put = await agent
      .put(`/api/v1/custom-assets/${id}/value-points`)
      .set(...XRW)
      .send({
        points: [
          { date: dayOffset(-30), value: 250000 },
          { date: dayOffset(-1), value: 275000 },
        ],
      });
    expect(put.status).toBe(200);
    expect(valuePointsResponseSchema.safeParse(put.body).success).toBe(true);
    expect(put.body.points).toHaveLength(2);

    // A second PUT edits + deletes via the full-set replace.
    const edit = await agent
      .put(`/api/v1/custom-assets/${id}/value-points`)
      .set(...XRW)
      .send({ points: [{ date: dayOffset(-1), value: 300000 }] });
    expect(edit.status).toBe(200);
    expect(edit.body.points).toHaveLength(1);
    expect(edit.body.points[0].value).toBe(300000);

    const dup = await agent
      .put(`/api/v1/custom-assets/${id}/value-points`)
      .set(...XRW)
      .send({
        points: [
          { date: dayOffset(-1), value: 1 },
          { date: dayOffset(-1), value: 2 },
        ],
      });
    expect(dup.status).toBe(400);
    expect(dup.body.error.code).toBe('DUPLICATE_VALUE_POINT');
  });

  it('makes the manual provider reflect the latest value point', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await agent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({ name: 'My House', category: 'real_estate', currency: 'EUR' });
    const id = created.body.asset.id;

    await agent
      .put(`/api/v1/custom-assets/${id}/value-points`)
      .set(...XRW)
      .send({
        points: [
          { date: dayOffset(-2), value: 1000 },
          { date: dayOffset(-1), value: 1200 },
        ],
      });

    const quote = await agent.get(`/api/v1/assets/${id}/quote`);
    expect(quote.status).toBe(200);
    expect(quote.body.quote.price).toBe(1200);
    expect(quote.body.quote.currency).toBe('EUR');
  });

  it('invalidates the portfolio history cache when value points change', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await agent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({
        name: 'My House',
        category: 'real_estate',
        currency: 'EUR',
        initialPurchase: { quantity: 1, price: 250000, executedAt: tsOffset(-5) },
      });
    const id = created.body.asset.id;

    await agent
      .put(`/api/v1/custom-assets/${id}/value-points`)
      .set(...XRW)
      .send({ points: [{ date: dayOffset(-5), value: 250000 }] });

    const first = await agent.get('/api/v1/portfolio/history?range=MAX');
    expect(first.status).toBe(200);
    expect(first.body.points.at(-1).valueEur).toBeCloseTo(250000, 6);

    // Revalue the asset upward; the cached series must be rebuilt.
    await agent
      .put(`/api/v1/custom-assets/${id}/value-points`)
      .set(...XRW)
      .send({ points: [{ date: dayOffset(-5), value: 300000 }] });

    const second = await agent.get('/api/v1/portfolio/history?range=MAX');
    expect(second.status).toBe(200);
    expect(second.body.points.at(-1).valueEur).toBeCloseTo(300000, 6);
  });
});
