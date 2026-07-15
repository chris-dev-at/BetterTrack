import type { Application } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';
import { createStubMarketData } from '../testing/marketDataStubs';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const DAY_MS = 86_400_000;
const dayOffset = (n: number): string =>
  new Date(Date.now() + n * DAY_MS).toISOString().slice(0, 10);
const tsOffset = (n: number): string => new Date(Date.now() + n * DAY_MS).toISOString();
const cached = <T>(value: T) => ({ value, stale: false, asOf: Date.now() });

// 7 daily closes spanning day-6..day0, keyed to the calendar so valueOverTime's
// daily grid lines up with the market data.
const historyOf = (closes: number[]) =>
  cached(closes.map((close, i) => ({ time: `${dayOffset(-6 + i)}T00:00:00.000Z`, close })));

async function loginAgent(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

async function defaultPortfolioId(agent: ReturnType<typeof request.agent>): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  return res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault).id as string;
}

async function seedAsset(h: TestHarness, o: Partial<typeof schema.assets.$inferInsert> = {}) {
  const [row] = await h.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: o.providerRef ?? 'AAA',
      type: 'stock',
      symbol: 'AAA',
      name: 'Asset A',
      currency: 'EUR',
      exchange: 'XETRA',
      ...o,
    })
    .returning();
  return row!;
}

async function buy(
  agent: ReturnType<typeof request.agent>,
  pid: string,
  assetId: string,
  quantity: number,
  price: number,
) {
  const res = await agent
    .post(`/api/v1/portfolios/${pid}/transactions`)
    .set(...XRW)
    .send({ transactions: [{ assetId, side: 'buy', quantity, price, executedAt: tsOffset(-6) }] });
  expect(res.status).toBe(201);
}

/** Buy with an explicit day offset, so assets can be acquired on staggered dates. */
async function buyAt(
  agent: ReturnType<typeof request.agent>,
  pid: string,
  assetId: string,
  quantity: number,
  price: number,
  offsetDays: number,
) {
  const res = await agent
    .post(`/api/v1/portfolios/${pid}/transactions`)
    .set(...XRW)
    .send({
      transactions: [{ assetId, side: 'buy', quantity, price, executedAt: tsOffset(offsetDays) }],
    });
  expect(res.status).toBe(201);
}

/**
 * Market-data controls for the value/filter/compare scenarios. AAA rises
 * (100→106), BBB is flat at 200, CCC is a catalog benchmark. Quotes match the
 * last close so the current holdings snapshot lines up with the series end.
 */
const HISTORY: Record<string, number[]> = {
  AAA: [100, 101, 102, 103, 104, 105, 106],
  BBB: [200, 200, 200, 200, 200, 200, 200],
  CCC: [10, 11, 12, 13, 14, 15, 16],
};
const QUOTE: Record<string, number> = { AAA: 106, BBB: 200, CCC: 16 };

function stubMarket() {
  return createStubMarketData({
    history: (ref) => historyOf(HISTORY[ref.providerRef] ?? []),
    quote: (ref) =>
      cached({
        price: QUOTE[ref.providerRef] ?? 0,
        currency: 'EUR',
        prevClose: QUOTE[ref.providerRef] ?? 0,
        asOf: new Date().toISOString(),
      }),
  });
}

describe('analytics — filtered series, stats & contributions', () => {
  let harness: TestHarness;
  let agent: ReturnType<typeof request.agent>;
  let pid: string;
  let aaa: string;
  let bbb: string;

  beforeEach(async () => {
    harness = await createTestApp({ marketData: stubMarket() });
    const user = await harness.seedUser();
    agent = await loginAgent(harness.app, user.email, user.password);
    pid = await defaultPortfolioId(agent);
    aaa = (await seedAsset(harness, { symbol: 'AAA', providerRef: 'AAA', type: 'stock' })).id;
    bbb = (
      await seedAsset(harness, { symbol: 'BBB', providerRef: 'BBB', name: 'Asset B', type: 'etf' })
    ).id;
    await buy(agent, pid, aaa, 10, 100);
    await buy(agent, pid, bbb, 5, 200);
  });

  it('returns the full portfolio curve with per-series stats and a contribution row per asset', async () => {
    const res = await agent.get(`/api/v1/analytics/portfolios/${pid}/series`);
    expect(res.status).toBe(200);
    const body = res.body;

    expect(body.mode).toBe('value');
    expect(body.baseCurrency).toBe('EUR');
    expect(body.primary.kind).toBe('portfolio');
    expect(body.primary.points.length).toBeGreaterThan(1);
    // start = 10·100 + 5·200 = 2000, end = 10·106 + 5·200 = 2060 → +3.0 %.
    expect(body.primary.points[0].value).toBeCloseTo(2000, 6);
    expect(body.primary.points.at(-1).value).toBeCloseTo(2060, 6);
    expect(body.primary.stats.totalReturnPct).toBeCloseTo(3.0, 6);
    expect(body.primary.stats.maxDrawdownPct).toBeCloseTo(0, 6);

    expect(body.contributions).toHaveLength(2);
    // The visible rows' contributionPct sum to the filtered series' total return.
    const sum = body.contributions.reduce(
      (s: number, r: { contributionPct: number }) => s + r.contributionPct,
      0,
    );
    expect(sum).toBeCloseTo(body.primary.stats.totalReturnPct, 6);
    // Weights (of current market value) sum to 1.
    const weight = body.contributions.reduce((s: number, r: { weight: number }) => s + r.weight, 0);
    expect(weight).toBeCloseTo(1, 6);
    expect(body.compare).toBeNull();
    expect(body.inflation).toBeNull();
  });

  it('contribution value/cost/P-L match the holdings snapshot', async () => {
    const [analytics, portfolio] = await Promise.all([
      agent.get(`/api/v1/analytics/portfolios/${pid}/series`),
      agent.get(`/api/v1/portfolios/${pid}`),
    ]);
    const rowA = analytics.body.contributions.find(
      (r: { asset: { id: string } }) => r.asset.id === aaa,
    );
    const holdA = portfolio.body.holdings.find(
      (h: { asset: { id: string } }) => h.asset.id === aaa,
    );
    expect(rowA.value).toBeCloseTo(holdA.marketValueEur, 6);
    expect(rowA.cost).toBeCloseTo(holdA.costBasisEur, 6);
    expect(rowA.pnl).toBeCloseTo(holdA.unrealizedPnlEur, 6);
    // 10 · 106 = 1060 value, 10 · 100 = 1000 cost, 60 P/L.
    expect(rowA.value).toBeCloseTo(1060, 6);
    expect(rowA.cost).toBeCloseTo(1000, 6);
    expect(rowA.pnl).toBeCloseTo(60, 6);
  });

  it('hiding an asset recomputes the curve, the stats AND the contribution rows', async () => {
    const full = await agent.get(`/api/v1/analytics/portfolios/${pid}/series`);
    const hidden = await agent.get(`/api/v1/analytics/portfolios/${pid}/series?hide=${bbb}`);
    expect(hidden.status).toBe(200);

    // Curve values change (BBB's flat 1000 is gone from the total).
    expect(hidden.body.primary.points.at(-1).value).toBeCloseTo(1060, 6);
    expect(hidden.body.primary.points.at(-1).value).not.toBeCloseTo(
      full.body.primary.points.at(-1).value,
      3,
    );
    // AAA alone: 1000 → 1060 = +6 %, distinct from the blended +3 %.
    expect(hidden.body.primary.stats.totalReturnPct).toBeCloseTo(6.0, 6);
    expect(hidden.body.primary.stats.totalReturnPct).not.toBeCloseTo(
      full.body.primary.stats.totalReturnPct,
      3,
    );
    // Only the visible asset contributes, and it still reconciles.
    expect(hidden.body.contributions).toHaveLength(1);
    expect(hidden.body.contributions[0].asset.id).toBe(aaa);
    expect(hidden.body.contributions[0].contributionPct).toBeCloseTo(6.0, 6);
  });

  it('a category/type filter excludes assets exactly like per-asset hiding', async () => {
    // groups=stock keeps AAA (market stock), drops BBB (etf) — same as hiding BBB.
    const filtered = await agent.get(`/api/v1/analytics/portfolios/${pid}/series?groups=stock`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.contributions).toHaveLength(1);
    expect(filtered.body.contributions[0].asset.id).toBe(aaa);
    expect(filtered.body.primary.stats.totalReturnPct).toBeCloseTo(6.0, 6);

    // hideGroups=etf is the exclude direction — same result.
    const excluded = await agent.get(`/api/v1/analytics/portfolios/${pid}/series?hideGroups=etf`);
    expect(excluded.body.contributions).toHaveLength(1);
    expect(excluded.body.contributions[0].asset.id).toBe(aaa);
  });

  it('performance mode rebases the curve to 0 % at the window start', async () => {
    const res = await agent.get(`/api/v1/analytics/portfolios/${pid}/series?mode=perf`);
    expect(res.body.mode).toBe('perf');
    expect(res.body.primary.points[0].value).toBeCloseTo(0, 6);
    expect(res.body.primary.points.at(-1).value).toBeCloseTo(3.0, 6);
  });

  it('custom flat inflation bends the nominal curve into lower real-terms values', async () => {
    const nominal = await agent.get(`/api/v1/analytics/portfolios/${pid}/series?mode=perf`);
    const real = await agent.get(
      `/api/v1/analytics/portfolios/${pid}/series?mode=perf&inflation=flat&inflationRate=10`,
    );
    expect(real.status).toBe(200);
    expect(real.body.inflation).toEqual({ id: 'flat', pctPerYear: 10 });
    // Real-terms performance is below nominal at the end of the window.
    expect(real.body.primary.points.at(-1).value).toBeLessThan(
      nominal.body.primary.points.at(-1).value,
    );
  });

  it('exposes the per-preset effective %/yr on every response (V4-P0)', async () => {
    const res = await agent.get(`/api/v1/analytics/portfolios/${pid}/series`);
    expect(res.status).toBe(200);
    const presets = res.body.inflationPresets as Array<{ id: string; pctPerYear: number | null }>;
    // One entry per checked-in preset id.
    expect(presets.map((p) => p.id).sort()).toEqual(['cpi-us', 'hicp-at', 'hicp-eu']);
    // Every preset ships enough data to state a genuine annualised rate (~2-4 %/yr).
    for (const preset of presets) {
      expect(preset.pctPerYear).not.toBeNull();
      expect(preset.pctPerYear!).toBeGreaterThan(0);
      expect(preset.pctPerYear!).toBeLessThan(15);
    }
  });

  it('rejects a flat inflation mode without a rate, and mismatched compare params', async () => {
    const noRate = await agent.get(`/api/v1/analytics/portfolios/${pid}/series?inflation=flat`);
    expect(noRate.status).toBe(400);
    const noKind = await agent.get(`/api/v1/analytics/portfolios/${pid}/series?compareId=${aaa}`);
    expect(noKind.status).toBe(400);
  });

  it('rejects an inflation rate ≤ -100 % (flat deflator growth base must stay positive)', async () => {
    const atBound = await agent.get(
      `/api/v1/analytics/portfolios/${pid}/series?inflation=flat&inflationRate=-100`,
    );
    expect(atBound.status).toBe(400);
    const belowBound = await agent.get(
      `/api/v1/analytics/portfolios/${pid}/series?inflation=flat&inflationRate=-150`,
    );
    expect(belowBound.status).toBe(400);
  });

  it('404s a portfolio the caller does not own', async () => {
    const other = await harness.seedUser({ email: 'other@bt.test', username: 'otheruser' });
    const otherAgent = await loginAgent(harness.app, other.email, other.password);
    const otherPid = await defaultPortfolioId(otherAgent);
    const res = await agent.get(`/api/v1/analytics/portfolios/${otherPid}/series`);
    expect(res.status).toBe(404);
  });
});

describe('analytics — staggered buy dates (hide the earliest-held asset)', () => {
  let harness: TestHarness;
  let agent: ReturnType<typeof request.agent>;
  let pid: string;
  let aaa: string;
  let bbb: string;

  // AAA's real return over its own holding window (bought day-3 at 103, now 106).
  const AAA_RETURN_PCT = (1060 / 1030 - 1) * 100;

  beforeEach(async () => {
    harness = await createTestApp({ marketData: stubMarket() });
    const user = await harness.seedUser();
    agent = await loginAgent(harness.app, user.email, user.password);
    pid = await defaultPortfolioId(agent);
    aaa = (await seedAsset(harness, { symbol: 'AAA', providerRef: 'AAA', type: 'stock' })).id;
    bbb = (
      await seedAsset(harness, { symbol: 'BBB', providerRef: 'BBB', name: 'Asset B', type: 'etf' })
    ).id;
    // BBB (flat 200) is the EARLIEST holding (day-6); AAA (rising 100→106) is
    // bought later (day-3). On day-6..day-4 only BBB is held, so the all-assets
    // grid starts before AAA existed — the regression the shipped tests miss.
    await buyAt(agent, pid, bbb, 5, 200, -6);
    await buyAt(agent, pid, aaa, 10, 100, -3);
  });

  it('anchors stats + window to the later asset instead of a leading 0', async () => {
    const res = await agent.get(`/api/v1/analytics/portfolios/${pid}/series?hide=${bbb}`);
    expect(res.status).toBe(200);
    const body = res.body;

    // Window anchors to AAA's first held day (day-3), NOT BBB's day-6: the
    // leading padding-0s (days before AAA existed) are trimmed, so the first
    // point is AAA's real value, not 0.
    expect(body.from).toBe(dayOffset(-3));
    expect(body.primary.points[0].value).toBeCloseTo(1030, 6);
    expect(body.primary.points.at(-1).value).toBeCloseTo(1060, 6);

    // AAA alone rose 1030 → 1060 (+2.9126 %). Pre-fix this reported 0 % with a
    // null CAGR/best/worst and 0 drawdown because first.value was the leading 0.
    expect(body.primary.stats.totalReturnPct).toBeCloseTo(AAA_RETURN_PCT, 6);
    expect(body.primary.stats.totalReturnPct).toBeGreaterThan(0);
    expect(body.primary.stats.maxDrawdownPct).toBeCloseTo(0, 6);
    expect(body.primary.stats.bestDay).not.toBeNull();

    // The single visible row still reconciles to the series total return.
    expect(body.contributions).toHaveLength(1);
    expect(body.contributions[0].asset.id).toBe(aaa);
    expect(body.contributions[0].contributionPct).toBeCloseTo(AAA_RETURN_PCT, 6);
  });

  it('a group filter that excludes the earliest asset behaves the same', async () => {
    // hideGroups=etf drops BBB (the earliest) exactly like hide=bbb.
    const res = await agent.get(`/api/v1/analytics/portfolios/${pid}/series?hideGroups=etf`);
    expect(res.status).toBe(200);
    expect(res.body.from).toBe(dayOffset(-3));
    expect(res.body.primary.stats.totalReturnPct).toBeCloseTo(AAA_RETURN_PCT, 6);
    expect(res.body.contributions).toHaveLength(1);
    expect(res.body.contributions[0].asset.id).toBe(aaa);
  });

  it('performance mode is not flatlined at 0 % when the earliest asset is hidden', async () => {
    const res = await agent.get(`/api/v1/analytics/portfolios/${pid}/series?hide=${bbb}&mode=perf`);
    expect(res.status).toBe(200);
    expect(res.body.primary.points[0].value).toBeCloseTo(0, 6);
    expect(res.body.primary.points.at(-1).value).toBeCloseTo(AAA_RETURN_PCT, 6);
  });
});

describe('analytics — compare targets', () => {
  let harness: TestHarness;
  let agent: ReturnType<typeof request.agent>;
  let userId: string;
  let pid: string;
  let aaa: string;
  let bbb: string;
  let ccc: string;

  beforeEach(async () => {
    harness = await createTestApp({ marketData: stubMarket() });
    const user = await harness.seedUser();
    userId = user.id;
    agent = await loginAgent(harness.app, user.email, user.password);
    pid = await defaultPortfolioId(agent);
    aaa = (await seedAsset(harness, { symbol: 'AAA', providerRef: 'AAA', type: 'stock' })).id;
    bbb = (
      await seedAsset(harness, { symbol: 'BBB', providerRef: 'BBB', name: 'Asset B', type: 'etf' })
    ).id;
    ccc = (
      await seedAsset(harness, {
        symbol: 'CCC',
        providerRef: 'CCC',
        name: 'Index C',
        type: 'index',
      })
    ).id;
    await buy(agent, pid, aaa, 10, 100);
    await buy(agent, pid, bbb, 5, 200);
  });

  it('compares vs a catalog asset with two aligned series + per-series stats', async () => {
    const res = await agent.get(
      `/api/v1/analytics/portfolios/${pid}/series?compareKind=asset&compareId=${ccc}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.compare.kind).toBe('asset');
    expect(res.body.compare.label).toBe('CCC');
    expect(res.body.compare.points.length).toBeGreaterThan(1);
    expect(typeof res.body.compare.stats.totalReturnPct).toBe('number');
    // CCC 10 → 16 = +60 %.
    expect(res.body.compare.stats.totalReturnPct).toBeCloseTo(60, 6);
    // Both series lie inside the same [from, to] window.
    for (const p of res.body.compare.points) {
      expect(p.date >= res.body.from && p.date <= res.body.to).toBe(true);
    }
  });

  it('compares vs a second own portfolio', async () => {
    const created = await agent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Second' });
    expect(created.status).toBe(201);
    const list = await agent.get('/api/v1/portfolios');
    const secondId = list.body.portfolios.find((p: { name: string }) => p.name === 'Second').id;
    await buy(agent, secondId, ccc, 100, 10);

    const res = await agent.get(
      `/api/v1/analytics/portfolios/${pid}/series?compareKind=portfolio&compareId=${secondId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.compare.kind).toBe('portfolio');
    expect(res.body.compare.label).toBe('Second');
    expect(res.body.compare.points.length).toBeGreaterThan(1);
    // 100 · CCC: 1000 → 1600 = +60 %.
    expect(res.body.compare.stats.totalReturnPct).toBeCloseTo(60, 6);
  });

  it('compares vs an own conglomerate priced through the backtest engine', async () => {
    const conglomerate = await harness.ctx.conglomerate.create(userId, { name: 'My Basket' });
    await harness.ctx.conglomerate.replacePositions(userId, conglomerate.id, [
      { assetId: aaa, weightPct: 50 },
      { assetId: bbb, weightPct: 50 },
    ]);
    const res = await agent.get(
      `/api/v1/analytics/portfolios/${pid}/series?compareKind=conglomerate&compareId=${conglomerate.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.compare.kind).toBe('conglomerate');
    expect(res.body.compare.label).toBe('My Basket');
    expect(res.body.compare.points.length).toBeGreaterThan(1);
    expect(typeof res.body.compare.stats.totalReturnPct).toBe('number');
  });

  it('rejects a foreign portfolio or conglomerate compare id (404)', async () => {
    const other = await harness.seedUser({ email: 'foreign@bt.test', username: 'foreigner' });
    const otherAgent = await loginAgent(harness.app, other.email, other.password);
    const otherPid = await defaultPortfolioId(otherAgent);
    const otherCong = await harness.ctx.conglomerate.create(other.id, { name: 'Theirs' });
    await harness.ctx.conglomerate.replacePositions(other.id, otherCong.id, [
      { assetId: ccc, weightPct: 100 },
    ]);

    const foreignPortfolio = await agent.get(
      `/api/v1/analytics/portfolios/${pid}/series?compareKind=portfolio&compareId=${otherPid}`,
    );
    expect(foreignPortfolio.status).toBe(404);
    const foreignConglomerate = await agent.get(
      `/api/v1/analytics/portfolios/${pid}/series?compareKind=conglomerate&compareId=${otherCong.id}`,
    );
    expect(foreignConglomerate.status).toBe(404);
  });
});

describe('analytics — custom-asset smoothing (real manual provider)', () => {
  it('respects the smoothing toggle: interpolated between marks, exact on mark days', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);

    const created = await agent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({
        name: 'Smoothed House',
        category: 'other',
        currency: 'EUR',
        initialPurchase: { quantity: 1, price: 100, executedAt: tsOffset(-25) },
      });
    expect(created.status).toBe(201);
    const id = created.body.asset.id as string;
    // Two marks: 100 at day-20, 200 at day-10. day-15 is exactly between them.
    await agent
      .put(`/api/v1/custom-assets/${id}/value-points`)
      .set(...XRW)
      .send({
        points: [
          { date: dayOffset(-20), value: 100 },
          { date: dayOffset(-10), value: 200 },
        ],
      });

    const valueAt = (
      body: { primary: { points: { date: string; value: number }[] } },
      date: string,
    ) => body.primary.points.find((p) => p.date === date)?.value;

    const stepped = await agent.get(`/api/v1/analytics/portfolios/${pid}/series`);
    expect(stepped.status).toBe(200);
    // Step/carry-forward: day-15 carries the day-20 mark (100); day-10 is exact (200).
    expect(valueAt(stepped.body, dayOffset(-15))).toBeCloseTo(100, 6);
    expect(valueAt(stepped.body, dayOffset(-10))).toBeCloseTo(200, 6);

    await agent
      .patch(`/api/v1/custom-assets/${id}`)
      .set(...XRW)
      .send({ smoothing: true });
    const smoothed = await agent.get(`/api/v1/analytics/portfolios/${pid}/series`);
    // Linear interpolation: day-15 is the midpoint → 150 (differs between marks)…
    expect(valueAt(smoothed.body, dayOffset(-15))).toBeCloseTo(150, 6);
    // …but the mark day is still exact (equal on mark days).
    expect(valueAt(smoothed.body, dayOffset(-10))).toBeCloseTo(200, 6);
  });
});

describe('analytics — bearer scope', () => {
  let harness: TestHarness;
  let agent: ReturnType<typeof request.agent>;
  let pid: string;

  async function mintKey(scopes: string[]): Promise<string> {
    const res = await agent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'k', scopes });
    expect(res.status).toBe(201);
    return res.body.token as string;
  }

  beforeEach(async () => {
    harness = await createTestApp({ marketData: stubMarket() });
    const user = await harness.seedUser();
    agent = await loginAgent(harness.app, user.email, user.password);
    pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(harness, { symbol: 'AAA', providerRef: 'AAA' });
    await buy(agent, pid, asset.id, 1, 100);
  });

  it('allows a portfolio:read bearer token and forbids a token without it', async () => {
    const readToken = await mintKey(['portfolio:read']);
    const ok = await request(harness.app)
      .get(`/api/v1/analytics/portfolios/${pid}/series`)
      .set('Authorization', `Bearer ${readToken}`);
    expect(ok.status).toBe(200);

    const wrongToken = await mintKey(['workboard:read']);
    const forbidden = await request(harness.app)
      .get(`/api/v1/analytics/portfolios/${pid}/series`)
      .set('Authorization', `Bearer ${wrongToken}`);
    expect(forbidden.status).toBe(403);
  });
});
