import { and, asc, eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { describe, expect, it } from 'vitest';

import * as schema from '../data/schema';
import { createPortfolioSnapshotRepository } from '../data/repositories/portfolioSnapshotRepository';
import { SNAPSHOT_HEAL_WINDOW_DAYS } from '../jobs/definitions/snapshotJobs';
import { repairTaxedSellSnapshots } from '../scripts/repairTaxedSellSnapshots';
import { createStubMarketData } from '../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * The one-off repair for the taxed-sell flow bug (#125 follow-up to 985e795).
 *
 * The engine predicate is already fixed; what these tests pin is the DATA
 * problem it left behind. A stored snapshot row is served verbatim while the
 * state is clean, so a portfolio that recorded a taxed sell before the fix
 * keeps serving a curve built from the missing outflow — and because the
 * performance index is chain-linked, that one wrong day poisons every later
 * point. The nightly roll cannot save it: it only overwrites a trailing
 * {@link SNAPSHOT_HEAL_WINDOW_DAYS} days.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

/** The corrupted sell sits well outside the nightly heal window. */
const SELL_DAYS_AGO = SNAPSHOT_HEAL_WINDOW_DAYS + 25;

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
  expect(def).toBeTruthy();
  return def.id as string;
}

async function finalPerformancePct(
  agent: ReturnType<typeof request.agent>,
  pid: string,
): Promise<number> {
  const res = await agent.get(`/api/v1/portfolios/${pid}/history?range=MAX`);
  expect(res.status).toBe(200);
  const perf = res.body.performance as Array<{ date: string; pct: number }>;
  return perf.at(-1)!.pct;
}

/**
 * Seed the exact broken shape: a taxed sell at a gain whose proceeds are NOT
 * parked in cash, so the tax settlement is the sell's only linked movement.
 */
async function seedTaxedSellPaidOut(h: TestHarness) {
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
  if (!asset) throw new Error('Failed to seed asset');

  const taxed = await agent
    .patch('/api/v1/settings/taxes')
    .set(...XRW)
    .send({ mode: 'manual_per_trade' });
  expect(taxed.status).toBe(200);

  // A flat close after the sell keeps the truth easy to reason about: nothing
  // moves the curve after the sell except the sell itself.
  const closes = [];
  for (let d = SELL_DAYS_AGO + 1; d >= 0; d -= 1) {
    closes.push({
      assetId: asset.id,
      date: dayOffset(-d),
      close: d > SELL_DAYS_AGO ? '100' : '150',
    });
  }
  await h.db.insert(schema.priceHistory).values(closes);

  const deposit = await agent
    .post(`/api/v1/portfolios/${pid}/cash/deposit`)
    .set(...XRW)
    .send({ amountEur: 1000, executedAt: tsOffset(-(SELL_DAYS_AGO + 2)) });
  expect(deposit.status).toBeLessThan(300);

  const bought = await agent
    .post(`/api/v1/portfolios/${pid}/transactions`)
    .set(...XRW)
    .send({
      assetId: asset.id,
      side: 'buy',
      quantity: 10,
      price: 100,
      executedAt: tsOffset(-(SELL_DAYS_AGO + 1)),
    });
  expect(bought.status, JSON.stringify(bought.body)).toBe(201);

  // Sell the lot at a 500 gain, proceeds paid OUT (no addProceedsToCash), 10 %
  // withheld as tax — the settlement rides on the sell's transactionId.
  const sold = await agent
    .post(`/api/v1/portfolios/${pid}/transactions`)
    .set(...XRW)
    .send({
      assetId: asset.id,
      side: 'sell',
      quantity: 10,
      price: 150,
      executedAt: tsOffset(-SELL_DAYS_AGO),
      taxRatePct: 10,
    });
  expect(sold.status, JSON.stringify(sold.body)).toBe(201);

  return { agent, pid, assetId: asset.id };
}

/**
 * Rewrite history the way the pre-fix engine stored it. The bug's ONLY stored
 * effect is the dropped external flow: value/cost/PL come from holdings + cash
 * and never depended on the exclusion set. So zeroing the sell day's `flowEur`
 * on an otherwise clean, fully-populated series reproduces a pre-fix database
 * exactly — and leaves the state clean, which is what makes the rows be served
 * verbatim instead of recomputed.
 */
async function corruptSellDayFlow(h: TestHarness, pid: string): Promise<number> {
  const [row] = await h.db
    .select()
    .from(schema.portfolioDailySnapshots)
    .where(
      and(
        eq(schema.portfolioDailySnapshots.portfolioId, pid),
        eq(schema.portfolioDailySnapshots.date, dayOffset(-SELL_DAYS_AGO)),
      ),
    );
  if (!row) throw new Error('expected a snapshot row on the sell day');
  const trueFlow = Number(row.flowEur);
  expect(trueFlow).toBeLessThan(0); // the proceeds leaving really is an outflow

  await h.db
    .update(schema.portfolioDailySnapshots)
    .set({ flowEur: '0' })
    .where(
      and(
        eq(schema.portfolioDailySnapshots.portfolioId, pid),
        eq(schema.portfolioDailySnapshots.date, dayOffset(-SELL_DAYS_AGO)),
      ),
    );
  return trueFlow;
}

/** Populate the full snapshot series and leave the state clean. */
async function warmSnapshots(h: TestHarness, pid: string) {
  await h.ctx.snapshots.recompute(pid);
  const state = await h.db
    .select()
    .from(schema.portfolioSnapshotState)
    .where(eq(schema.portfolioSnapshotState.portfolioId, pid));
  expect(state[0]?.dirtyFrom ?? null).toBeNull();
}

describe('taxed-sell snapshot repair (#125 follow-up)', () => {
  it('rebuilds a stored curve whose taxed sell lost its outflow, and stays correct on a second run', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const { agent, pid } = await seedTaxedSellPaidOut(h);
    await warmSnapshots(h, pid);

    // The truth, straight from the fixed engine, before anything is corrupted:
    // 1000 cash + a lot bought at 1000 and sold for 1500, 50 of it withheld as
    // tax, the proceeds paid out — the audit's +22.5 %.
    const truth = await finalPerformancePct(agent, pid);
    expect(truth).toBeCloseTo(22.5, 6);

    await corruptSellDayFlow(h, pid);

    // BEFORE: the stored series is served verbatim, so the holdings vanish with
    // no flow explaining it and the curve books a loss the user never took —
    // the audit's -52.5 %.
    const corrupted = await finalPerformancePct(agent, pid);
    expect(corrupted).toBeCloseTo(-52.5, 6);

    // The nightly roll cannot reach it — the sell is older than the heal window.
    await h.ctx.snapshots.recompute(pid, { healFrom: dayOffset(-SNAPSHOT_HEAL_WINDOW_DAYS) });
    expect(await finalPerformancePct(agent, pid)).toBeCloseTo(corrupted, 9);

    // AFTER: the repair selects the portfolio and rebuilds it from inception.
    const first = await repairTaxedSellSnapshots({
      dryRun: false,
      snapshotRepo: createPortfolioSnapshotRepository(h.db),
    });
    expect(first.affected).toBe(1);
    expect(first.invalidated).toBe(1);
    expect(first.failed).toBe(0);
    expect(first.portfolios[0]!.portfolioId).toBe(pid);
    expect(first.portfolios[0]!.firstEventDay).toBe(dayOffset(-(SELL_DAYS_AGO + 2)));

    expect(await finalPerformancePct(agent, pid)).toBeCloseTo(truth, 9);

    // A second run is idempotent in outcome: same selection, same curve.
    const second = await repairTaxedSellSnapshots({
      dryRun: false,
      snapshotRepo: createPortfolioSnapshotRepository(h.db),
    });
    expect(second.affected).toBe(1);
    expect(second.failed).toBe(0);
    expect(await finalPerformancePct(agent, pid)).toBeCloseTo(truth, 9);
  });

  it('rebuilds the whole chain, not just the trailing window', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const { pid } = await seedTaxedSellPaidOut(h);
    await warmSnapshots(h, pid);
    const trueFlow = await corruptSellDayFlow(h, pid);

    await repairTaxedSellSnapshots({
      dryRun: false,
      snapshotRepo: createPortfolioSnapshotRepository(h.db),
    });

    // Reading rebuilds the deleted rows; the sell day's flow is restored even
    // though it is far outside the nightly heal window.
    await h.ctx.snapshots.getSeries(pid);
    const rows = await h.db
      .select()
      .from(schema.portfolioDailySnapshots)
      .where(eq(schema.portfolioDailySnapshots.portfolioId, pid))
      .orderBy(asc(schema.portfolioDailySnapshots.date));
    const sellRow = rows.find((r) => r.date === dayOffset(-SELL_DAYS_AGO));
    expect(sellRow).toBeTruthy();
    expect(Number(sellRow!.flowEur)).toBeCloseTo(trueFlow, 9);
    // The series still starts at inception — the repair rebuilds, never truncates.
    expect(rows[0]!.date).toBe(dayOffset(-(SELL_DAYS_AGO + 2)));
  });

  it('leaves a taxed sell that parked its proceeds in cash alone', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
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
    if (!asset) throw new Error('Failed to seed asset');
    await agent
      .patch('/api/v1/settings/taxes')
      .set(...XRW)
      .send({ mode: 'manual_per_trade' });
    await h.db.insert(schema.priceHistory).values([
      { assetId: asset.id, date: dayOffset(-3), close: '100' },
      { assetId: asset.id, date: dayOffset(-2), close: '150' },
      { assetId: asset.id, date: dayOffset(-1), close: '150' },
    ]);
    await agent
      .post(`/api/v1/portfolios/${pid}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 1000, executedAt: tsOffset(-4) });
    await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 10, price: 100, executedAt: tsOffset(-3) });
    const sold = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({
        assetId: asset.id,
        side: 'sell',
        quantity: 10,
        price: 150,
        executedAt: tsOffset(-2),
        addProceedsToCash: true,
        taxRatePct: 10,
      });
    expect(sold.status, JSON.stringify(sold.body)).toBe(201);

    // The sell_proceeds leg makes it a genuine internal settlement — never the
    // corruption signature, so the repair must not select it.
    const report = await repairTaxedSellSnapshots({
      dryRun: false,
      snapshotRepo: createPortfolioSnapshotRepository(h.db),
    });
    expect(report.affected).toBe(0);
  });

  it('reports affected portfolios in dry-run without writing', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const { pid } = await seedTaxedSellPaidOut(h);
    await warmSnapshots(h, pid);
    await corruptSellDayFlow(h, pid);

    const before = await h.db
      .select()
      .from(schema.portfolioDailySnapshots)
      .where(eq(schema.portfolioDailySnapshots.portfolioId, pid));

    const report = await repairTaxedSellSnapshots({
      dryRun: true,
      snapshotRepo: createPortfolioSnapshotRepository(h.db),
    });
    expect(report.mode).toBe('dry-run');
    expect(report.affected).toBe(1);
    expect(report.invalidated).toBe(0);
    expect(report.portfolios[0]!.invalidated).toBe(false);

    // Nothing was deleted and the state is still clean.
    const after = await h.db
      .select()
      .from(schema.portfolioDailySnapshots)
      .where(eq(schema.portfolioDailySnapshots.portfolioId, pid));
    expect(after.length).toBe(before.length);
    const state = await h.db
      .select()
      .from(schema.portfolioSnapshotState)
      .where(eq(schema.portfolioSnapshotState.portfolioId, pid));
    expect(state[0]?.dirtyFrom ?? null).toBeNull();
  });
});
