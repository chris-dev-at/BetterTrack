import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  CUSTOM_ASSET_CATEGORIES,
  customAssetListResponseSchema,
  customAssetSchema,
  valuePointsResponseSchema,
} from '@bettertrack/contracts';

import { assets } from '../data/schema';
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
      .send({ name: 'My House', category: 'stock', currency: 'EUR' });
    expect(res.status).toBe(401);
  });

  it('creates a custom asset without an initial purchase', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const res = await agent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({ name: 'My House', category: 'stock', currency: 'EUR' });

    expect(res.status).toBe(201);
    expect(customAssetSchema.safeParse(res.body.asset).success).toBe(true);
    expect(res.body.asset.type).toBe('custom');
    expect(res.body.asset.category).toBe('stock');
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
        category: 'commodity',
        currency: 'EUR',
        initialPurchase: { quantity: 1, price: 30000, executedAt: tsOffset(-10) },
      });

    expect(res.status).toBe(201);
    expect(res.body.transactionId).not.toBeNull();

    const portfolios = await agent.get('/api/v1/portfolios');
    const pid = portfolios.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault).id;
    const txns = await agent.get(`/api/v1/portfolios/${pid}/transactions`);
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
      .send({ name: 'Coins', category: 'stock', currency: 'EUR' });
    const id = created.body.asset.id;

    const res = await agent
      .patch(`/api/v1/custom-assets/${id}`)
      .set(...XRW)
      .send({ name: 'Rare Coins', category: 'other' });
    expect(res.status).toBe(200);
    expect(res.body.asset.name).toBe('Rare Coins');
    expect(res.body.asset.category).toBe('other');
  });

  it('falls back to "other" for a stored category outside the enum (#224)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await agent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({ name: 'Coins', category: 'stock', currency: 'EUR' });
    const id = created.body.asset.id;

    // Simulate a row whose stored category predates/postdates the enum (seed,
    // import, manual DB edit, future rename) — not reachable through the API.
    await harness.db
      .update(assets)
      .set({ meta: { category: 'heirloom' } })
      .where(eq(assets.id, id));

    const res = await agent
      .patch(`/api/v1/custom-assets/${id}`)
      .set(...XRW)
      .send({ name: 'Rare Coins' });

    expect(res.status).toBe(200);
    expect(res.body.asset.category).toBe('other');
    expect(customAssetSchema.safeParse(res.body.asset).success).toBe(true);
  });

  it('deletes a custom asset', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await agent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({ name: 'Boat', category: 'commodity', currency: 'EUR' });
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
      .send({ name: 'Cottage', category: 'stock', currency: 'EUR' });
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
      .send({ name: 'My House', category: 'stock', currency: 'EUR' });
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
      .send({ name: 'My House', category: 'stock', currency: 'EUR' });
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
        category: 'stock',
        currency: 'EUR',
        initialPurchase: { quantity: 1, price: 250000, executedAt: tsOffset(-5) },
      });
    const id = created.body.asset.id;

    await agent
      .put(`/api/v1/custom-assets/${id}/value-points`)
      .set(...XRW)
      .send({ points: [{ date: dayOffset(-5), value: 250000 }] });

    const portfolios = await agent.get('/api/v1/portfolios');
    const pid = portfolios.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault).id;
    const first = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(first.status).toBe(200);
    expect(first.body.points.at(-1).valueEur).toBeCloseTo(250000, 6);

    // Revalue the asset upward; the cached series must be rebuilt.
    await agent
      .put(`/api/v1/custom-assets/${id}/value-points`)
      .set(...XRW)
      .send({ points: [{ date: dayOffset(-5), value: 300000 }] });

    const second = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(second.status).toBe(200);
    expect(second.body.points.at(-1).valueEur).toBeCloseTo(300000, 6);
  });
});

describe('custom-asset categories (V3-P2)', () => {
  it('carries the real catalog category onto the holding so grouping is by category', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await agent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({
        name: 'Private Placing',
        category: 'stock',
        currency: 'EUR',
        initialPurchase: { quantity: 1, price: 1000, executedAt: tsOffset(-5) },
      });
    expect(created.status).toBe(201);
    expect(created.body.asset.smoothing).toBe(false);
    expect(created.body.asset.needsRecategorization).toBe(false);

    const portfolios = await agent.get('/api/v1/portfolios');
    const pid = portfolios.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault).id;
    const detail = await agent.get(`/api/v1/portfolios/${pid}`);
    expect(detail.status).toBe(200);
    const holding = detail.body.holdings.find(
      (h: { asset: { id: string } }) => h.asset.id === created.body.asset.id,
    );
    // A custom "stock" is grouped by its real category, not a CUSTOM slice.
    expect(holding.asset.isCustom).toBe(true);
    expect(holding.asset.category).toBe('stock');
    expect(holding.asset.smoothing).toBe(false);
  });

  it('rejects a category outside the catalog taxonomy', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const res = await agent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({ name: 'Old cat', category: 'real_estate', currency: 'EUR' });
    expect(res.status).toBe(400);
  });
});

// Systematic guard for the V3-P2 acceptance criterion (issue #325): *"No CUSTOM
// category/slice remains in any UI or API response."* Prior rounds patched one
// donut surface at a time; this sweep asserts the property holds across the whole
// category enum at the API boundary (the source every grouping surface reads),
// complementing the static `taxonomy/no-custom-category-slice` lint gate.
describe('CUSTOM taxonomy sweep — no legacy/CUSTOM category in any API holding (V3-P2 #325)', () => {
  /** The dead category enum (migration 0022) plus the retired `custom` slice key. */
  const LEGACY_TOKENS = ['real_estate', 'vehicle', 'collectible', 'custom'];

  it('the catalog enum carries none of the legacy/CUSTOM tokens', () => {
    const categories = CUSTOM_ASSET_CATEGORIES as readonly string[];
    for (const token of LEGACY_TOKENS) {
      expect(categories).not.toContain(token);
    }
  });

  it('every catalog category surfaces on the holding as a real bucket (never a CUSTOM slice), and a custom "stock" groups like a market stock', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    // One custom asset per catalog category, each with an initial purchase so it
    // becomes a holding on the default portfolio.
    const assetIdByCategory = new Map<string, string>();
    for (const category of CUSTOM_ASSET_CATEGORIES) {
      const created = await agent
        .post('/api/v1/custom-assets')
        .set(...XRW)
        .send({
          name: `Custom ${category}`,
          category,
          currency: 'EUR',
          initialPurchase: { quantity: 1, price: 1000, executedAt: tsOffset(-5) },
        });
      expect(created.status).toBe(201);
      assetIdByCategory.set(category, created.body.asset.id);
    }

    const portfolios = await agent.get('/api/v1/portfolios');
    const pid = portfolios.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault).id;
    const detail = await agent.get(`/api/v1/portfolios/${pid}`);
    expect(detail.status).toBe(200);

    type HoldingDto = {
      asset: { id: string; type: string; category: string | null; isCustom: boolean };
    };
    const holdings = detail.body.holdings as HoldingDto[];
    // Every category produced its holding — nothing dropped.
    expect(holdings.length).toBe(CUSTOM_ASSET_CATEGORIES.length);

    for (const h of holdings) {
      // The exact grouping key every donut surface computes.
      const groupingKey = h.asset.category ?? h.asset.type;
      expect(LEGACY_TOKENS).not.toContain(h.asset.category);
      expect(LEGACY_TOKENS).not.toContain(groupingKey);
      // A custom holding's category is always a real catalog bucket.
      if (h.asset.isCustom) {
        expect(CUSTOM_ASSET_CATEGORIES as readonly string[]).toContain(h.asset.category);
      }
    }

    // Each custom asset grouped under its own real catalog category.
    for (const [category, assetId] of assetIdByCategory) {
      const holding = holdings.find((h) => h.asset.id === assetId);
      expect(holding, `holding for custom ${category} present`).toBeTruthy();
      expect(holding!.asset.category).toBe(category);
    }

    // Phase invariant: a custom "stock" carries the same grouping key a market
    // stock's `type` would ('stock'), so the two merge into one Stocks slice —
    // never a separate CUSTOM slice.
    const customStock = holdings.find((h) => h.asset.id === assetIdByCategory.get('stock'));
    expect(customStock!.asset.category ?? customStock!.asset.type).toBe('stock');
  });
});

describe('value smoothing takes effect in every series reconstruction (V3-P2)', () => {
  async function setup() {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await agent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({
        name: 'Smoothed House',
        category: 'other',
        currency: 'EUR',
        initialPurchase: { quantity: 1, price: 100, executedAt: tsOffset(-25) },
      });
    const id = created.body.asset.id;
    await agent
      .put(`/api/v1/custom-assets/${id}/value-points`)
      .set(...XRW)
      .send({
        points: [
          { date: dayOffset(-20), value: 100 },
          { date: dayOffset(-10), value: 200 },
        ],
      });
    const portfolios = await agent.get('/api/v1/portfolios');
    const pid = portfolios.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault).id;
    return { agent, id, pid };
  }

  function valueOn(body: { points: { date: string; valueEur: number }[] }, date: string) {
    return body.points.find((p) => p.date === date)?.valueEur;
  }

  it('steps between marks by default, interpolates once toggled on — mark days stay exact', async () => {
    const { agent, id, pid } = await setup();

    // Default (off): the mid-gap day carries the last mark forward (step = 100).
    const step = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(step.status).toBe(200);
    expect(valueOn(step.body, dayOffset(-15))).toBeCloseTo(100, 6);
    expect(valueOn(step.body, dayOffset(-20))).toBeCloseTo(100, 6);
    expect(valueOn(step.body, dayOffset(-10))).toBeCloseTo(200, 6);

    // Toggle smoothing on: the mid-gap day is now the linear midpoint (150),
    // and the cached series was invalidated so the change is visible at once.
    const patch = await agent
      .patch(`/api/v1/custom-assets/${id}`)
      .set(...XRW)
      .send({ smoothing: true });
    expect(patch.status).toBe(200);
    expect(patch.body.asset.smoothing).toBe(true);

    const smooth = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(valueOn(smooth.body, dayOffset(-15))).toBeCloseTo(150, 4);
    // Mark-day valuations are unchanged by smoothing.
    expect(valueOn(smooth.body, dayOffset(-20))).toBeCloseTo(100, 6);
    expect(valueOn(smooth.body, dayOffset(-10))).toBeCloseTo(200, 6);
  });
});

describe('re-categorize banner status (V3-P2)', () => {
  it('counts flagged assets, clears on re-categorize and on dismissal', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await agent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({ name: 'Legacy', category: 'other', currency: 'EUR' });
    const id = created.body.asset.id;

    // Fresh assets never carry the flag.
    let status = await agent.get('/api/v1/custom-assets/recategorization');
    expect(status.status).toBe(200);
    expect(status.body.pending).toBe(0);

    // Simulate what the 0022 migration does to pre-existing custom assets.
    await harness.db
      .update(assets)
      .set({ meta: { category: 'other', recategorize: true } })
      .where(eq(assets.id, id));

    status = await agent.get('/api/v1/custom-assets/recategorization');
    expect(status.body.pending).toBe(1);

    // Re-categorizing the asset clears its own flag.
    const patch = await agent
      .patch(`/api/v1/custom-assets/${id}`)
      .set(...XRW)
      .send({ category: 'stock' });
    expect(patch.status).toBe(200);
    expect(patch.body.asset.needsRecategorization).toBe(false);
    status = await agent.get('/api/v1/custom-assets/recategorization');
    expect(status.body.pending).toBe(0);

    // Re-flag, then dismiss the banner: the flag clears across the board.
    await harness.db
      .update(assets)
      .set({ meta: { category: 'other', recategorize: true } })
      .where(eq(assets.id, id));
    expect((await agent.get('/api/v1/custom-assets/recategorization')).body.pending).toBe(1);

    const dismiss = await agent.post('/api/v1/custom-assets/recategorization/dismiss').set(...XRW);
    expect(dismiss.status).toBe(204);
    expect((await agent.get('/api/v1/custom-assets/recategorization')).body.pending).toBe(0);
  });
});

describe('GET /api/v1/custom-assets', () => {
  it('requires authentication', async () => {
    const res = await request(harness.app).get('/api/v1/custom-assets');
    expect(res.status).toBe(401);
  });

  it('lists all custom assets, including ones with zero holdings and no value points', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    // Asset A: has value points → latestValue is the most recent one.
    const a = await agent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({ name: 'House', category: 'stock', currency: 'EUR' });
    await agent
      .put(`/api/v1/custom-assets/${a.body.asset.id}/value-points`)
      .set(...XRW)
      .send({
        points: [
          { date: dayOffset(-2), value: 1000 },
          { date: dayOffset(-1), value: 1200 },
        ],
      });

    // Asset B: never bought, never valued → still listed, latestValue null.
    const b = await agent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({ name: 'Amp', category: 'other', currency: 'USD' });

    const res = await agent.get('/api/v1/custom-assets').set(...XRW);
    expect(res.status).toBe(200);
    expect(customAssetListResponseSchema.safeParse(res.body).success).toBe(true);

    const byId = new Map(
      res.body.assets.map((it: { id: string }) => [it.id, it] as const),
    );
    expect(byId.size).toBe(2);

    const itemA = byId.get(a.body.asset.id) as { latestValue: { date: string; value: number } };
    expect(itemA.latestValue).toEqual({ date: dayOffset(-1), value: 1200 });

    const itemB = byId.get(b.body.asset.id) as {
      latestValue: unknown;
      category: string;
      currency: string;
    };
    expect(itemB.latestValue).toBeNull();
    expect(itemB.category).toBe('other');
    expect(itemB.currency).toBe('USD');
  });

  it('works with a portfolio:read bearer token', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    await agent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({ name: 'Boat', category: 'commodity', currency: 'EUR' });

    const key = await agent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'mobile', scopes: ['portfolio:read'] });
    expect(key.status).toBe(201);
    const token = key.body.token as string;

    const res = await request(harness.app)
      .get('/api/v1/custom-assets')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.assets).toHaveLength(1);
    expect(res.body.assets[0].name).toBe('Boat');
  });

  it('never returns another user’s custom assets (cross-user isolation)', async () => {
    const owner = await harness.seedUser({ email: 'owner2@bt.test', username: 'owner2' });
    const ownerAgent = await loginAgent(harness.app, owner.email, owner.password);
    await ownerAgent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({ name: 'Secret House', category: 'stock', currency: 'EUR' });

    const other = await harness.seedUser({ email: 'other2@bt.test', username: 'other2' });
    const otherAgent = await loginAgent(harness.app, other.email, other.password);

    const res = await otherAgent.get('/api/v1/custom-assets').set(...XRW);
    expect(res.status).toBe(200);
    expect(res.body.assets).toEqual([]);
  });
});
