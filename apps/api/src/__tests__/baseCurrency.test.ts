import request from 'supertest';
import type { Application } from 'express';
import { describe, expect, it } from 'vitest';

import {
  allocateResponseSchema,
  assetDetailResponseSchema,
  backtestResponseSchema,
  portfolioHistoryResponseSchema,
  portfolioResponseSchema,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createStubMarketData, type StubMarketDataControls } from '../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Per-user base currency, end to end (§5.4, §13.3 V3-P10d).
 *
 * §5.4's binding design: stored amounts stay native, EUR is only the *default*
 * base, and every conversion routes through `services/currency` with the base
 * as a parameter. These tests pin the V3-P10d acceptance criteria over the
 * wire: a USD user sees consistent USD everywhere (overview, holdings, value &
 * performance curves via **daily historical FX**, asset detail, allocator,
 * backtest), an EUR user's numbers are byte-identical to before, and no stored
 * value changes when the base does.
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

/** A `CachedResult<Quote>` for a stubbed spot quote in `currency`. */
function cachedQuote(price: number, opts: { currency?: string } = {}) {
  return {
    value: {
      price,
      currency: opts.currency ?? 'EUR',
      prevClose: null,
      asOf: new Date().toISOString(),
    },
    stale: false,
    asOf: Date.now(),
  };
}

/** CachedResult wrapper for stubbed provider history points. */
function cachedHistory(points: Array<{ time: string; close: number }>) {
  return { value: points, stale: false, asOf: Date.now() };
}

type Agent = ReturnType<typeof request.agent>;

async function loginAgent(app: Application, identifier: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

/** Flip the logged-in user's base currency via the settings endpoint. */
async function setBase(agent: Agent, baseCurrency: string): Promise<void> {
  const res = await agent
    .patch('/api/v1/settings/account')
    .set(...XRW)
    .send({ baseCurrency });
  expect(res.status).toBe(200);
  expect(res.body.baseCurrency).toBe(baseCurrency);
}

/** Resolve the caller's default ("Main") portfolio id via the scoped list endpoint. */
async function defaultPortfolioId(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  expect(res.status).toBe(200);
  const def = res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault);
  expect(def).toBeTruthy();
  return def.id as string;
}

let assetSeq = 0;
async function seedAsset(
  h: TestHarness,
  overrides: Partial<typeof schema.assets.$inferInsert> = {},
) {
  assetSeq += 1;
  const symbol = overrides.symbol ?? `BASE${assetSeq}`;
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

/** A logged-in harness with the given market-data stubs. */
async function harnessWith(controls: StubMarketDataControls = {}) {
  const h = await createTestApp({ marketData: createStubMarketData(controls) });
  const user = await h.seedUser();
  const agent = await loginAgent(h.app, user.email, user.password);
  return { h, agent, user };
}

describe('portfolio overview in the user base (§5.4, V3-P10d)', () => {
  /**
   * One EUR asset (2 shares @ 100 €) + 100 € cash, EURUSD flat at 1.25 for
   * both spot and every stored day, so spot- and historical-rate call sites
   * agree on the expected numbers.
   */
  async function seededOverviewHarness() {
    const { h, agent } = await harnessWith({
      quote: (ref) =>
        ref.providerRef === 'EURUSD=X' ? cachedQuote(1.25, { currency: 'USD' }) : cachedQuote(100),
      history: (ref) => {
        if (ref.providerRef !== 'EURUSD=X') throw new Error('no provider history');
        return cachedHistory([
          { time: tsOffset(-2), close: 1.25 },
          { time: tsOffset(-1), close: 1.25 },
        ]);
      },
    });
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(h);
    await agent
      .post(`/api/v1/portfolios/${pid}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 100 })
      .expect(201);
    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 2, price: 100, executedAt: tsOffset(-1) })
      .expect(201);
    return { h, agent, pid, asset };
  }

  it('a USD user sees holdings, cash and totals in USD; the EUR baseline stays intact', async () => {
    const { agent, pid } = await seededOverviewHarness();

    // EUR baseline first (the pre-V3-P10d behaviour must be unchanged).
    const eur = await agent.get(`/api/v1/portfolios/${pid}`);
    expect(eur.status).toBe(200);
    expect(portfolioResponseSchema.safeParse(eur.body).success).toBe(true);
    expect(eur.body.baseCurrency).toBe('EUR');
    expect(eur.body.holdings[0].marketValueEur).toBeCloseTo(200, 6);
    expect(eur.body.totals.cashEur).toBeCloseTo(100, 6);
    expect(eur.body.totals.totalValueEur).toBeCloseTo(300, 6);

    await setBase(agent, 'USD');
    const usd = await agent.get(`/api/v1/portfolios/${pid}`);
    expect(usd.status).toBe(200);
    expect(portfolioResponseSchema.safeParse(usd.body).success).toBe(true);
    // The response declares its denomination; every money figure is × 1.25.
    expect(usd.body.baseCurrency).toBe('USD');
    expect(usd.body.holdings[0].marketValueEur).toBeCloseTo(250, 6);
    expect(usd.body.totals.marketValueEur).toBeCloseTo(250, 6);
    expect(usd.body.totals.cashEur).toBeCloseTo(125, 6);
    expect(usd.body.totals.totalValueEur).toBeCloseTo(375, 6);

    // Switching back to EUR reproduces the original response exactly —
    // conversion is read-time only, so it must be perfectly reversible.
    await setBase(agent, 'EUR');
    const eurAgain = await agent.get(`/api/v1/portfolios/${pid}`);
    expect(eurAgain.body).toEqual(eur.body);
  });

  it('stored amounts never change with the base — native prices and EUR cash rows (§5.4)', async () => {
    const { h, agent, pid } = await seededOverviewHarness();
    const before = {
      txns: await h.db.select().from(schema.transactions),
      cash: await h.db.select().from(schema.portfolioCashMovements),
    };
    // The write path stored the native inputs verbatim.
    expect(before.txns).toHaveLength(1);
    expect(Number(before.txns[0]!.price)).toBe(100);
    expect(Number(before.txns[0]!.quantity)).toBe(2);
    expect(before.cash).toHaveLength(1);
    expect(Number(before.cash[0]!.amountEur)).toBe(100);

    // Switching the base and reading everything re-denominates responses only.
    await setBase(agent, 'USD');
    await agent.get(`/api/v1/portfolios/${pid}`).expect(200);
    await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`).expect(200);

    const after = {
      txns: await h.db.select().from(schema.transactions),
      cash: await h.db.select().from(schema.portfolioCashMovements),
    };
    expect(after).toEqual(before);
  });

  it('422s (BASE_FX_UNAVAILABLE) when the base spot rate is missing, instead of silently serving EUR', async () => {
    const { agent } = await harnessWith({
      quote: () => {
        throw new Error('provider down, no cached copy');
      },
    });
    const pid = await defaultPortfolioId(agent);
    await agent
      .post(`/api/v1/portfolios/${pid}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 100 })
      .expect(201);

    // EUR needs no FX — identical to today.
    await agent.get(`/api/v1/portfolios/${pid}`).expect(200);

    await setBase(agent, 'USD');
    const res = await agent.get(`/api/v1/portfolios/${pid}`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BASE_FX_UNAVAILABLE');
  });
});

describe('value & performance curves in the user base — daily historical FX (V3-P10d)', () => {
  it('converts each day at that day’s rate (never one spot rate) with nearest-prior fallback', async () => {
    // Asset closes 100 → 110 (EUR, +10 %); EURUSD closes 1.25 → 1.10. The spot
    // quote is a deliberately wrong 1.30 tripwire: if any point used it, the
    // expected per-day products below would not match.
    const { h, agent } = await harnessWith({
      quote: (ref) =>
        ref.providerRef === 'EURUSD=X' ? cachedQuote(1.3, { currency: 'USD' }) : cachedQuote(110),
      history: (ref) => {
        if (ref.providerRef !== 'EURUSD=X') throw new Error('no provider history');
        // No close for today — today's point must fall back to the nearest
        // PRIOR close (1.10), per the existing §5.3 rule.
        return cachedHistory([
          { time: tsOffset(-2), close: 1.25 },
          { time: tsOffset(-1), close: 1.1 },
        ]);
      },
    });
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(h);
    // Stored daily closes are the series' price layer (the outage fallback).
    await h.db.insert(schema.priceHistory).values([
      { assetId: asset.id, date: dayOffset(-2), close: '100' },
      { assetId: asset.id, date: dayOffset(-1), close: '110' },
    ]);
    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 2, price: 100, executedAt: tsOffset(-2) })
      .expect(201);

    // EUR baseline: 200 → 220, performance +10 % (pre-V3-P10d behaviour).
    const eur = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(eur.status).toBe(200);
    expect(portfolioHistoryResponseSchema.safeParse(eur.body).success).toBe(true);
    expect(eur.body.baseCurrency).toBe('EUR');
    const eurByDate = new Map(
      eur.body.points.map((p: { date: string; valueEur: number }) => [p.date, p.valueEur]),
    );
    expect(eurByDate.get(dayOffset(-2))).toBeCloseTo(200, 6);
    expect(eurByDate.get(dayOffset(-1))).toBeCloseTo(220, 6);
    expect(eur.body.performance.at(-1)!.pct).toBeCloseTo(10, 6);

    await setBase(agent, 'USD');
    const usd = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(usd.status).toBe(200);
    expect(portfolioHistoryResponseSchema.safeParse(usd.body).success).toBe(true);
    expect(usd.body.baseCurrency).toBe('USD');
    const usdByDate = new Map(
      usd.body.points.map((p: { date: string; valueEur: number }) => [p.date, p.valueEur]),
    );
    // Day −2: 200 € × 1.25; day −1: 220 € × 1.10 — per-day rates, so the two
    // factors differ. A single spot rate (1.30) would put both at ×1.30.
    expect(usdByDate.get(dayOffset(-2))).toBeCloseTo(250, 6);
    expect(usdByDate.get(dayOffset(-1))).toBeCloseTo(242, 6);
    // Today has no FX close → nearest-prior 1.10 applies (220 € × 1.10).
    expect(usdByDate.get(dayOffset(0))).toBeCloseTo(242, 6);
    // The curves share their date grid — no day was dropped by conversion.
    expect(usd.body.points.map((p: { date: string }) => p.date)).toEqual(
      eur.body.points.map((p: { date: string }) => p.date),
    );

    // USD-terms TWR carries the FX leg: 250 → 242 = −3.2 %, not the EUR +10 %.
    expect(usd.body.performance.at(-1)!.pct).toBeCloseTo(-3.2, 6);

    // Back to EUR: byte-identical to the first response (read-time only).
    await setBase(agent, 'EUR');
    const eurAgain = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
    expect(eurAgain.body).toEqual(eur.body);
  });
});

describe('asset detail converted price in the user base (V3-P10d)', () => {
  it('converts the native price into USD for a USD user and omits it when native == base', async () => {
    const { h, agent } = await harnessWith({
      quote: (ref) => {
        if (ref.providerRef === 'EURUSD=X') return cachedQuote(1.25, { currency: 'USD' });
        if (ref.providerRef === 'AAPL') return cachedQuote(50, { currency: 'USD' });
        return cachedQuote(100);
      },
    });
    const eurAsset = await seedAsset(h);
    const usdAsset = await seedAsset(h, {
      providerRef: 'AAPL',
      symbol: 'AAPL',
      currency: 'USD',
      exchange: 'NASDAQ',
    });

    // EUR baseline: an EUR asset needs no conversion → eurPrice absent.
    const eurView = await agent.get(`/api/v1/assets/${eurAsset.id}`);
    expect(eurView.status).toBe(200);
    expect(assetDetailResponseSchema.safeParse(eurView.body).success).toBe(true);
    expect(eurView.body.baseCurrency).toBe('EUR');
    expect(eurView.body).not.toHaveProperty('eurPrice');

    await setBase(agent, 'USD');
    // Now the EUR asset is the foreign one: 100 € × 1.25 = 125 $.
    const converted = await agent.get(`/api/v1/assets/${eurAsset.id}`);
    expect(converted.status).toBe(200);
    expect(assetDetailResponseSchema.safeParse(converted.body).success).toBe(true);
    expect(converted.body.baseCurrency).toBe('USD');
    expect(converted.body.eurPrice).toBeCloseTo(125, 6);
    // …and the USD asset already IS the base → no conversion entry.
    const native = await agent.get(`/api/v1/assets/${usdAsset.id}`);
    expect(native.body.baseCurrency).toBe('USD');
    expect(native.body).not.toHaveProperty('eurPrice');
  });
});

describe('invest calculator (allocate) in the user base (V3-P10d)', () => {
  it('interprets the budget and prices in USD for a USD user', async () => {
    const { h, agent } = await harnessWith({
      quote: (ref) =>
        ref.providerRef === 'EURUSD=X' ? cachedQuote(1.25, { currency: 'USD' }) : cachedQuote(25),
    });
    const asset = await seedAsset(h);
    const created = await agent
      .post('/api/v1/conglomerates')
      .set(...XRW)
      .send({ name: 'Base test' });
    expect(created.status).toBe(201);
    const cid = created.body.id as string;
    await agent
      .put(`/api/v1/conglomerates/${cid}/positions`)
      .set(...XRW)
      .send({ positions: [{ assetId: asset.id, weightPct: 100 }] })
      .expect(200);

    // EUR baseline: 100 € / 25 € = 4 whole shares, nothing left.
    const eur = await agent
      .post(`/api/v1/conglomerates/${cid}/allocate`)
      .set(...XRW)
      .send({ budgetEur: 100, mode: 'whole' });
    expect(eur.status).toBe(200);
    expect(allocateResponseSchema.safeParse(eur.body).success).toBe(true);
    expect(eur.body.baseCurrency).toBe('EUR');
    expect(eur.body.positions[0].qty).toBe(4);
    expect(eur.body.totalCostEur).toBeCloseTo(100, 6);

    await setBase(agent, 'USD');
    // Same 100 budget now means 100 $; the share costs 25 € × 1.25 = 31.25 $
    // → 3 whole shares (93.75 $), 6.25 $ leftover. Same numbers as before
    // would mean the budget was silently still EUR.
    const usd = await agent
      .post(`/api/v1/conglomerates/${cid}/allocate`)
      .set(...XRW)
      .send({ budgetEur: 100, mode: 'whole' });
    expect(usd.status).toBe(200);
    expect(allocateResponseSchema.safeParse(usd.body).success).toBe(true);
    expect(usd.body.baseCurrency).toBe('USD');
    expect(usd.body.positions[0].qty).toBe(3);
    expect(usd.body.positions[0].costEur).toBeCloseTo(93.75, 6);
    expect(usd.body.totalCostEur).toBeCloseTo(93.75, 6);
    expect(usd.body.leftoverEur).toBeCloseTo(6.25, 6);
  });
});

describe('backtest preview in the user base (V3-P10d)', () => {
  it('computes USD-terms returns with historical FX and never serves a cached EUR result', async () => {
    // AAA is FLAT in EUR (100 → 100) while the dollar strengthens from 1.25 to
    // 1.00 USD-per-EUR: EUR terms 0 %, USD terms 125 → 100 = −20 %. The result
    // itself changes with the base — not just its label.
    const { h, agent } = await harnessWith({
      history: (ref) => {
        if (ref.providerRef === 'EURUSD=X') {
          return cachedHistory([
            { time: tsOffset(-300), close: 1.25 },
            { time: tsOffset(-1), close: 1.0 },
          ]);
        }
        return cachedHistory([
          { time: tsOffset(-300), close: 100 },
          { time: tsOffset(-1), close: 100 },
        ]);
      },
    });
    const asset = await seedAsset(h, { providerRef: 'AAA', symbol: 'AAA' });
    const body = { positions: [{ assetId: asset.id, weight: 100 }], range: 'MAX' };

    // EUR baseline first, which also warms the preview memo — the USD request
    // below must MISS it (the base is part of the cache identity).
    const eur = await agent
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .send(body);
    expect(eur.status).toBe(200);
    expect(backtestResponseSchema.safeParse(eur.body).success).toBe(true);
    expect(eur.body.stats.totalReturnPct).toBeCloseTo(0, 6);

    await setBase(agent, 'USD');
    const usd = await agent
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .send(body);
    expect(usd.status).toBe(200);
    expect(backtestResponseSchema.safeParse(usd.body).success).toBe(true);
    expect(usd.body.series[0].value).toBeCloseTo(100, 6);
    expect(usd.body.stats.totalReturnPct).toBeCloseTo(-20, 6);

    // And back: the EUR result is reproduced, not polluted by the USD run.
    await setBase(agent, 'EUR');
    const eurAgain = await agent
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .send(body);
    expect(eurAgain.body.stats.totalReturnPct).toBeCloseTo(0, 6);
  });
});
