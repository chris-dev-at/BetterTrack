import request from 'supertest';
import type { Application } from 'express';
import { describe, expect, it } from 'vitest';

import type { CachedResult, HistoryInterval, PricePoint, Quote } from '@bettertrack/contracts';
import { portfolioHistoryResponseSchema } from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createStubMarketData } from '../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Client-selectable series interval end-to-end (IN3, board #76 item 2): the
 * finer 5-minute 1D auto grid (~156 points over a 13-hour trading day), explicit
 * intervals honored within the point budget, finer-than-budget requests
 * coarsened to the finest fit, the resolved interval echoed on every response,
 * `1d` serving the plain daily slice, daily-only ranges untouched, and the
 * strict query schema still rejecting unknown params. The pure resolution table
 * and grid math live in
 * `apps/api/src/services/portfolio/__tests__/portfolioHistoryInterval.test.ts`.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const MIN = 60_000;

function dayOffset(offset: number, refNow = Date.now()): string {
  const ms = Date.parse(`${new Date(refNow).toISOString().slice(0, 10)}T00:00:00.000Z`);
  return new Date(ms + offset * 86_400_000).toISOString().slice(0, 10);
}

function tsOffset(offset: number, refNow = Date.now()): string {
  return `${dayOffset(offset, refNow)}T00:00:00.000Z`;
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
  return def.id as string;
}

/** Daily closes for the value engine (`1d`-style fetches). */
function dailyCloses(days: number[], close: number, refNow: number): PricePoint[] {
  return days.map((d) => ({ time: `${dayOffset(d, refNow)}T00:00:00.000Z`, close }));
}

/** Candles on the request day from 08:00 UTC at `stepMs` spacing. */
function tradingDayCandles(refNow: number, count: number, stepMs: number): PricePoint[] {
  const base = Date.parse(`${dayOffset(0, refNow)}T08:00:00.000Z`);
  return Array.from({ length: count }, (_, i) => ({
    time: new Date(base + i * stepMs).toISOString(),
    close: 100 + i * (8 / (count - 1)), // 100 → 108 across the day, any spacing
  }));
}

/**
 * A stub routing on the provider interval, mirroring §5.3: `1m` serves a full
 * 13-hour trading day of 1-minute candles (08:00–20:59, 780 bars — the 5-minute
 * grid quantizes them to exactly 156 buckets), `15m`/`30m` serve the same day at
 * their native spacing, anything else the daily closes. Records every call so
 * fetch discipline per interval can be pinned.
 */
function buildStub(refNow: number) {
  const calls: Array<{ ref: string; interval: HistoryInterval | undefined }> = [];
  const days = [-8, -7, -6, -5, -4, -3, -2, -1, 0];
  const byInterval: Partial<Record<HistoryInterval, PricePoint[]>> = {
    '1m': tradingDayCandles(refNow, 13 * 60, 1 * MIN), // 08:00 … 20:59
    '15m': tradingDayCandles(refNow, 13 * 4, 15 * MIN), // 08:00 … 20:45
    '30m': tradingDayCandles(refNow, 13 * 2, 30 * MIN), // 08:00 … 20:30
  };
  const daily = dailyCloses(days, 105, refNow);
  const history = (
    ref: { providerRef: string },
    _range: unknown,
    interval?: HistoryInterval,
  ): CachedResult<PricePoint[]> => {
    calls.push({ ref: ref.providerRef, interval });
    const value = (interval && byInterval[interval]) || daily;
    return { value, stale: false, asOf: 0 };
  };
  const quote = (): CachedResult<Quote> => ({
    value: { price: 108, currency: 'EUR', prevClose: 105, asOf: new Date(refNow).toISOString() },
    stale: false,
    asOf: refNow,
  });
  return { calls, marketData: createStubMarketData({ history, quote }) };
}

describe('portfolio history interval selection (IN3, board #76)', () => {
  async function setup() {
    // Freeze the request day at 21:00 UTC so the whole 08:00–20:59 candle day
    // is in the past of "now" and on one UTC day.
    const refNow = Date.parse(`${dayOffset(0)}T21:00:00.000Z`);
    const stub = buildStub(refNow);
    const h: TestHarness = await createTestApp({
      marketData: stub.marketData,
      portfolioNow: () => refNow,
    });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const [asset] = await h.db
      .insert(schema.assets)
      .values({
        providerId: 'yahoo',
        providerRef: 'BAYN.DE',
        type: 'stock',
        symbol: 'BAYN.DE',
        name: 'Bayer AG',
        currency: 'EUR',
        exchange: 'XETRA',
      })
      .returning();
    const buy = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({
        assetId: asset!.id,
        side: 'buy',
        quantity: 5,
        price: 100,
        executedAt: tsOffset(-6, refNow),
      });
    expect(buy.status).toBe(201);
    // Warm the snapshot state so measured reads run the settled path.
    await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    return { agent, pid, stub, refNow };
  }

  it('1D auto serves the 5-minute grid — ~156 points over a 13-hour trading day, echoed as 5m', async () => {
    const { agent, pid, stub, refNow } = await setup();
    stub.calls.length = 0;

    const res = await agent.get(`/api/v1/portfolios/${pid}/history?range=1D`);
    expect(res.status).toBe(200);
    expect(portfolioHistoryResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.interval).toBe('5m'); // the resolved grid, echoed

    const today = dayOffset(0, refNow);
    const points = res.body.points as Array<{ date: string; time?: string; valueEur: number }>;
    const todayPoints = points.filter((p) => p.date === today);
    // The owner's "more 1D detail", pinned: 13 h × 12 buckets/h = 156 points.
    expect(todayPoints).toHaveLength(156);
    // A contiguous 5-minute grid: every consecutive gap is exactly 5 minutes.
    for (let i = 1; i < todayPoints.length; i += 1) {
      expect(Date.parse(todayPoints[i]!.time!) - Date.parse(todayPoints[i - 1]!.time!)).toBe(
        5 * MIN,
      );
    }
    // Performance stays aligned 1:1 and opens the window at 0 %.
    expect((res.body.performance as unknown[]).length).toBe(points.length);
    expect((res.body.performance as Array<{ pct: number }>)[0]!.pct).toBeCloseTo(0, 9);

    // Fetch discipline: the 5-minute grid pulls 1-minute candles (§5.3's 1D
    // row), exactly once for the one market asset.
    expect(stub.calls.filter((c) => c.interval === '1m').map((c) => c.ref)).toEqual(['BAYN.DE']);

    // Closing-seam equivalence survives the finer grid: the last intraday
    // point equals the fresh daily "today" value (the MAX tail).
    const max = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    const maxPoints = max.body.points as Array<{ valueEur: number }>;
    expect(points[points.length - 1]!.valueEur).toBeCloseTo(
      maxPoints[maxPoints.length - 1]!.valueEur,
      6,
    );
  });

  it('honors an explicit servable interval: 1D at 15m is the 15-minute grid, echoed as 15m', async () => {
    const { agent, pid, stub, refNow } = await setup();
    stub.calls.length = 0;

    const res = await agent.get(`/api/v1/portfolios/${pid}/history?range=1D&interval=15m`);
    expect(res.status).toBe(200);
    expect(res.body.interval).toBe('15m');
    const today = dayOffset(0, refNow);
    const todayPoints = (res.body.points as Array<{ date: string; time?: string }>).filter(
      (p) => p.date === today,
    );
    expect(todayPoints).toHaveLength(13 * 4); // 52 quarter-hour buckets
    for (let i = 1; i < todayPoints.length; i += 1) {
      expect(Date.parse(todayPoints[i]!.time!) - Date.parse(todayPoints[i - 1]!.time!)).toBe(
        15 * MIN,
      );
    }
    // An explicit 15m grid fetches native 15-minute candles, not 1-minute ones.
    expect(stub.calls.filter((c) => c.interval === '15m').map((c) => c.ref)).toEqual(['BAYN.DE']);
    expect(stub.calls.some((c) => c.interval === '1m')).toBe(false);
  });

  it('coarsens a finer-than-budget request to the finest fit: 1D at 1m serves the 5m grid', async () => {
    const { agent, pid } = await setup();

    const requested = await agent.get(`/api/v1/portfolios/${pid}/history?range=1D&interval=1m`);
    const auto = await agent.get(`/api/v1/portfolios/${pid}/history?range=1D`);
    expect(requested.status).toBe(200);
    // The finest-fit rule (documented in contracts): a 1-minute 1D grid would
    // be ~1440 worst-case points — over budget — so the request lands on the
    // finest grid that fits, and the echo says so.
    expect(requested.body.interval).toBe('5m');
    expect(requested.body.points).toEqual(auto.body.points);
    expect(requested.body.performance).toEqual(auto.body.performance);
  });

  it('1W: sub-hourly requests coarsen to the hourly grid; 1d serves the plain daily slice', async () => {
    const { agent, pid, refNow } = await setup();

    const coarsened = await agent.get(`/api/v1/portfolios/${pid}/history?range=1W&interval=30m`);
    expect(coarsened.status).toBe(200);
    expect(coarsened.body.interval).toBe('1h'); // 30m × 7 days busts the budget
    const today = dayOffset(0, refNow);
    const todayPoints = (coarsened.body.points as Array<{ date: string; time?: string }>).filter(
      (p) => p.date === today,
    );
    expect(todayPoints).toHaveLength(13); // 08:00 … 20:00, one per market hour
    for (const p of coarsened.body.points as Array<{ time?: string }>) {
      expect(typeof p.time).toBe('string');
    }

    const dailySlice = await agent.get(`/api/v1/portfolios/${pid}/history?range=1W&interval=1d`);
    expect(dailySlice.status).toBe(200);
    expect(dailySlice.body.interval).toBe('1d');
    const dailyPoints = dailySlice.body.points as Array<{ date: string; time?: string }>;
    expect(dailyPoints.length).toBeGreaterThan(0);
    // The daily grid: one point per day, no intraday timestamps.
    for (const p of dailyPoints) expect(p.time).toBeUndefined();
    expect(new Set(dailyPoints.map((p) => p.date)).size).toBe(dailyPoints.length);
  });

  it('echoes the established auto grids elsewhere: 1M → 144m, MAX → 1d', async () => {
    const { agent, pid } = await setup();

    const month = await agent.get(`/api/v1/portfolios/${pid}/history?range=1M`);
    expect(month.status).toBe(200);
    expect(month.body.interval).toBe('144m');
    expect(portfolioHistoryResponseSchema.safeParse(month.body).success).toBe(true);

    const max = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(max.status).toBe(200);
    expect(max.body.interval).toBe('1d');
  });

  it('daily-only ranges resolve every interval to 1d with the series unchanged', async () => {
    const { agent, pid } = await setup();

    const auto = await agent.get(`/api/v1/portfolios/${pid}/history?range=6M`);
    const finer = await agent.get(`/api/v1/portfolios/${pid}/history?range=6M&interval=5m`);
    expect(auto.status).toBe(200);
    expect(finer.status).toBe(200);
    expect(auto.body.interval).toBe('1d');
    expect(finer.body.interval).toBe('1d');
    // Byte-identical series — IN3 changes nothing but the echo on daily ranges.
    expect(finer.body).toEqual(auto.body);
  });

  it('strict query schema: unknown params and unknown interval values are 400s', async () => {
    const { agent, pid } = await setup();

    const unknownParam = await agent.get(
      `/api/v1/portfolios/${pid}/history?range=1D&granularity=5m`,
    );
    expect(unknownParam.status).toBe(400);
    expect(unknownParam.body.error?.code).toBe('VALIDATION_ERROR');

    const unknownInterval = await agent.get(
      `/api/v1/portfolios/${pid}/history?range=1D&interval=7m`,
    );
    expect(unknownInterval.status).toBe(400);
    expect(unknownInterval.body.error?.code).toBe('VALIDATION_ERROR');
  });
});
