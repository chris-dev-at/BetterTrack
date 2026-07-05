import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { allocateResponseSchema, type AllocateResponse } from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createStubMarketData, type StubMarketDataControls } from '../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * `POST /conglomerates/:id/allocate` — the Invest Calculator seam (§6.7). The
 * pure engine `domain/allocation.ts` is exercised in its own unit suite; here we
 * assert the orchestration: owner-scoping, EUR conversion of live quotes before
 * the engine, the §6.7 worked example end-to-end, the never-overshoot invariant
 * over the wire, whole vs. fractional, and stale-quote surfacing.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const MISSING_ID = '00000000-0000-0000-0000-000000000000';

/** A `CachedResult<Quote>` for a stubbed spot quote in `currency`. */
function cachedQuote(price: number, opts: { currency?: string; stale?: boolean } = {}) {
  return {
    value: {
      price,
      currency: opts.currency ?? 'EUR',
      prevClose: null,
      asOf: new Date().toISOString(),
    },
    stale: opts.stale ?? false,
    asOf: Date.now(),
  };
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

let assetSeq = 0;
async function seedAsset(
  h: TestHarness,
  overrides: Partial<typeof schema.assets.$inferInsert> = {},
) {
  assetSeq += 1;
  const symbol = overrides.symbol ?? `SYM${assetSeq}`;
  const [row] = await h.db
    .insert(schema.assets)
    .values({
      providerId: overrides.providerId ?? 'yahoo',
      providerRef: overrides.providerRef ?? symbol,
      type: overrides.type ?? 'stock',
      symbol,
      name: overrides.name ?? `Asset ${symbol}`,
      currency: overrides.currency ?? 'EUR',
      exchange: overrides.exchange ?? 'XETRA',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('Failed to seed asset');
  return row;
}

type Agent = ReturnType<typeof request.agent>;

/** Create a conglomerate and bulk-set its positions; returns its id. */
async function seedConglomerate(
  agent: Agent,
  name: string,
  positions: Array<{ assetId: string; weightPct: number }>,
): Promise<string> {
  const created = await agent
    .post('/api/v1/conglomerates')
    .set(...XRW)
    .send({ name });
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  const put = await agent
    .put(`/api/v1/conglomerates/${id}/positions`)
    .set(...XRW)
    .send({ positions });
  expect(put.status).toBe(200);
  return id;
}

/** A logged-in harness whose provider quotes are served by `quote`. */
async function harnessWith(quote: StubMarketDataControls['quote']) {
  const marketData = createStubMarketData({ quote });
  const h = await createTestApp({ marketData });
  const user = await h.seedUser();
  const agent = await loginAgent(h.app, user.email, user.password);
  return { h, agent, marketData };
}

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

describe('POST /api/v1/conglomerates/:id/allocate', () => {
  it('requires authentication', async () => {
    const res = await request(harness.app)
      .post(`/api/v1/conglomerates/${MISSING_ID}/allocate`)
      .set(...XRW)
      .send({ budgetEur: 1000, mode: 'whole' });
    expect(res.status).toBe(401);
  });

  it('reproduces the §6.7 worked example (1000 € → BAYN 12 / NVDA 4 / GOOGL 0)', async () => {
    // Illustrative EUR prices: BAYN.DE 30 % @ 25 €, NVDA 60 % @ 150 €, GOOGL 10 % @ 140 €.
    const prices: Record<string, number> = { BAYN: 25, NVDA: 150, GOOGL: 140 };
    const { h, agent } = await harnessWith((ref) => cachedQuote(prices[ref.providerRef]!));

    const bayn = await seedAsset(h, { symbol: 'BAYN', providerRef: 'BAYN', name: 'Bayer AG' });
    const nvda = await seedAsset(h, { symbol: 'NVDA', providerRef: 'NVDA', name: 'NVIDIA' });
    const googl = await seedAsset(h, { symbol: 'GOOGL', providerRef: 'GOOGL', name: 'Alphabet' });

    const id = await seedConglomerate(agent, 'Worked Example', [
      { assetId: bayn.id, weightPct: 30 },
      { assetId: nvda.id, weightPct: 60 },
      { assetId: googl.id, weightPct: 10 },
    ]);

    const res = await agent
      .post(`/api/v1/conglomerates/${id}/allocate`)
      .set(...XRW)
      .send({ budgetEur: 1000, mode: 'whole' });

    expect(res.status).toBe(200);
    const parsed = allocateResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    const body = res.body as AllocateResponse;

    const byId = new Map(body.positions.map((p) => [p.assetId, p]));
    expect(byId.get(bayn.id)!.qty).toBe(12);
    expect(byId.get(bayn.id)!.costEur).toBeCloseTo(300, 9);
    expect(byId.get(nvda.id)!.qty).toBe(4);
    expect(byId.get(nvda.id)!.costEur).toBeCloseTo(600, 9);
    expect(byId.get(googl.id)!.qty).toBe(0);
    expect(byId.get(googl.id)!.costEur).toBe(0);

    // GOOGL is unreachable — surfaced with a note, not silently mis-weighted.
    expect(byId.get(googl.id)!.note).toBeDefined();
    expect(byId.get(googl.id)!.note).toContain('GOOGL');
    expect(body.warnings).toContain(byId.get(googl.id)!.note);
    // 140 € < 1000 € budget, so GOOGL is reachable in principle → not "unbuyable".
    expect(byId.get(googl.id)!.unbuyable).toBeUndefined();

    expect(body.totalCostEur).toBeCloseTo(900, 9);
    expect(body.leftoverEur).toBeCloseTo(100, 9);
    expect(body.totalCostEur).toBeLessThanOrEqual(1000);
    expect(body.stale).toBe(false);
    expect(body.quoteNotice).toBeNull();
  });

  it('never overshoots the budget, and fractional mode reaches the small slice', async () => {
    const prices: Record<string, number> = { BAYN: 25, NVDA: 150, GOOGL: 140 };
    const { h, agent } = await harnessWith((ref) => cachedQuote(prices[ref.providerRef]!));

    const bayn = await seedAsset(h, { symbol: 'BAYN', providerRef: 'BAYN' });
    const nvda = await seedAsset(h, { symbol: 'NVDA', providerRef: 'NVDA' });
    const googl = await seedAsset(h, { symbol: 'GOOGL', providerRef: 'GOOGL' });
    const id = await seedConglomerate(agent, 'Fractional', [
      { assetId: bayn.id, weightPct: 30 },
      { assetId: nvda.id, weightPct: 60 },
      { assetId: googl.id, weightPct: 10 },
    ]);

    const res = await agent
      .post(`/api/v1/conglomerates/${id}/allocate`)
      .set(...XRW)
      .send({ budgetEur: 1000, mode: 'fractional' });

    expect(res.status).toBe(200);
    const body = res.body as AllocateResponse;

    // Never overshoot (§6.7 hard guarantee), even in fractional mode.
    expect(body.totalCostEur).toBeLessThanOrEqual(1000);
    // Fractional buying reaches GOOGL's 10 % slice that whole shares could not.
    const googlLine = body.positions.find((p) => p.assetId === googl.id)!;
    expect(googlLine.qty).toBeGreaterThan(0);
    expect(googlLine.note).toBeUndefined();
    // Full precision retained: sum of per-position costs equals the total.
    const sum = body.positions.reduce((acc, p) => acc + p.costEur, 0);
    expect(sum).toBeCloseTo(body.totalCostEur, 9);
  });

  it('EUR-converts a non-EUR quote before allocating (FX applied, not the raw price)', async () => {
    // USD asset priced at 100 USD; EURUSD=X = 2 (2 USD per 1 EUR) ⇒ 50 € per share.
    // A 1000 € whole-share allocation therefore buys 20 shares, not the 10 it would
    // buy if the raw 100 (mistaken for EUR) reached the engine unconverted.
    const { h, agent } = await harnessWith((ref) => {
      if (ref.providerRef === 'EURUSD=X') return cachedQuote(2, { currency: 'USD' });
      return cachedQuote(100, { currency: 'USD' });
    });
    const usd = await seedAsset(h, { symbol: 'USDX', providerRef: 'USDX', currency: 'USD' });
    const id = await seedConglomerate(agent, 'FX', [{ assetId: usd.id, weightPct: 100 }]);

    const res = await agent
      .post(`/api/v1/conglomerates/${id}/allocate`)
      .set(...XRW)
      .send({ budgetEur: 1000, mode: 'whole' });

    expect(res.status).toBe(200);
    const body = res.body as AllocateResponse;
    expect(body.positions[0]!.qty).toBe(20);
    expect(body.positions[0]!.costEur).toBeCloseTo(1000, 9);
    expect(body.totalCostEur).toBeLessThanOrEqual(1000);
  });

  it('surfaces a stale quote as a flag/notice rather than failing', async () => {
    const { h, agent } = await harnessWith(() => cachedQuote(25, { stale: true }));
    const asset = await seedAsset(h, { symbol: 'AAA', providerRef: 'AAA' });
    const id = await seedConglomerate(agent, 'Stale', [{ assetId: asset.id, weightPct: 100 }]);

    const res = await agent
      .post(`/api/v1/conglomerates/${id}/allocate`)
      .set(...XRW)
      .send({ budgetEur: 100, mode: 'whole' });

    expect(res.status).toBe(200);
    const body = res.body as AllocateResponse;
    expect(body.stale).toBe(true);
    expect(body.quoteNotice).not.toBeNull();
    expect(body.positions[0]!.qty).toBe(4); // 100 € / 25 € = 4 whole shares.
  });

  it('honors atLeastOneShare end-to-end: the €240-share-on-€1000 case buys 1 ON, 0 OFF/absent', async () => {
    // EXP 20 % @ 240 €: its 200 € slice cannot afford one share; CHEAP 80 % @ 10 €.
    const prices: Record<string, number> = { EXP: 240, CHEAP: 10 };
    const { h, agent } = await harnessWith((ref) => cachedQuote(prices[ref.providerRef]!));

    const exp = await seedAsset(h, { symbol: 'EXP', providerRef: 'EXP' });
    const cheap = await seedAsset(h, { symbol: 'CHEAP', providerRef: 'CHEAP' });
    const id = await seedConglomerate(agent, 'Min one share', [
      { assetId: exp.id, weightPct: 20 },
      { assetId: cheap.id, weightPct: 80 },
    ]);

    const on = await agent
      .post(`/api/v1/conglomerates/${id}/allocate`)
      .set(...XRW)
      .send({ budgetEur: 1000, mode: 'whole', atLeastOneShare: true });
    expect(on.status).toBe(200);
    expect(allocateResponseSchema.safeParse(on.body).success).toBe(true);
    const onBody = on.body as AllocateResponse;
    const onById = new Map(onBody.positions.map((p) => [p.assetId, p]));
    expect(onById.get(exp.id)!.qty).toBe(1);
    expect(onById.get(exp.id)!.costEur).toBeCloseTo(240, 9);
    // Remainder 760 € rebalances onto CHEAP: 76 × 10 €. Never overshoot.
    expect(onById.get(cheap.id)!.qty).toBe(76);
    expect(onBody.totalCostEur).toBeCloseTo(1000, 9);
    expect(onBody.totalCostEur).toBeLessThanOrEqual(1000);

    const off = await agent
      .post(`/api/v1/conglomerates/${id}/allocate`)
      .set(...XRW)
      .send({ budgetEur: 1000, mode: 'whole', atLeastOneShare: false });
    expect(off.status).toBe(200);
    const offBody = off.body as AllocateResponse;
    expect(offBody.positions.find((p) => p.assetId === exp.id)!.qty).toBe(0);
    expect(offBody.totalCostEur).toBeCloseTo(800, 9);

    // Absent flag = default OFF: identical to the explicit-false run.
    const absent = await agent
      .post(`/api/v1/conglomerates/${id}/allocate`)
      .set(...XRW)
      .send({ budgetEur: 1000, mode: 'whole' });
    expect(absent.status).toBe(200);
    expect(absent.body).toEqual(off.body);
  });

  it('400s a non-boolean atLeastOneShare', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const res = await agent
      .post(`/api/v1/conglomerates/${MISSING_ID}/allocate`)
      .set(...XRW)
      .send({ budgetEur: 1000, mode: 'whole', atLeastOneShare: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it("404s another user's conglomerate rather than 403/500 (no IDOR)", async () => {
    const marketData = createStubMarketData({ quote: () => cachedQuote(25) });
    const h = await createTestApp({ marketData });
    const userA = await h.seedUser({ email: 'a@al.test', username: 'aal' });
    const userB = await h.seedUser({ email: 'b@al.test', username: 'bal' });
    const agentA = await loginAgent(h.app, userA.email, userA.password);
    const agentB = await loginAgent(h.app, userB.email, userB.password);

    const asset = await seedAsset(h, { symbol: 'AAA', providerRef: 'AAA' });
    const id = await seedConglomerate(agentA, "A's basket", [
      { assetId: asset.id, weightPct: 100 },
    ]);

    const res = await agentB
      .post(`/api/v1/conglomerates/${id}/allocate`)
      .set(...XRW)
      .send({ budgetEur: 100, mode: 'whole' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CONGLOMERATE_NOT_FOUND');
  });

  it('404s an unknown conglomerate id', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const res = await agent
      .post(`/api/v1/conglomerates/${MISSING_ID}/allocate`)
      .set(...XRW)
      .send({ budgetEur: 100, mode: 'whole' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CONGLOMERATE_NOT_FOUND');
  });

  it('400s a malformed body (negative budget, bad mode)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const negative = await agent
      .post(`/api/v1/conglomerates/${MISSING_ID}/allocate`)
      .set(...XRW)
      .send({ budgetEur: -1, mode: 'whole' });
    expect(negative.status).toBe(400);
    expect(negative.body.error.code).toBe('VALIDATION_ERROR');

    const badMode = await agent
      .post(`/api/v1/conglomerates/${MISSING_ID}/allocate`)
      .set(...XRW)
      .send({ budgetEur: 1000, mode: 'nonsense' });
    expect(badMode.status).toBe(400);
    expect(badMode.body.error.code).toBe('VALIDATION_ERROR');
  });
});
