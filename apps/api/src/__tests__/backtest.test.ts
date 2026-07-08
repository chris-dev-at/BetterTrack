import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { backtestResponseSchema } from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { backtestPreviewCacheKey } from '../services/backtest/backtestService';
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

  it('converts a mixed-currency basket (EUR + USD) through historical FX', async () => {
    // AAA (EUR) rises 10 %. UUU is flat at 100 USD, but the dollar strengthens
    // from 1.25 to 1.00 USD-per-EUR (EURUSD=X closes), so in EUR terms UUU goes
    // 80 → 100 = +25 %. A 50/50 basket therefore returns (10 + 25) / 2 = 17.5 %.
    const { h, agent } = await harnessWith((ref) => {
      if (ref.providerRef === 'EURUSD=X') {
        return cachedHistory([
          { time: tsOffset(-300), close: 1.25 },
          { time: tsOffset(-1), close: 1.0 },
        ]);
      }
      return cachedHistory([
        { time: tsOffset(-300), close: 100 },
        { time: tsOffset(-1), close: ref.providerRef === 'AAA' ? 110 : 100 },
      ]);
    });
    const a = await seedAsset(h, { providerRef: 'AAA', symbol: 'AAA' });
    const u = await seedAsset(h, {
      providerRef: 'UUU',
      symbol: 'UUU',
      name: 'US Asset',
      currency: 'USD',
      exchange: 'NYSE',
    });

    const res = await agent
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .send({
        positions: [
          { assetId: a.id, weight: 50 },
          { assetId: u.id, weight: 50 },
        ],
        range: 'MAX',
      });

    expect(res.status).toBe(200);
    expect(backtestResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.series[0].value).toBeCloseTo(100, 6);
    expect(res.body.stats.totalReturnPct).toBeCloseTo(17.5, 6);
    const uuu = res.body.contributions.find((c: { symbol: string }) => c.symbol === 'UUU');
    expect(uuu.returnPct).toBeCloseTo(25, 6);
  });

  it('overlays a USD benchmark (^GSPC) via historical FX', async () => {
    // ^GSPC rises 10 % in USD (5000 → 5500) while the dollar strengthens from
    // 1.25 to 1.00 USD-per-EUR, so the EUR-terms overlay is 4000 → 5500 = +37.5 %.
    const { h, agent } = await harnessWith((ref) => {
      if (ref.providerRef === 'EURUSD=X') {
        return cachedHistory([
          { time: tsOffset(-300), close: 1.25 },
          { time: tsOffset(-1), close: 1.0 },
        ]);
      }
      if (ref.providerRef === '^GSPC') {
        return cachedHistory([
          { time: tsOffset(-300), close: 5000 },
          { time: tsOffset(-1), close: 5500 },
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
      .send({ positions: [{ assetId: a.id, weight: 100 }], range: 'MAX', benchmark: '^GSPC' });

    expect(res.status).toBe(200);
    expect(backtestResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.stats.totalReturnPct).toBeCloseTo(10, 6);
    expect(res.body.benchmark.symbol).toBe('^GSPC');
    expect(res.body.benchmark.series[0].value).toBeCloseTo(100, 6);
    expect(res.body.benchmark.stats.totalReturnPct).toBeCloseTo(37.5, 6);
  });

  it('422s (FX_UNAVAILABLE) when the FX history provider is down, rather than 500ing', async () => {
    const { h, agent } = await harnessWith((ref) => {
      if (ref.providerRef === 'EURUSD=X') throw new Error('provider down, no cached copy');
      return cachedHistory([
        { time: tsOffset(-300), close: 100 },
        { time: tsOffset(-1), close: 110 },
      ]);
    });
    const u = await seedAsset(h, {
      providerRef: 'UUU',
      symbol: 'UUU',
      currency: 'USD',
      exchange: 'NYSE',
    });

    const res = await agent
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .send({ positions: [{ assetId: u.id, weight: 100 }], range: 'MAX' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('FX_UNAVAILABLE');
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

describe('POST /api/v1/backtest/preview — late-listing modes (§14)', () => {
  // The route-level "SpaceX case": AAA has 300 days of history and moves before
  // LLL lists 100 days ago, so the three modes give visibly different results.
  //   AAA: 100 → 150 (day −150) → 120        LLL: 50 → 55
  const lateHistory = (ref: { providerRef: string }) =>
    ref.providerRef === 'AAA'
      ? cachedHistory([
          { time: tsOffset(-300), close: 100 },
          { time: tsOffset(-150), close: 150 },
          { time: tsOffset(-1), close: 120 },
        ])
      : cachedHistory([
          { time: tsOffset(-100), close: 50 },
          { time: tsOffset(-1), close: 55 },
        ]);

  async function lateHarness() {
    const { h, agent, marketData } = await harnessWith(lateHistory);
    const a = await seedAsset(h, { providerRef: 'AAA', symbol: 'AAA' });
    const l = await seedAsset(h, { providerRef: 'LLL', symbol: 'LLL', name: 'Late Asset' });
    const positions = [
      { assetId: a.id, weight: 50 },
      { assetId: l.id, weight: 50 },
    ];
    return { agent, marketData, a, l, positions };
  }

  it('omitting the mode is byte-identical to an explicit clip (pre-§14 regression)', async () => {
    const { agent, positions } = await lateHarness();

    const omitted = await agent
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .send({ positions, range: '5Y' });
    const explicit = await agent
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .send({ positions, range: '5Y', mode: 'clip' });

    expect(omitted.status).toBe(200);
    expect(explicit.status).toBe(200);
    expect(omitted.body).toEqual(explicit.body);

    // Clip behavior is unchanged: window starts at the youngest constituent,
    // the notice names it, and the §14 response fields are inert.
    expect(omitted.body.mode).toBe('clip');
    expect(omitted.body.entryEvents).toEqual([]);
    expect(omitted.body.idleCashAvgPct).toBeNull();
    expect(omitted.body.notice).toBe(`Limited by LLL (data since ${dayOffset(-100)})`);
    expect(omitted.body.series[0].date).toBe(dayOffset(-100));
    // AAA carries 150 into the clipped t₀: 0.5·(120/150) + 0.5·(55/50) → 95.
    expect(omitted.body.series[omitted.body.series.length - 1].value).toBeCloseTo(95, 6);
  });

  it('cash mode runs the full window, reports the entry event and the idle-cash stat', async () => {
    const { agent, l, positions } = await lateHarness();

    const res = await agent
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .send({ positions, range: 'MAX', mode: 'cash' });

    expect(res.status).toBe(200);
    expect(backtestResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.mode).toBe('cash');
    // MAX in a full-window mode anchors at the EARLIEST history, not the common start.
    expect(res.body.series[0].date).toBe(dayOffset(-300));
    expect(res.body.series[0].value).toBeCloseTo(100, 6);
    expect(res.body.notice).toBeNull();

    // LLL's share waits as cash, then buys in at its first close (50):
    // end = 0.5·(120/100) + 0.5·(55/50) = 1.15 → 115.
    expect(res.body.series[res.body.series.length - 1].value).toBeCloseTo(115, 6);
    expect(res.body.entryEvents).toEqual([{ assetId: l.id, symbol: 'LLL', date: dayOffset(-100) }]);
    // Axis [−300, −150, −100, −1]; cash fractions 0.5, 0.5/1.25, 0, 0 → 22.5 %.
    expect(res.body.idleCashAvgPct).toBeCloseTo(22.5, 6);
  });

  it('redistribute mode splits the late share into AAA and rebalances on the entry day', async () => {
    const { agent, l, positions } = await lateHarness();

    const res = await agent
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .send({ positions, range: 'MAX', mode: 'redistribute' });

    expect(res.status).toBe(200);
    expect(backtestResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.mode).toBe('redistribute');
    expect(res.body.series[0].date).toBe(dayOffset(-300));
    expect(res.body.idleCashAvgPct).toBeNull();
    expect(res.body.entryEvents).toEqual([{ assetId: l.id, symbol: 'LLL', date: dayOffset(-100) }]);

    // All-in AAA until the entry (1 → 1.5 by day −150, carried to −100), then a
    // 50/50 rebalance: 0.75·(120/150) + 0.75·(55/50) = 1.425 → 142.5 — visibly
    // different from clip (95) and cash (115) on the same inputs.
    expect(res.body.series[res.body.series.length - 1].value).toBeCloseTo(142.5, 6);

    // Money-weighted contributions still sum to the total return.
    const sum = res.body.contributions.reduce(
      (acc: number, c: { contributionPct: number }) => acc + c.contributionPct,
      0,
    );
    expect(sum).toBeCloseTo(res.body.stats.totalReturnPct, 6);
  });

  it('two modes on identical inputs never share a memo entry (both compute)', async () => {
    const { agent, marketData, positions } = await lateHarness();
    const body = { positions, range: 'MAX' };

    const cash = await agent
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .send({ ...body, mode: 'cash' });
    expect(cash.status).toBe(200);
    expect(marketData.calls.history).toBe(2);

    const redistribute = await agent
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .send({ ...body, mode: 'redistribute' });
    expect(redistribute.status).toBe(200);
    // A fresh compute (2 more history fetches), not a memo hit from the other mode.
    expect(marketData.calls.history).toBe(4);
    expect(redistribute.body.series).not.toEqual(cash.body.series);
  });
});

describe('backtestPreviewCacheKey — §14 mode separation', () => {
  const input = {
    positions: [{ assetId: 'a1', weight: 50 }],
    range: '5Y' as const,
    benchmark: null,
  };

  it('an omitted mode and an explicit clip share one memo entry', () => {
    expect(backtestPreviewCacheKey('u1', input)).toBe(
      backtestPreviewCacheKey('u1', { ...input, mode: 'clip' }),
    );
  });

  it('each mode gets its own memo entry on otherwise identical inputs', () => {
    const keys = new Set([
      backtestPreviewCacheKey('u1', { ...input, mode: 'clip' }),
      backtestPreviewCacheKey('u1', { ...input, mode: 'cash' }),
      backtestPreviewCacheKey('u1', { ...input, mode: 'redistribute' }),
    ]);
    expect(keys.size).toBe(3);
  });
});
