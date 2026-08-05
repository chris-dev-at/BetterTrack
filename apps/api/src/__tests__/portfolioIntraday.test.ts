import request from 'supertest';
import type { Application } from 'express';
import { describe, expect, it } from 'vitest';

import type { CachedResult, HistoryInterval, PricePoint, Quote } from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createStubMarketData } from '../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * V5-P1 intraday portfolio series (issue #556): the short ranges 1D/1W/1M render
 * a sub-daily curve instead of ~2 daily closes (2026-07-20 point-budget rework —
 * longer 6M/1Y/5Y ranges downsample the daily series instead, covered in
 * portfolio.test.ts). End-to-end over the real snapshot layer + provider stub:
 * density, the timestamped shape, seamless stitching to the fresh "today" value,
 * custom-asset carry-forward, per-asset provider discipline, and the #555
 * conditional-request round-trip.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const MIN = 60_000;

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

async function defaultPortfolioId(agent: ReturnType<typeof request.agent>): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  expect(res.status).toBe(200);
  const def = res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault);
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

/** Daily closes for the value engine (`1d` interval). */
function dailyCloses(days: number[], close: number): PricePoint[] {
  return days.map((d) => ({ time: `${dayOffset(d)}T00:00:00.000Z`, close }));
}

/** 30 native candles at 15-minute spacing ending "now" (fixed per test run). */
function intradayCandles(refNow: number, count: number, start: number, step: number): PricePoint[] {
  return Array.from({ length: count }, (_, i) => ({
    time: new Date(refNow - (count - 1 - i) * 15 * MIN).toISOString(),
    close: start + i * step,
  }));
}

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
}

/**
 * A stub whose history routes on the interval: intraday candles for the
 * fine-grained 1D/1W fetch, daily closes otherwise. Records every call so the
 * intraday fetch can be counted per asset/interval.
 */
function buildStub(refNow: number) {
  const calls: Array<{ ref: string; interval: HistoryInterval | undefined }> = [];
  const days = [-8, -7, -6, -5, -4, -3, -2, -1, 0];
  const dailyByRef: Record<string, PricePoint[]> = {
    'BAYN.DE': dailyCloses(days, 105),
    AAPL: dailyCloses(days, 210),
    'EURUSD=X': dailyCloses(days, 1.1),
  };
  const intradayByRef: Record<string, PricePoint[]> = {
    'BAYN.DE': intradayCandles(refNow, 30, 104, 0.1), // 104 → 106.9
    AAPL: intradayCandles(refNow, 30, 210, 0.2), // 210 → 215.8
  };
  const history = (
    ref: { providerRef: string },
    _range: unknown,
    interval?: HistoryInterval,
  ): CachedResult<PricePoint[]> => {
    calls.push({ ref: ref.providerRef, interval });
    const intraday = interval === '15m' || interval === '30m';
    const value = (intraday ? intradayByRef[ref.providerRef] : dailyByRef[ref.providerRef]) ?? [];
    return { value, stale: false, asOf: 0 };
  };
  const quote = (ref: { providerRef: string }): CachedResult<Quote> => {
    const price = { 'BAYN.DE': 108, AAPL: 216, 'EURUSD=X': 1.1 }[ref.providerRef];
    if (price === undefined) throw new Error(`no quote for ${ref.providerRef}`);
    return {
      value: {
        price,
        currency: ref.providerRef === 'AAPL' ? 'USD' : 'EUR',
        prevClose: price,
        asOf: new Date().toISOString(),
      },
      stale: false,
      asOf: Date.now(),
    };
  };
  return { calls, marketData: createStubMarketData({ history, quote }) };
}

describe('intraday portfolio series (#556)', () => {
  async function setup(options: { refNow?: number; portfolioNow?: () => number } = {}) {
    const refNow = options.refNow ?? Date.now();
    const stub = buildStub(refNow);
    const h = await createTestApp({
      marketData: stub.marketData,
      portfolioNow: options.portfolioNow,
    });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const bayn = await seedAsset(h);
    const aapl = await seedAsset(h, {
      providerRef: 'AAPL',
      symbol: 'AAPL',
      currency: 'USD',
      exchange: 'NASDAQ',
    });

    await buy(agent, pid, bayn.id, 5, 100, tsOffset(-6));
    await buy(agent, pid, aapl.id, 3, 200, tsOffset(-4));
    // A custom (manual-provider) asset: no intraday history — must carry forward.
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
    return { h, agent, pid, stub };
  }

  it('renders a dense, timestamped 1D curve that stitches to the fresh today value', async () => {
    const { agent, pid, stub } = await setup();

    // Warm the snapshot state so both reads below run the settled path.
    await agent.get(`/api/v1/portfolios/${pid}/history?range=1D`);
    stub.calls.length = 0;

    const res = await agent.get(`/api/v1/portfolios/${pid}/history?range=1D`);
    expect(res.status).toBe(200);
    const points = res.body.points as Array<{ date: string; time?: string; valueEur: number }>;
    const performance = res.body.performance as Array<{ date: string; time?: string; pct: number }>;

    // Dense, not two closes (acceptance: ≥20 intraday points).
    expect(points.length).toBeGreaterThanOrEqual(20);
    // Every intraday point carries a timestamp; the curve is time-ordered.
    for (let i = 0; i < points.length; i += 1) {
      expect(typeof points[i]!.time).toBe('string');
      expect(Number.isFinite(points[i]!.valueEur)).toBe(true);
      if (i > 0) {
        expect(Date.parse(points[i]!.time!)).toBeGreaterThan(Date.parse(points[i - 1]!.time!));
      }
    }
    // Performance is aligned 1:1 and timestamped.
    expect(performance.length).toBe(points.length);
    expect(typeof performance[0]!.time).toBe('string');
    expect(performance[0]!.pct).toBeCloseTo(0, 9); // window opens at 0 %

    // Stitching: the last intraday point equals the daily series' fresh "today"
    // value (no gap, no double-count) — compare against the MAX range's tail.
    const max = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    const maxPoints = max.body.points as Array<{ date: string; valueEur: number }>;
    const maxToday = maxPoints[maxPoints.length - 1]!;
    const last = points[points.length - 1]!;
    expect(last.date).toBe(dayOffset(0));
    expect(last.valueEur).toBeCloseTo(maxToday.valueEur, 6);
    // Every point is the whole portfolio incl. the carried-forward custom asset,
    // so the curve never drops below the custom asset's flat value.
    for (const p of points) expect(p.valueEur).toBeGreaterThan(500);

    // Provider discipline: exactly one intraday fetch per MARKET asset (the two
    // yahoo symbols); the manual custom asset is never fetched intraday.
    const intradayFetches = stub.calls.filter((c) => c.interval === '15m');
    expect(intradayFetches.length).toBe(2);
    expect(intradayFetches.map((c) => c.ref).sort()).toEqual(['AAPL', 'BAYN.DE']);
  });

  it('keeps a 1D request on one captured pre-midnight UTC day', async () => {
    const asOfDay = new Date().toISOString().slice(0, 10);
    const dayStartMs = Date.parse(`${asOfDay}T00:00:00.000Z`);
    const beforeMidnightMs = dayStartMs + 24 * 60 * MIN - 1;
    const afterMidnightMs = beforeMidnightMs + 1;
    let exerciseBoundaryClock = false;
    let boundaryClockCalls = 0;
    const portfolioNow = () => {
      if (!exerciseBoundaryClock) return Date.now();
      boundaryClockCalls += 1;
      return boundaryClockCalls === 1 ? beforeMidnightMs : afterMidnightMs;
    };

    const { agent, pid } = await setup({ refNow: beforeMidnightMs, portfolioNow });
    exerciseBoundaryClock = true;

    const res = await agent.get(`/api/v1/portfolios/${pid}/history?range=1D`);
    expect(res.status).toBe(200);
    // `getHistory` must not read a new clock after its async snapshot/candle
    // work. A second call returns tomorrow here and used to remove every
    // requested-day candle from the 1D curve.
    expect(boundaryClockCalls).toBe(1);

    const points = res.body.points as Array<{ date: string; time?: string }>;
    const previousDay = new Date(dayStartMs - 24 * 60 * MIN).toISOString().slice(0, 10);
    expect([...new Set(points.map((point) => point.date))]).toEqual([previousDay, asOfDay]);
    // The captured request day retains its intraday curve rather than degrading
    // to its one daily fallback point after the simulated rollover.
    expect(points.filter((point) => point.date === asOfDay)).toHaveLength(30);
  });

  it('honours conditional requests on the intraday series (304 round-trip)', async () => {
    const { agent, pid } = await setup();
    // Settle the snapshot state first so the two validated reads are identical.
    await agent.get(`/api/v1/portfolios/${pid}/history?range=1D`);

    const first = await agent.get(`/api/v1/portfolios/${pid}/history?range=1D`);
    expect(first.status).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();

    const second = await agent
      .get(`/api/v1/portfolios/${pid}/history?range=1D`)
      .set('If-None-Match', etag);
    expect(second.status).toBe(304);
    expect(second.text).toBe('');
  });

  it('renders an hourly 1W curve (denser than two closes)', async () => {
    const { agent, pid } = await setup();
    const res = await agent.get(`/api/v1/portfolios/${pid}/history?range=1W`);
    expect(res.status).toBe(200);
    const points = res.body.points as Array<{ time?: string; valueEur: number }>;
    // 30 half-hourly candles over the last hours quantize to hourly buckets —
    // several points, never the old two-close 1W slice.
    expect(points.length).toBeGreaterThan(2);
    for (const p of points) expect(typeof p.time).toBe('string');
  });

  it('renders a sub-daily 1M curve via a 30-minute fetch, stitching to today', async () => {
    const { agent, pid, stub } = await setup();

    // Warm the snapshot state so the measured read runs the settled path.
    await agent.get(`/api/v1/portfolios/${pid}/history?range=1M`);
    stub.calls.length = 0;

    const res = await agent.get(`/api/v1/portfolios/${pid}/history?range=1M`);
    expect(res.status).toBe(200);
    const points = res.body.points as Array<{ date: string; time?: string; valueEur: number }>;
    const performance = res.body.performance as Array<{ time?: string; pct: number }>;

    // Denser than the ~few-daily-point slice, and every point is timestamped and
    // time-ordered (the recent day is sub-daily; older days are daily fallbacks).
    expect(points.length).toBeGreaterThan(2);
    for (let i = 0; i < points.length; i += 1) {
      expect(typeof points[i]!.time).toBe('string');
      if (i > 0) {
        expect(Date.parse(points[i]!.time!)).toBeGreaterThan(Date.parse(points[i - 1]!.time!));
      }
    }
    // The recent window is genuinely sub-daily: at least one calendar day carries
    // more than one point.
    const perDay = new Map<string, number>();
    for (const p of points) perDay.set(p.date, (perDay.get(p.date) ?? 0) + 1);
    expect([...perDay.values()].some((n) => n > 1)).toBe(true);

    // Performance stays aligned 1:1 and opens the window at 0 %.
    expect(performance.length).toBe(points.length);
    expect(performance[0]!.pct).toBeCloseTo(0, 9);

    // Stitching: the last point equals the fresh daily "today" value (MAX tail).
    const max = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    const maxPoints = max.body.points as Array<{ valueEur: number }>;
    expect(points[points.length - 1]!.valueEur).toBeCloseTo(
      maxPoints[maxPoints.length - 1]!.valueEur,
      6,
    );

    // Provider discipline: exactly one 30-minute fetch per MARKET asset; the
    // manual custom asset is never fetched intraday.
    const thirtyMinFetches = stub.calls.filter((c) => c.interval === '30m');
    expect(thirtyMinFetches.map((c) => c.ref).sort()).toEqual(['AAPL', 'BAYN.DE']);
  });
});

/**
 * A position opened AND fully closed inside one day has no EUR anchor on either
 * side, so it can never be plotted at a bucket (#1120 review). Its trades must
 * therefore stay day-anchored on BOTH curves: step its cash legs and the value
 * curve dips by the whole position; book its TWR flows at their instants and
 * the % curve's denominator carries the buy's cost for the hours it was held —
 * a phantom drawdown that then recovers.
 */
describe('intraday same-day round trip stays day-anchored (#1120 review)', () => {
  /** A fixed past day: 10:00/15:00 there are never in the future, whatever the clock. */
  const RT = -3;
  const HELD_CLOSE = 105;

  /** Flat 30-minute candles 09:00 → 17:00 on the round-trip day. */
  function roundTripDayCandles(): PricePoint[] {
    const base = Date.parse(`${dayOffset(RT)}T09:00:00.000Z`);
    return Array.from({ length: 17 }, (_, i) => ({
      time: new Date(base + i * 30 * MIN).toISOString(),
      close: HELD_CLOSE,
    }));
  }

  function roundTripStub() {
    const days = [-10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 0];
    const daily: Record<string, PricePoint[]> = {
      'BAYN.DE': dailyCloses(days, HELD_CLOSE),
      'SAP.DE': dailyCloses(days, 112),
    };
    const history = (
      ref: { providerRef: string },
      _range: unknown,
      interval?: HistoryInterval,
    ): CachedResult<PricePoint[]> => {
      const intraday = interval === '15m' || interval === '30m';
      // Only the held asset carries candles — it alone builds the day's grid.
      const value = intraday
        ? ref.providerRef === 'BAYN.DE'
          ? roundTripDayCandles()
          : []
        : (daily[ref.providerRef] ?? []);
      return { value, stale: false, asOf: 0 };
    };
    const quote = (ref: { providerRef: string }): CachedResult<Quote> => ({
      value: {
        price: ref.providerRef === 'BAYN.DE' ? HELD_CLOSE : 112,
        currency: 'EUR',
        prevClose: HELD_CLOSE,
        asOf: new Date().toISOString(),
      },
      stale: false,
      asOf: Date.now(),
    });
    return createStubMarketData({ history, quote });
  }

  it('keeps the value flat and the % curve free of the phantom drawdown', async () => {
    const h = await createTestApp({ marketData: roundTripStub() });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const held = await seedAsset(h);
    const flipped = await seedAsset(h, {
      providerRef: 'SAP.DE',
      symbol: 'SAP.DE',
      name: 'SAP SE',
    });

    // A stable €1050 base position across the whole window …
    await buy(agent, pid, held.id, 10, 100, tsOffset(-10));
    // … plus 10 units bought at 110 and sold at 112 within one past day (+€20).
    await buy(agent, pid, flipped.id, 10, 110, `${dayOffset(RT)}T10:00:00.000Z`);
    const sell = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({
        assetId: flipped.id,
        side: 'sell',
        quantity: 10,
        price: 112,
        executedAt: `${dayOffset(RT)}T15:00:00.000Z`,
      });
    expect(sell.status).toBe(201);

    const res = await agent.get(`/api/v1/portfolios/${pid}/history?range=1M`);
    expect(res.status).toBe(200);
    const points = res.body.points as Array<{ date: string; valueEur: number }>;
    const performance = res.body.performance as Array<{ date: string; pct: number }>;

    const rtDay = dayOffset(RT);
    const rtPoints = points.filter((p) => p.date === rtDay);
    const rtPerf = performance.filter((p) => p.date === rtDay);
    // The day really is sub-daily — the held asset's candles give it a grid, so
    // there are buckets between the 10:00 buy and the 15:00 sell to fabricate on.
    expect(rtPoints.length).toBeGreaterThanOrEqual(2);
    // Value: every bucket is the untouched €1050 base position.
    for (const p of rtPoints) expect(p.valueEur).toBeCloseTo(1050, 6);
    // Performance: ONE level for the whole day — the +€20 lands at the day
    // boundary. Per-instant flows would put the buy's €1100 in the denominator
    // between 10:00 and 15:00 (1050 / 2150 ⇒ roughly −50 %).
    for (const p of rtPerf) expect(p.pct).toBeCloseTo(rtPerf[0]!.pct, 9);
    // The window opens at 0 % and never dips below it anywhere.
    expect(performance[0]!.pct).toBeCloseTo(0, 9);
    for (const p of performance) expect(p.pct).toBeGreaterThan(-1e-9);
    // The round trip's gain is real and still lands: +20 on the 1050 base.
    expect(performance[performance.length - 1]!.pct).toBeCloseTo((1070 / 1050 - 1) * 100, 6);
  });
});
