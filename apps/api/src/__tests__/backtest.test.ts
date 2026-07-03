import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { backtestResponseSchema } from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createStubMarketData, type StubMarketDataControls } from '../testing/marketDataStubs';
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

/** CachedResult wrapper for stubbed provider history points. */
function cachedHistory(points: Array<{ time: string; close: number }>) {
  return { value: points, stale: false, asOf: Date.now() };
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

async function seedAsset(
  h: TestHarness,
  overrides: Partial<typeof schema.assets.$inferInsert> = {},
) {
  const [row] = await h.db
    .insert(schema.assets)
    .values({
      providerId: overrides.providerId ?? 'yahoo',
      providerRef: overrides.providerRef ?? 'AAA',
      type: overrides.type ?? 'stock',
      symbol: overrides.symbol ?? 'AAA',
      name: overrides.name ?? 'Asset A',
      currency: overrides.currency ?? 'EUR',
      exchange: overrides.exchange ?? 'XETRA',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('Failed to seed asset');
  return row;
}

/** A test app whose provider history is served by `history`, with the stub for call counts. */
async function harnessWith(history: StubMarketDataControls['history']) {
  const marketData = createStubMarketData({ history });
  const h = await createTestApp({ marketData });
  const user = await h.seedUser();
  const agent = await loginAgent(h.app, user.email, user.password);
  return { h, agent, marketData };
}

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

describe('POST /api/v1/backtest/preview', () => {
  it('requires authentication', async () => {
    const res = await request(harness.app)
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .send({ positions: [], range: '1Y' });
    expect(res.status).toBe(401);
  });

  it('backtests a two-asset EUR basket into a base-100 series + stats', async () => {
    // A and B both rise 10 % over the window; a 50/50 basket therefore opens at
    // 100 and ends at 110, and each contributes exactly half the total return.
    const { h, agent, marketData } = await harnessWith((ref) =>
      ref.providerRef === 'AAA'
        ? cachedHistory([
            { time: tsOffset(-300), close: 100 },
            { time: tsOffset(-1), close: 110 },
          ])
        : cachedHistory([
            { time: tsOffset(-300), close: 200 },
            { time: tsOffset(-1), close: 220 },
          ]),
    );
    const a = await seedAsset(h, { providerRef: 'AAA', symbol: 'AAA' });
    const b = await seedAsset(h, { providerRef: 'BBB', symbol: 'BBB', name: 'Asset B' });

    const res = await agent
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .send({
        positions: [
          { assetId: a.id, weight: 50 },
          { assetId: b.id, weight: 50 },
        ],
        range: 'MAX',
      });

    expect(res.status).toBe(200);
    expect(backtestResponseSchema.safeParse(res.body).success).toBe(true);

    // One history fetch per position, none for a (missing) benchmark.
    expect(marketData.calls.history).toBe(2);

    expect(res.body.series[0].value).toBeCloseTo(100, 6);
    expect(res.body.series[res.body.series.length - 1].value).toBeCloseTo(110, 6);
    expect(res.body.stats.totalReturnPct).toBeCloseTo(10, 6);
    // MAX anchors at the common start, so a full-history request is not "clipped".
    expect(res.body.notice).toBeNull();
    expect(res.body.benchmark).toBeNull();

    // Per-position contributions sum to the basket's total return (§6.6).
    const sum = res.body.contributions.reduce(
      (acc: number, c: { contributionPct: number }) => acc + c.contributionPct,
      0,
    );
    expect(sum).toBeCloseTo(res.body.stats.totalReturnPct, 6);
  });

  it('includes an EUR benchmark overlay when requested, on the same axis', async () => {
    const { h, agent } = await harnessWith((ref) => {
      if (ref.providerRef === '^GDAXI') {
        return cachedHistory([
          { time: tsOffset(-300), close: 15000 },
          { time: tsOffset(-1), close: 15750 },
        ]);
      }
      return cachedHistory([
        { time: tsOffset(-300), close: 100 },
        { time: tsOffset(-1), close: 110 },
      ]);
    });
    const a = await seedAsset(h, { providerRef: 'AAA', symbol: 'AAA' });

    const res = await agent
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .send({ positions: [{ assetId: a.id, weight: 100 }], range: 'MAX', benchmark: '^GDAXI' });

    expect(res.status).toBe(200);
    expect(backtestResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.benchmark).not.toBeNull();
    expect(res.body.benchmark.symbol).toBe('^GDAXI');
    // Overlay shares the basket's date axis, so both series line up point-for-point.
    expect(res.body.benchmark.series).toHaveLength(res.body.series.length);
    expect(res.body.benchmark.series[0].value).toBeCloseTo(100, 6);
    // DAX rose 5 % over the window (15000 → 15750).
    expect(res.body.benchmark.stats.totalReturnPct).toBeCloseTo(5, 6);
  });

  it('clips a window wider than the common start and carries the notice', async () => {
    // B's history only starts 100 days ago, so a 5Y request is limited by B.
    const { h, agent } = await harnessWith((ref) =>
      ref.providerRef === 'AAA'
        ? cachedHistory([
            { time: tsOffset(-300), close: 100 },
            { time: tsOffset(-1), close: 120 },
          ])
        : cachedHistory([
            { time: tsOffset(-100), close: 50 },
            { time: tsOffset(-1), close: 55 },
          ]),
    );
    const a = await seedAsset(h, { providerRef: 'AAA', symbol: 'AAA' });
    const b = await seedAsset(h, { providerRef: 'BBB', symbol: 'BBB', name: 'Asset B' });

    const res = await agent
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .send({
        positions: [
          { assetId: a.id, weight: 60 },
          { assetId: b.id, weight: 40 },
        ],
        range: '5Y',
      });

    expect(res.status).toBe(200);
    expect(res.body.notice).toBe(`Limited by BBB (data since ${dayOffset(-100)})`);
    expect(res.body.series[0].date).toBe(dayOffset(-100));
    expect(res.body.series[0].value).toBeCloseTo(100, 6);
  });

  it('serves an identical repeat request from the Redis memo (no second history fetch)', async () => {
    const { h, agent, marketData } = await harnessWith(() =>
      cachedHistory([
        { time: tsOffset(-300), close: 100 },
        { time: tsOffset(-1), close: 110 },
      ]),
    );
    const a = await seedAsset(h, { providerRef: 'AAA', symbol: 'AAA' });
    const body = { positions: [{ assetId: a.id, weight: 100 }], range: 'MAX' };

    const first = await agent
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .send(body);
    expect(first.status).toBe(200);
    expect(marketData.calls.history).toBe(1);

    const second = await agent
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .send(body);
    expect(second.status).toBe(200);
    // The memo answered without re-hitting the provider history.
    expect(marketData.calls.history).toBe(1);
    expect(second.body).toEqual(first.body);
  });

  it('404s an unknown / non-visible asset rather than 500ing', async () => {
    const { agent } = await harnessWith(() => cachedHistory([]));
    const res = await agent
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .send({
        positions: [{ assetId: '11111111-1111-7111-8111-111111111111', weight: 100 }],
        range: 'MAX',
      });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ASSET_NOT_FOUND');
  });

  it('422s an asset with no price history rather than 500ing', async () => {
    const { h, agent } = await harnessWith(() => cachedHistory([]));
    const a = await seedAsset(h, { providerRef: 'AAA', symbol: 'AAA' });
    const res = await agent
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .send({ positions: [{ assetId: a.id, weight: 100 }], range: 'MAX' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NO_PRICE_HISTORY');
  });

  it('maps an engine data-state failure (benchmark short of t₀) to a 422', async () => {
    // The basket starts 300 days ago but the benchmark only has recent data, so
    // it has no price on or before t₀ — a BacktestError, surfaced as a 422.
    const { h, agent } = await harnessWith((ref) =>
      ref.providerRef === '^GDAXI'
        ? cachedHistory([
            { time: tsOffset(-50), close: 15000 },
            { time: tsOffset(-1), close: 15200 },
          ])
        : cachedHistory([
            { time: tsOffset(-300), close: 100 },
            { time: tsOffset(-1), close: 110 },
          ]),
    );
    const a = await seedAsset(h, { providerRef: 'AAA', symbol: 'AAA' });
    const res = await agent
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .send({ positions: [{ assetId: a.id, weight: 100 }], range: 'MAX', benchmark: '^GDAXI' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BACKTEST_UNAVAILABLE');
  });

  it('rejects a malformed body (empty positions) with a 400', async () => {
    const user = await harness.seedUser({ email: 'x@bt.test', username: 'xuser' });
    const agent = await loginAgent(harness.app, user.email, user.password);
    const res = await agent
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .send({ positions: [], range: '1Y' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
