import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { searchResponseSchema } from '@bettertrack/contracts';

import { eq } from 'drizzle-orm';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';
import {
  createRecordingBackfill,
  createStubMarketData,
  providerHit,
  type RecordingBackfill,
} from '../testing/marketDataStubs';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

async function loginAgent(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

/** Count asset rows for a provider ref (global market assets in these tests). */
async function countGlobal(h: TestHarness, providerRef: string): Promise<number> {
  const rows = await h.db
    .select({ id: schema.assets.id })
    .from(schema.assets)
    .where(eq(schema.assets.providerRef, providerRef));
  return rows.length;
}

describe('GET /api/v1/search', () => {
  let backfill: RecordingBackfill;

  beforeEach(() => {
    backfill = createRecordingBackfill();
  });

  it('requires authentication', async () => {
    const h = await createTestApp({ marketData: createStubMarketData(), backfill });
    const res = await request(h.app).get('/api/v1/search?q=apple');
    expect(res.status).toBe(401);
  });

  it('rejects a query shorter than 2 characters', async () => {
    const h = await createTestApp({ marketData: createStubMarketData(), backfill });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get('/api/v1/search?q=a');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('merges provider results with the caller’s matching custom assets', async () => {
    const marketData = createStubMarketData({
      search: () => [
        providerHit({ providerRef: 'AAPL', symbol: 'AAPL', name: 'Apple Inc.' }),
        providerHit({ providerRef: 'MSFT', symbol: 'MSFT', name: 'Microsoft' }),
      ],
    });
    const h = await createTestApp({ marketData, backfill });
    const user = await h.seedUser();

    // A custom asset of this user whose name matches the query.
    const [custom] = await h.db
      .insert(schema.assets)
      .values({
        providerId: 'manual',
        providerRef: 'custom-apple-house',
        ownerId: user.id,
        type: 'custom',
        symbol: 'HOUSE',
        name: 'Apple Street House',
        currency: 'EUR',
      })
      .returning();

    const agent = await loginAgent(h.app, user.email, user.password);
    const res = await agent.get('/api/v1/search?q=apple');
    expect(res.status).toBe(200);

    const parsed = searchResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const results = parsed.data.results;
    // Two provider hits + one custom match.
    expect(results).toHaveLength(3);

    const market = results.filter((r) => !r.isCustom);
    const custom2 = results.filter((r) => r.isCustom);
    expect(market.map((r) => r.symbol).sort()).toEqual(['AAPL', 'MSFT']);
    expect(custom2).toHaveLength(1);
    expect(custom2[0]!.id).toBe(custom!.id);
    expect(custom2[0]!.name).toBe('Apple Street House');

    // Every result carries a materialized asset id.
    for (const r of results) expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('first-touch upserts each provider hit and enqueues exactly one backfill', async () => {
    const marketData = createStubMarketData({
      search: () => [
        providerHit({ providerRef: 'AAPL', symbol: 'AAPL', name: 'Apple Inc.' }),
        providerHit({ providerRef: 'MSFT', symbol: 'MSFT', name: 'Microsoft' }),
      ],
    });
    const h = await createTestApp({ marketData, backfill });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await agent.get('/api/v1/search?q=apple');
    expect(res.status).toBe(200);

    // One global row per provider ref, and one backfill enqueued per new asset.
    expect(await countGlobal(h, 'AAPL')).toBe(1);
    expect(await countGlobal(h, 'MSFT')).toBe(1);
    expect(backfill.enqueued).toHaveLength(2);

    // The enqueued ids are the materialized asset ids.
    const ids = res.body.results.map((r: { id: string }) => r.id).sort();
    expect([...backfill.enqueued].sort()).toEqual(ids);
  });

  it('is idempotent: a repeated search upserts no new rows and enqueues no new backfills', async () => {
    const marketData = createStubMarketData({
      search: () => [providerHit({ providerRef: 'AAPL', symbol: 'AAPL', name: 'Apple Inc.' })],
    });
    const h = await createTestApp({ marketData, backfill });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);

    const first = await agent.get('/api/v1/search?q=apple');
    expect(first.status).toBe(200);
    const firstId = first.body.results[0].id as string;

    const second = await agent.get('/api/v1/search?q=apple');
    expect(second.status).toBe(200);
    const secondId = second.body.results[0].id as string;

    // Same row reused, no duplicate global asset, exactly one backfill total.
    expect(secondId).toBe(firstId);
    expect(await countGlobal(h, 'AAPL')).toBe(1);
    expect(backfill.enqueued).toEqual([firstId]);
  });

  it('shares one global row across users and still enqueues only one backfill', async () => {
    const marketData = createStubMarketData({
      search: () => [providerHit({ providerRef: 'AAPL', symbol: 'AAPL', name: 'Apple Inc.' })],
    });
    const h = await createTestApp({ marketData, backfill });
    const userA = await h.seedUser({ email: 'a@s.test', username: 'sa' });
    const userB = await h.seedUser({ email: 'b@s.test', username: 'sb' });
    const agentA = await loginAgent(h.app, userA.email, userA.password);
    const agentB = await loginAgent(h.app, userB.email, userB.password);

    const ra = await agentA.get('/api/v1/search?q=apple');
    const rb = await agentB.get('/api/v1/search?q=apple');
    expect(ra.body.results[0].id).toBe(rb.body.results[0].id);
    expect(await countGlobal(h, 'AAPL')).toBe(1);
    expect(backfill.enqueued).toHaveLength(1);
  });

  it('does not surface another user’s custom assets', async () => {
    const h = await createTestApp({ marketData: createStubMarketData(), backfill });
    const owner = await h.seedUser({ email: 'owner@s.test', username: 'owner' });
    const other = await h.seedUser({ email: 'other@s.test', username: 'other' });

    await h.db.insert(schema.assets).values({
      providerId: 'manual',
      providerRef: 'owner-apple',
      ownerId: owner.id,
      type: 'custom',
      symbol: 'OWN',
      name: 'Apple Private',
      currency: 'EUR',
    });

    const agent = await loginAgent(h.app, other.email, other.password);
    const res = await agent.get('/api/v1/search?q=apple');
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(0);
  });

  it('skips failing providers and returns only custom matches', async () => {
    // marketData.search throwing models the service-level fan-out already having
    // dropped a sick provider; here the whole fan-out yields nothing.
    const marketData = createStubMarketData({ search: () => [] });
    const h = await createTestApp({ marketData, backfill });
    const user = await h.seedUser();
    await h.db.insert(schema.assets).values({
      providerId: 'manual',
      providerRef: 'mine-apple',
      ownerId: user.id,
      type: 'custom',
      symbol: 'MINE',
      name: 'Apple Mine',
      currency: 'EUR',
    });

    const agent = await loginAgent(h.app, user.email, user.password);
    const res = await agent.get('/api/v1/search?q=apple');
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].isCustom).toBe(true);
    expect(backfill.enqueued).toHaveLength(0);
  });

  it('does not match custom assets by an unrelated query (LIKE-escaped)', async () => {
    const h = await createTestApp({ marketData: createStubMarketData(), backfill });
    const user = await h.seedUser();
    await h.db.insert(schema.assets).values({
      providerId: 'manual',
      providerRef: 'house-1',
      ownerId: user.id,
      type: 'custom',
      symbol: 'H',
      name: 'Lake House',
      currency: 'EUR',
    });

    const agent = await loginAgent(h.app, user.email, user.password);
    // '%%' must be treated literally, not as wildcards that match everything.
    const res = await agent.get('/api/v1/search?q=%25%25');
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(0);
  });
});
