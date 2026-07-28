import { readFileSync } from 'node:fs';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { describe, expect, it } from 'vitest';

import type { CachedResult, Quote } from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createStubMarketData } from '../testing/marketDataStubs';
import { createTestApp } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

/**
 * Golden source for the paranoid client money engine's "audited server
 * vector" TWR parity tests (issue #899). The vectors in the shared fixture
 * are not hand-derived: this test drives the fixture's exact inputs through
 * the real server pipeline — priceHistory rows, the V5-P1 snapshot layer and
 * `GET /portfolios/:id/history?range=MAX` — and pins the server's performance
 * output to them. The client tests in
 * apps/web/src/user/vault/engine/clientMoney.test.ts consume the same file,
 * so a drift on either side fails CI.
 */
const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../web/src/user/vault/engine/serverTwrParity.fixture.json',
);

interface ParityScenario {
  closes: number[];
  quoteToday: number;
  buy: { quantity: number; price: number; fee: number; dayOffset: number };
  depositEur?: number;
  depositDayOffset?: number;
  linkedBuyMovement?: { amountEur: number; dayOffset: number };
  twrPct: number[];
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
  sinceInceptionMax: ParityScenario;
  splitDateCashBuy: ParityScenario;
};

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

async function serverPerformanceVector(scenario: ParityScenario): Promise<number[]> {
  const marketData = createStubMarketData({
    quote: (): CachedResult<Quote> => ({
      value: {
        price: scenario.quoteToday,
        currency: 'EUR',
        prevClose: scenario.quoteToday,
        asOf: new Date().toISOString(),
      },
      stale: false,
      asOf: Date.now(),
    }),
  });
  const h = await createTestApp({ marketData });
  const user = await h.seedUser();
  const agent = await loginAgent(h.app, user.email, user.password);
  const pid = await defaultPortfolioId(agent);
  const [asset] = await h.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: 'PARITY.DE',
      type: 'stock',
      symbol: 'PARITY.DE',
      name: 'Parity fixture asset',
      currency: 'EUR',
      exchange: 'XETRA',
    })
    .returning();
  if (!asset) throw new Error('Failed to seed asset');

  await h.db.insert(schema.priceHistory).values(
    scenario.closes.map((close, index) => ({
      assetId: asset.id,
      date: dayOffset(scenario.buy.dayOffset + index),
      close: String(close),
    })),
  );

  if (scenario.depositEur !== undefined && scenario.depositDayOffset !== undefined) {
    const deposit = await agent
      .post(`/api/v1/portfolios/${pid}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: scenario.depositEur, executedAt: tsOffset(scenario.depositDayOffset) });
    expect(deposit.status, JSON.stringify(deposit.body)).toBeLessThan(300);
  }

  const bought = await agent
    .post(`/api/v1/portfolios/${pid}/transactions`)
    .set(...XRW)
    .send({
      assetId: asset.id,
      side: 'buy',
      quantity: scenario.buy.quantity,
      price: scenario.buy.price,
      fee: scenario.buy.fee,
      executedAt: tsOffset(scenario.buy.dayOffset),
    });
  expect(bought.status, JSON.stringify(bought.body)).toBe(201);
  const transaction = bought.body[0] ?? bought.body.transactions?.[0];
  expect(transaction?.id).toBeTruthy();

  if (scenario.linkedBuyMovement !== undefined) {
    // The server-reachable split-date state (#378): a pay-from-cash buy whose
    // cash leg settled on a later calendar day than the asset acquisition.
    const [source] = await h.db
      .select()
      .from(schema.portfolioCashSources)
      .where(eq(schema.portfolioCashSources.portfolioId, pid));
    if (!source) throw new Error('Main cash source missing after deposit');
    await h.db.insert(schema.portfolioCashMovements).values({
      portfolioId: pid,
      sourceId: source.id,
      kind: 'buy',
      amountEur: String(scenario.linkedBuyMovement.amountEur),
      transactionId: transaction.id as string,
      executedAt: new Date(tsOffset(scenario.linkedBuyMovement.dayOffset)),
      note: 'Paid from cash balance',
    });
  }

  // The first read after writes is the dirty-state snapshot-writer fallback,
  // whose "today" carries the last close. The steady-state snapshot path —
  // persisted rows plus the always-fresh quote-driven today point — is what
  // the paranoid client mirrors, so the pinned vector is the second read.
  const warmup = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
  expect(warmup.status).toBe(200);
  const res = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
  expect(res.status).toBe(200);
  return (res.body.performance as Array<{ pct: number }>).map((point) => point.pct);
}

describe('paranoid client TWR parity golden fixture (issue #899)', () => {
  it('the server reproduces the since-inception MAX vector byte-for-byte', async () => {
    const pct = await serverPerformanceVector(fixture.sinceInceptionMax);
    expect(pct).toHaveLength(fixture.sinceInceptionMax.twrPct.length);
    pct.forEach((value, index) => {
      expect(value).toBeCloseTo(fixture.sinceInceptionMax.twrPct[index]!, 12);
    });
  });

  it('the server reproduces the split-date cash-buy compensator vector byte-for-byte', async () => {
    const pct = await serverPerformanceVector(fixture.splitDateCashBuy);
    expect(pct).toHaveLength(fixture.splitDateCashBuy.twrPct.length);
    pct.forEach((value, index) => {
      expect(value).toBeCloseTo(fixture.splitDateCashBuy.twrPct[index]!, 12);
    });
  });
});
