import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  taxYearListResponseSchema,
  type CashMovement,
  type TaxYearSummary,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * FI tax engine end-to-end (#635): the Finnish country module over the HTTP
 * surface — the progressive 30 %/34 % pääomatulovero with the €30,000
 * threshold, FIFO lot consumption (provably ≠ moving average), the within-year
 * loss offset with an intra-year refund, and dividends in the same pool.
 * EUR asset throughout, so every cent asserts exactly.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

type Agent = ReturnType<typeof request.agent>;

async function loginAgent(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

async function defaultPortfolioId(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  expect(res.status).toBe(200);
  return res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault).id as string;
}

async function seedAsset(symbol: string) {
  const [row] = await harness.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: symbol,
      type: 'stock',
      symbol,
      name: `${symbol} Test`,
      currency: 'EUR',
      exchange: 'HEL',
    })
    .returning();
  if (!row) throw new Error('Failed to seed asset');
  return row;
}

/** One logged-in FI-mode user with their default portfolio and a stock asset. */
async function setupFi() {
  const user = await harness.seedUser();
  const agent = await loginAgent(harness.app, user.email, user.password);
  const pid = await defaultPortfolioId(agent);
  const asset = await seedAsset('NOKIA.HE');
  const res = await agent
    .patch('/api/v1/settings/taxes')
    .set(...XRW)
    .send({ mode: 'country_specific', country: 'FI' });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ mode: 'country_specific', country: 'FI' });
  return { user, agent, pid, asset };
}

async function trade(agent: Agent, pid: string, body: Record<string, unknown>) {
  const res = await agent
    .post(`/api/v1/portfolios/${pid}/transactions`)
    .set(...XRW)
    .send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res;
}

async function cashMovements(agent: Agent, pid: string): Promise<CashMovement[]> {
  const res = await agent.get(`/api/v1/portfolios/${pid}/cash`);
  expect(res.status).toBe(200);
  return res.body.movements as CashMovement[];
}

async function yearSummaries(agent: Agent, pid: string): Promise<TaxYearSummary[]> {
  const res = await agent.get(`/api/v1/portfolios/${pid}/reports/tax-years`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const parsed = taxYearListResponseSchema.safeParse(res.body);
  expect(parsed.success).toBe(true);
  return parsed.success ? parsed.data.years : [];
}

describe('FI mode: progressive capital-income tax (#635)', () => {
  it('worked example: threshold crossing, FIFO lots, dividend, intra-year refund', async () => {
    const { agent, pid, asset } = await setupFi();

    // Lot 1: 1,000 @ 10. Sell all @ 45 → +35,000: crosses the €30,000
    // threshold → 30 % × 30,000 + 34 % × 5,000 = 10,700 withheld.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 1000,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 1000,
      price: 45,
      executedAt: '2026-02-10T10:00:00.000Z',
      addProceedsToCash: true,
    });
    let movements = await cashMovements(agent, pid);
    expect(movements.find((m) => m.kind === 'tax_withholding')).toMatchObject({
      amountEur: -10_700,
      note: 'Capital-income tax withheld (FI)',
      taxYear: 2026,
    });

    // Lots 2+3: 100 @ 10 then 100 @ 20; selling 100 @ 30 must consume the
    // FIRST lot (FIFO): gain 100 · (30 − 10) = 2,000 — the moving average
    // (basis 15) would realize 1,500 and withhold 510, which must NOT happen.
    // Pool 37,000 → marginal 34 % × 2,000 = 680.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 10,
      executedAt: '2026-03-01T10:00:00.000Z',
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 20,
      executedAt: '2026-03-02T10:00:00.000Z',
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 100,
      price: 30,
      executedAt: '2026-04-10T10:00:00.000Z',
      addProceedsToCash: true,
    });
    movements = await cashMovements(agent, pid);
    const fifoWithholding = movements.filter((m) => m.kind === 'tax_withholding');
    expect(fifoWithholding.map((m) => m.amountEur)).toContain(-680);

    // A dividend joins the same pool: 38,000 → marginal 34 % × 1,000 = 340.
    const div = await agent
      .post(`/api/v1/portfolios/${pid}/dividends`)
      .set(...XRW)
      .send({
        assetId: asset.id,
        grossAmountEur: 1000,
        executedAt: '2026-05-01T12:00:00.000Z',
      });
    expect(div.status, JSON.stringify(div.body)).toBe(201);
    expect(div.body.dividend).toMatchObject({ taxCountry: 'FI', taxAmountEur: 340 });

    // Selling the remaining 100 @ 8 consumes the 100 @ 20 lot → −1,200 loss:
    // pool 36,800 → target 9,000 + 34 % × 6,800 = 11,312 → refund 34 % × 1,200.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 100,
      price: 8,
      executedAt: '2026-06-10T10:00:00.000Z',
      addProceedsToCash: true,
    });
    movements = await cashMovements(agent, pid);
    expect(movements.find((m) => m.kind === 'tax_refund')).toMatchObject({
      amountEur: 408,
      note: 'Capital-income tax refunded (FI)',
      taxYear: 2026,
    });

    // Year totals: realized 35,000 + 2,000 − 1,200 = 35,800; dividends 1,000;
    // net = 30 % × 30,000 + 34 % × 6,800 = 11,312. No DE block, not locked.
    const years = await yearSummaries(agent, pid);
    expect(years).toHaveLength(1);
    expect(years[0]).toMatchObject({
      year: 2026,
      realizedPnlEur: 35_800,
      dividendsGrossEur: 1000,
      taxWithheldEur: 11_720,
      taxRefundedEur: 408,
      taxNetEur: 11_312,
    });
    expect(years[0]!.de).toBeUndefined();
    expect(years[0]!.locked).toBeUndefined();
  });

  it('switching AT→FI re-derives the open year progressively (#635 live model)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset('SAMPO.HE');

    // AT era: +450 gain withholds 27.5 % × 450 = 123.75.
    await agent
      .patch('/api/v1/settings/taxes')
      .set(...XRW)
      .send({ mode: 'country_specific', country: 'AT' });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 19,
      executedAt: '2026-02-10T10:00:00.000Z',
      addProceedsToCash: true,
    });

    await agent
      .patch('/api/v1/settings/taxes')
      .set(...XRW)
      .send({ mode: 'country_specific', country: 'FI' });

    // The report read self-heals: the year re-derives under FI — 30 % × 450 =
    // 135 target vs 123.75 held → one +11.25 withholding correction.
    const years = await yearSummaries(agent, pid);
    expect(years[0]).toMatchObject({ year: 2026, realizedPnlEur: 450, taxNetEur: 135 });
    const movements = await cashMovements(agent, pid);
    const corrections = movements.filter(
      (m) => (m.kind === 'tax_withholding' || m.kind === 'tax_refund') && m.transactionId === null,
    );
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({
      kind: 'tax_withholding',
      amountEur: -11.25,
      taxYear: 2026,
      note: 'Live tax correction (FI)',
    });
  });
});
