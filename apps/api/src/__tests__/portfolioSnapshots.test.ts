import { asc, eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { describe, expect, it } from 'vitest';

import type { CachedResult, PricePoint, Quote } from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createStubMarketData, type StubMarketData } from '../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * V5-P1 daily snapshots (issue #553): the precomputed per-portfolio series
 * under the graph/analytics reads. Covers the acceptance criteria end to end:
 * golden equality with the legacy engine, the snapshot-path probe (recompute
 * not hit), the always-fresh "today" point, the §16 2026-07-17 invalidation
 * rules per mutation class (earlier days untouched, later days recomputed),
 * and portfolio-deletion cleanup.
 */

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

/** Canned daily closes per provider ref; unknown refs get an empty series. */
function cannedHistory(byRef: Record<string, ReadonlyArray<{ date: string; close: number }>>) {
  return (ref: { providerRef: string }): CachedResult<PricePoint[]> => ({
    value: (byRef[ref.providerRef] ?? []).map((p) => ({
      time: `${p.date}T00:00:00.000Z`,
      close: p.close,
    })),
    stale: false,
    asOf: 0,
  });
}

/** Live quotes per provider ref (mutable); unknown refs throw (degrade path). */
function cannedQuotes(byRef: Record<string, number>) {
  return (ref: { providerRef: string }): CachedResult<Quote> => {
    const price = byRef[ref.providerRef];
    if (price === undefined) throw new Error(`no quote for ${ref.providerRef}`);
    return {
      value: { price, currency: 'EUR', prevClose: price, asOf: new Date().toISOString() },
      stale: false,
      asOf: Date.now(),
    };
  };
}

async function snapshotRows(h: TestHarness, portfolioId: string) {
  return h.db
    .select()
    .from(schema.portfolioDailySnapshots)
    .where(eq(schema.portfolioDailySnapshots.portfolioId, portfolioId))
    .orderBy(asc(schema.portfolioDailySnapshots.date));
}

async function snapshotState(h: TestHarness, portfolioId: string) {
  const rows = await h.db
    .select()
    .from(schema.portfolioSnapshotState)
    .where(eq(schema.portfolioSnapshotState.portfolioId, portfolioId));
  return rows[0] ?? null;
}

/** Buy helper against the transactions endpoint. */
async function buy(
  agent: ReturnType<typeof request.agent>,
  pid: string,
  assetId: string,
  quantity: number,
  price: number,
  executedAt: string,
) {
  const res = await agent
    .post(`/api/v1/portfolios/${pid}/transactions`)
    .set(...XRW)
    .send({ assetId, side: 'buy', quantity, price, executedAt });
  expect(res.status).toBe(201);
  return res.body[0] ?? res.body.transactions?.[0];
}

describe('daily snapshots — golden equality with the legacy engine (#553)', () => {
  it('serves byte-identical historical series from snapshots for a multi-currency portfolio with dividends, cash and a custom asset', async () => {
    // Daily closes for the whole window, today included (the engine's today
    // uses the last candle; the snapshot path's fresh today uses the QUOTE —
    // aligned below so the two todays value identically).
    const days = [-8, -7, -6, -5, -4, -3, -2, -1, 0];
    const histories = {
      'BAYN.DE': days.map((d, i) => ({ date: dayOffset(d), close: 100 + i })),
      AAPL: days.map((d, i) => ({ date: dayOffset(d), close: 200 + 2 * i })),
      'EURUSD=X': days.map((d) => ({ date: dayOffset(d), close: 1.25 })),
    };
    const marketData = createStubMarketData({
      history: cannedHistory(histories),
      quote: cannedQuotes({ 'BAYN.DE': 108, AAPL: 216, 'EURUSD=X': 1.25 }),
    });
    const h = await createTestApp({ marketData });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const eurAsset = await seedAsset(h);
    const usdAsset = await seedAsset(h, {
      providerRef: 'AAPL',
      symbol: 'AAPL',
      currency: 'USD',
      exchange: 'NASDAQ',
    });

    // Cash in first (funds nothing explicitly — external flows), then trades,
    // a custom asset with value points, a dividend, and a withdrawal.
    await agent
      .post(`/api/v1/portfolios/${pid}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 1000, executedAt: tsOffset(-7) });
    await buy(agent, pid, eurAsset.id, 2, 100, tsOffset(-6));
    await buy(agent, pid, usdAsset.id, 3, 200, tsOffset(-4));
    const created = await agent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({
        name: 'House',
        category: 'other',
        currency: 'EUR',
        initialPurchase: { quantity: 1, price: 500, fee: 0, executedAt: tsOffset(-5) },
      });
    expect(created.status).toBe(201);
    const houseId = created.body.asset.id as string;
    const housePut = await agent
      .put(`/api/v1/custom-assets/${houseId}/value-points`)
      .set(...XRW)
      .send({
        points: [
          { date: dayOffset(-5), value: 500 },
          { date: dayOffset(-2), value: 650 },
        ],
      });
    expect(housePut.status).toBe(200);
    await agent
      .post(`/api/v1/portfolios/${pid}/dividends`)
      .set(...XRW)
      .send({ assetId: eurAsset.id, grossAmountEur: 50, executedAt: tsOffset(-3) });
    await agent
      .post(`/api/v1/portfolios/${pid}/cash/withdraw`)
      .set(...XRW)
      .send({ amountEur: 100, executedAt: tsOffset(-1) });

    // 1) Legacy analytics response (engine path — nothing snapshotted yet
    // beyond what the writes invalidated).
    const analyticsLegacy = await agent.get(`/api/v1/analytics/portfolios/${pid}/series`);
    expect(analyticsLegacy.status).toBe(200);

    // Wipe + dirty so the overview read below is a genuine engine run too.
    await h.ctx.snapshots.invalidate(pid, dayOffset(-8));

    // 2) Legacy overview response (engine path; refills the snapshot rows).
    const historyLegacy = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(historyLegacy.status).toBe(200);

    // The refill landed: clean state through yesterday, one row per day, none
    // for today.
    const state = await snapshotState(h, pid);
    expect(state?.dirtyFrom ?? null).toBeNull();
    expect(state?.computedThrough).toBe(dayOffset(-1));
    const rows = await snapshotRows(h, pid);
    expect(rows.map((r) => r.date)).toEqual([-7, -6, -5, -4, -3, -2, -1].map(dayOffset));
    const direct = await h.ctx.snapshots.getSeries(pid);
    expect(direct.fromSnapshots).toBe(true);

    // 3) Snapshot-path overview: historical points byte-identical (the golden
    // criterion); the fresh today point matches the engine's to FP dust (same
    // prices/FX, differently associated sum).
    const historySnap = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(historySnap.status).toBe(200);
    const legacyPoints = historyLegacy.body.points as Array<{ date: string; valueEur: number }>;
    const snapPoints = historySnap.body.points as Array<{ date: string; valueEur: number }>;
    expect(snapPoints.length).toBe(legacyPoints.length);
    expect(snapPoints.slice(0, -1)).toEqual(legacyPoints.slice(0, -1));
    expect(snapPoints[snapPoints.length - 1]!.date).toBe(dayOffset(0));
    expect(snapPoints[snapPoints.length - 1]!.valueEur).toBeCloseTo(
      legacyPoints[legacyPoints.length - 1]!.valueEur,
      9,
    );
    const legacyPerf = historyLegacy.body.performance as Array<{ date: string; pct: number }>;
    const snapPerf = historySnap.body.performance as Array<{ date: string; pct: number }>;
    expect(snapPerf.map((p) => p.date)).toEqual(legacyPerf.map((p) => p.date));
    for (let i = 0; i < snapPerf.length; i += 1) {
      expect(snapPerf[i]!.pct).toBeCloseTo(legacyPerf[i]!.pct, 9);
    }

    // 4) Snapshot-path analytics: identical shape and historical values.
    const analyticsSnap = await agent.get(`/api/v1/analytics/portfolios/${pid}/series`);
    expect(analyticsSnap.status).toBe(200);
    const primaryLegacy = analyticsLegacy.body.primary.points as Array<{
      date: string;
      value: number;
    }>;
    const primarySnap = analyticsSnap.body.primary.points as Array<{
      date: string;
      value: number;
    }>;
    expect(primarySnap.slice(0, -1)).toEqual(primaryLegacy.slice(0, -1));
    expect(primarySnap[primarySnap.length - 1]!.value).toBeCloseTo(
      primaryLegacy[primaryLegacy.length - 1]!.value,
      9,
    );
    const contribLegacy = analyticsLegacy.body.contributions as Array<Record<string, unknown>>;
    const contribSnap = analyticsSnap.body.contributions as Array<Record<string, unknown>>;
    expect(contribSnap.map((c) => (c.asset as { id: string }).id)).toEqual(
      contribLegacy.map((c) => (c.asset as { id: string }).id),
    );
    for (let i = 0; i < contribSnap.length; i += 1) {
      expect(contribSnap[i]!.value).toEqual(contribLegacy[i]!.value);
      expect(contribSnap[i]!.cost).toEqual(contribLegacy[i]!.cost);
      expect(contribSnap[i]!.pnl).toEqual(contribLegacy[i]!.pnl);
      expect(contribSnap[i]!.weight as number).toBeCloseTo(contribLegacy[i]!.weight as number, 9);
      expect(contribSnap[i]!.contributionPct as number).toBeCloseTo(
        contribLegacy[i]!.contributionPct as number,
        9,
      );
    }

    // The snapshot rows themselves carry the promised columns per day.
    const lastRow = rows[rows.length - 1]!;
    expect(Number(lastRow.valueEur)).toBe(legacyPoints[legacyPoints.length - 2]!.valueEur);
    expect(Object.keys(lastRow.assetValues as Record<string, number>).sort()).toEqual(
      [eurAsset.id, usdAsset.id, houseId].sort(),
    );
    expect(Object.keys(lastRow.cashBySource as Record<string, number>)).toHaveLength(1);
    expect(Number(lastRow.plEur)).toBeCloseTo(
      Number(lastRow.valueEur) -
        Object.values(lastRow.cashBySource as Record<string, number>)[0]! -
        Number(lastRow.costBasisEur),
      9,
    );
  });
});

describe('daily snapshots — read-path probe + fresh today (#553)', () => {
  /** EUR-only fixture: stored price rows, canned quote — zero FX in play. */
  async function primedEurHarness(marketData: StubMarketData) {
    const h = await createTestApp({ marketData });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(h);
    await h.db.insert(schema.priceHistory).values(
      [-5, -4, -3, -2, -1].map((d, i) => ({
        assetId: asset.id,
        date: dayOffset(d),
        close: String(100 + i),
      })),
    );
    await buy(agent, pid, asset.id, 2, 100, tsOffset(-5));
    // Prime: first read runs the engine and refills the rows.
    const first = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(first.status).toBe(200);
    return { h, agent, pid, asset, first };
  }

  it('serves historical ranges without hitting the recompute path (overview + analytics probe)', async () => {
    const marketData = createStubMarketData({
      history: cannedHistory({}),
      quote: cannedQuotes({ 'BAYN.DE': 104 }),
    });
    const { h, agent, pid } = await primedEurHarness(marketData);
    expect((await h.ctx.snapshots.getSeries(pid)).fromSnapshots).toBe(true);

    // The probe: from here on, the value engine (whose signature is the
    // per-asset provider history fan-out) must NOT run for these reads.
    const historyCallsBefore = marketData.calls.history;
    const overview = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(overview.status).toBe(200);
    const analytics = await agent.get(`/api/v1/analytics/portfolios/${pid}/series`);
    expect(analytics.status).toBe(200);
    expect(marketData.calls.history).toBe(historyCallsBefore);
    // Quotes ARE expected — they price the always-fresh today point.
    expect(marketData.calls.quote).toBeGreaterThan(0);
  });

  it('always computes the today point fresh: a quote change reflects without any snapshot write', async () => {
    const quotes: Record<string, number> = { 'BAYN.DE': 104 };
    const marketData = createStubMarketData({
      history: cannedHistory({}),
      quote: cannedQuotes(quotes),
    });
    const { h, agent, pid, first } = await primedEurHarness(marketData);
    // The engine's today carried the last stored close (104): 2 × 104.
    const firstToday = first.body.points[first.body.points.length - 1];
    expect(firstToday.date).toBe(dayOffset(0));
    expect(firstToday.valueEur).toBeCloseTo(208, 9);

    const rowsBefore = await snapshotRows(h, pid);
    quotes['BAYN.DE'] = 120;
    const res = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(res.status).toBe(200);
    const today = res.body.points[res.body.points.length - 1];
    expect(today.date).toBe(dayOffset(0));
    expect(today.valueEur).toBeCloseTo(240, 9); // 2 × the LIVE quote

    // No snapshot write happened: same rows, none for today, same bytes.
    const rowsAfter = await snapshotRows(h, pid);
    expect(rowsAfter.map((r) => r.date)).toEqual(rowsBefore.map((r) => r.date));
    expect(rowsAfter[rowsAfter.length - 1]!.date).toBe(dayOffset(-1));
    expect(rowsAfter.map((r) => r.computedAt.getTime())).toEqual(
      rowsBefore.map((r) => r.computedAt.getTime()),
    );
  });
});

describe('daily snapshots — §16 invalidation rules (#553)', () => {
  /** EUR asset + stored closes over 10 days, two buys, primed snapshots. */
  async function invalidationFixture() {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(h);
    await h.db.insert(schema.priceHistory).values(
      [-10, -9, -8, -7, -6, -5, -4, -3, -2, -1].map((d, i) => ({
        assetId: asset.id,
        date: dayOffset(d),
        close: String(100 + i),
      })),
    );
    const txn = await buy(agent, pid, asset.id, 2, 100, tsOffset(-10));
    const later = await buy(agent, pid, asset.id, 1, 100, tsOffset(-5));
    const prime = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(prime.status).toBe(200);
    const rows = await snapshotRows(h, pid);
    expect(rows.map((r) => r.date)).toEqual(
      [-10, -9, -8, -7, -6, -5, -4, -3, -2, -1].map(dayOffset),
    );
    return { h, agent, pid, asset, txn, later, rowsBefore: rows };
  }

  /** Assert rows before `fromDay` are byte-untouched and later ones are gone. */
  async function expectInvalidatedFrom(
    h: TestHarness,
    pid: string,
    rowsBefore: Awaited<ReturnType<typeof snapshotRows>>,
    fromDay: string,
  ) {
    const state = await snapshotState(h, pid);
    expect(state?.dirtyFrom).toBe(fromDay);
    const rowsAfter = await snapshotRows(h, pid);
    const expected = rowsBefore.filter((r) => r.date < fromDay);
    expect(rowsAfter.map((r) => r.date)).toEqual(expected.map((r) => r.date));
    expect(rowsAfter.map((r) => r.computedAt.getTime())).toEqual(
      expected.map((r) => r.computedAt.getTime()),
    );
    expect(rowsAfter.map((r) => r.valueEur)).toEqual(expected.map((r) => r.valueEur));
  }

  it('backdated transaction edit invalidates exactly the affected range and the refill recomputes only later days', async () => {
    const { h, agent, pid, later, rowsBefore } = await invalidationFixture();

    // Move the -5 buy back to -7: affected from min(old, new) = -7 (§16 rule 2).
    const res = await agent
      .patch(`/api/v1/portfolios/${pid}/transactions/${later.id}`)
      .set(...XRW)
      .send({ executedAt: tsOffset(-7) });
    expect(res.status).toBe(200);
    await expectInvalidatedFrom(h, pid, rowsBefore, dayOffset(-7));

    // The next read refills: earlier rows keep their exact bytes + computedAt,
    // later days come back recomputed against the new timeline.
    const refill = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(refill.status).toBe(200);
    const rowsAfter = await snapshotRows(h, pid);
    expect(rowsAfter.map((r) => r.date)).toEqual(rowsBefore.map((r) => r.date));
    for (const row of rowsAfter) {
      const before = rowsBefore.find((r) => r.date === row.date)!;
      if (row.date < dayOffset(-7)) {
        expect(row.computedAt.getTime()).toBe(before.computedAt.getTime());
        expect(row.valueEur).toBe(before.valueEur);
      } else {
        expect(row.computedAt.getTime()).toBeGreaterThanOrEqual(before.computedAt.getTime());
      }
    }
    // Day -8 (2 shares × close 102) unchanged; day -6 now holds 3 shares.
    const day6 = rowsAfter.find((r) => r.date === dayOffset(-6))!;
    expect(Number(day6.valueEur)).toBeCloseTo(3 * 104, 9);
    const day8 = rowsAfter.find((r) => r.date === dayOffset(-8))!;
    expect(Number(day8.valueEur)).toBeCloseTo(2 * 102, 9);
    expect((await snapshotState(h, pid))?.dirtyFrom ?? null).toBeNull();
  });

  it('dividend record + delete invalidate from the dividend day (§16 rules 5/6)', async () => {
    const { h, agent, pid, asset, rowsBefore } = await invalidationFixture();
    const record = await agent
      .post(`/api/v1/portfolios/${pid}/dividends`)
      .set(...XRW)
      .send({ assetId: asset.id, grossAmountEur: 50, executedAt: tsOffset(-3) });
    expect(record.status).toBe(201);
    await expectInvalidatedFrom(h, pid, rowsBefore, dayOffset(-3));

    // Refill, then delete: the same exact range invalidates again.
    await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    const primed = await snapshotRows(h, pid);
    expect((await snapshotState(h, pid))?.dirtyFrom ?? null).toBeNull();
    const dividendId = record.body.dividend.id as string;
    const del = await agent.delete(`/api/v1/portfolios/${pid}/dividends/${dividendId}`).set(...XRW);
    expect(del.status).toBe(204);
    await expectInvalidatedFrom(h, pid, primed, dayOffset(-3));
  });

  it('backdated cash movement invalidates from its own day (§16 rule 4)', async () => {
    const { h, agent, pid, rowsBefore } = await invalidationFixture();
    const res = await agent
      .post(`/api/v1/portfolios/${pid}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 250, executedAt: tsOffset(-4) });
    expect(res.status).toBe(201);
    await expectInvalidatedFrom(h, pid, rowsBefore, dayOffset(-4));

    // Refill reflects the deposit exactly from its day on.
    await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    const rows = await snapshotRows(h, pid);
    expect(Number(rows.find((r) => r.date === dayOffset(-5))!.valueEur)).toBeCloseTo(
      2 * 105 + 1 * 105,
      9,
    );
    const day4 = rows.find((r) => r.date === dayOffset(-4))!;
    expect(Number(day4.valueEur)).toBeCloseTo(3 * 106 + 250, 9);
    expect(Number(day4.flowEur)).toBeCloseTo(250, 9);
    expect(Object.values(day4.cashBySource as Record<string, number>)).toEqual([250]);
  });

  it('custom-asset value-point edits invalidate every holding portfolio from the changed day (§16 rule 7)', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const created = await agent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({
        name: 'Vintage Car',
        category: 'other',
        currency: 'EUR',
        initialPurchase: { quantity: 1, price: 500, fee: 0, executedAt: tsOffset(-6) },
      });
    expect(created.status).toBe(201);
    const carId = created.body.asset.id as string;
    const firstPut = await agent
      .put(`/api/v1/custom-assets/${carId}/value-points`)
      .set(...XRW)
      .send({
        points: [
          { date: dayOffset(-6), value: 500 },
          { date: dayOffset(-3), value: 600 },
        ],
      });
    expect(firstPut.status).toBe(200);
    await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    const rowsBefore = await snapshotRows(h, pid);
    expect(rowsBefore.map((r) => r.date)).toEqual([-6, -5, -4, -3, -2, -1].map(dayOffset));

    // Change only the -3 mark → affected from max(-3, first txn -6) = -3.
    const res = await agent
      .put(`/api/v1/custom-assets/${carId}/value-points`)
      .set(...XRW)
      .send({
        points: [
          { date: dayOffset(-6), value: 500 },
          { date: dayOffset(-3), value: 650 },
        ],
      });
    expect(res.status).toBe(200);
    await expectInvalidatedFrom(h, pid, rowsBefore, dayOffset(-3));

    // Refill picks up the new mark from its day on; earlier days untouched.
    await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    const rows = await snapshotRows(h, pid);
    expect(Number(rows.find((r) => r.date === dayOffset(-4))!.valueEur)).toBe(500);
    expect(Number(rows.find((r) => r.date === dayOffset(-3))!.valueEur)).toBe(650);
  });

  it('portfolio deletion cleans its snapshot rows and state (§16 rule 8)', async () => {
    const { h, agent } = await invalidationFixture();
    const createdRes = await agent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Doomed' });
    expect(createdRes.status).toBe(201);
    const doomedId = createdRes.body.portfolio.id as string;
    await agent
      .post(`/api/v1/portfolios/${doomedId}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 300, executedAt: tsOffset(-2) });
    const primeRes = await agent.get(`/api/v1/portfolios/${doomedId}/history?range=MAX`);
    expect(primeRes.status).toBe(200);
    expect((await snapshotRows(h, doomedId)).length).toBeGreaterThan(0);
    expect(await snapshotState(h, doomedId)).not.toBeNull();

    const del = await agent.delete(`/api/v1/portfolios/${doomedId}`).set(...XRW);
    expect(del.status).toBe(204);
    expect(await snapshotRows(h, doomedId)).toEqual([]);
    expect(await snapshotState(h, doomedId)).toBeNull();
  });
});
