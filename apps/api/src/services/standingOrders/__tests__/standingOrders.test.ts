import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { SOURCE_TAG_STANDING_ORDER } from '@bettertrack/contracts';

import * as schema from '../../../data/schema';
import { createStubMarketData } from '../../../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';

/**
 * Standing-orders engine end-to-end (issue #593): CRUD over the HTTP surface,
 * the daily scan driven under a mocked clock, and the exactly-once / catch-up /
 * pause / end-date / clamp / provider-failure guarantees the acceptance criteria
 * name. A stubbed quote provider (flippable to failure) keeps it network-free.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;
const quote = { mode: 'ok' as 'ok' | 'fail', price: 100 };

beforeEach(async () => {
  quote.mode = 'ok';
  quote.price = 100;
  const marketData = createStubMarketData({
    quote: () => {
      if (quote.mode === 'fail') throw new Error('provider down');
      return {
        value: { price: quote.price, currency: 'EUR', asOf: '2026-04-01T00:00:00.000Z' },
        stale: false,
        asOf: 0,
      };
    },
  });
  harness = await createTestApp({ marketData });
});

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

async function defaultPortfolioId(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  expect(res.status).toBe(200);
  return res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault).id as string;
}

async function setup() {
  const user = await harness.seedUser();
  const agent = await loginAgent(harness.app, user.email, user.password);
  const pid = await defaultPortfolioId(agent);
  return { user, agent, pid };
}

async function seedAsset(symbol: string): Promise<string> {
  const [row] = await harness.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: symbol,
      type: 'stock',
      symbol,
      name: `${symbol} Inc.`,
      currency: 'EUR',
      exchange: 'XETRA',
    })
    .returning();
  if (!row) throw new Error('seedAsset failed');
  return row.id;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createOrder(agent: Agent, body: Record<string, any>) {
  return agent
    .post('/api/v1/standing-orders')
    .set(...XRW)
    .send(body);
}

function run(nowIso: string) {
  return harness.ctx.standingOrders.processDueOrders({ now: Date.parse(nowIso) });
}

function cashRows(pid: string, source?: string) {
  return harness.db
    .select()
    .from(schema.portfolioCashMovements)
    .where(
      source
        ? and(
            eq(schema.portfolioCashMovements.portfolioId, pid),
            eq(schema.portfolioCashMovements.source, source),
          )
        : eq(schema.portfolioCashMovements.portfolioId, pid),
    );
}

function txnRows(pid: string, source = SOURCE_TAG_STANDING_ORDER) {
  return harness.db
    .select()
    .from(schema.transactions)
    .where(and(eq(schema.transactions.portfolioId, pid), eq(schema.transactions.source, source)));
}

function runPeriodKeys() {
  return harness.db
    .select({ key: schema.standingOrderRuns.periodKey })
    .from(schema.standingOrderRuns);
}

async function depositCash(agent: Agent, pid: string, amountEur: number) {
  const res = await agent
    .post(`/api/v1/portfolios/${pid}/cash/deposit`)
    .set(...XRW)
    .send({ amountEur });
  expect(res.status).toBe(201);
}

describe('standing orders — CRUD + validation (HTTP)', () => {
  it('creates, lists with a computed next-run, edits, and deletes (owner-scoped)', async () => {
    const { agent, pid } = await setup();
    const created = await createOrder(agent, {
      portfolioId: pid,
      kind: 'cash-add',
      amount: 100,
      label: 'salary',
      cadence: 'monthly',
      anchorDay: 1,
      startDate: '2026-04-01',
    });
    expect(created.status).toBe(201);
    expect(created.body.currency).toBe('EUR');
    expect(created.body.status).toBe('active');
    // Computed, never stored — an ISO day (its exact value under a mocked clock
    // is covered by the schedule unit tests; here we just prove it is wired).
    expect(created.body.nextRunDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const id = created.body.id as string;

    const list = await agent.get('/api/v1/standing-orders');
    expect(list.status).toBe(200);
    expect(list.body.orders).toHaveLength(1);

    const patched = await agent
      .patch(`/api/v1/standing-orders/${id}`)
      .set(...XRW)
      .send({ amount: 250, label: 'raise' });
    expect(patched.status).toBe(200);
    expect(patched.body.amount).toBe(250);
    expect(patched.body.label).toBe('raise');

    // Another user cannot see or touch it (404, no IDOR).
    const other = await harness.seedUser({ email: 'b@bettertrack.test', username: 'bob' });
    const otherAgent = await loginAgent(harness.app, other.email, other.password);
    expect((await otherAgent.get(`/api/v1/standing-orders/${id}`)).status).toBe(404);

    const del = await agent.delete(`/api/v1/standing-orders/${id}`).set(...XRW);
    expect(del.status).toBe(204);
    expect((await agent.get(`/api/v1/standing-orders/${id}`)).status).toBe(404);
  });

  it('rejects a buy without an asset and a monthly without an anchor (contract refinements)', async () => {
    const { agent, pid } = await setup();
    expect(
      (
        await createOrder(agent, {
          portfolioId: pid,
          kind: 'buy-asset',
          amount: 1,
          cadence: 'daily',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await createOrder(agent, {
          portfolioId: pid,
          kind: 'cash-add',
          amount: 1,
          cadence: 'monthly',
        })
      ).status,
    ).toBe(400);
  });
});

describe('standing orders — exactly-once per period (the gate criterion)', () => {
  it('books once, and a double-run of the job for the same period does not re-book', async () => {
    const { agent, pid } = await setup();
    await createOrder(agent, {
      portfolioId: pid,
      kind: 'cash-add',
      amount: 100,
      label: 'salary',
      cadence: 'daily',
      startDate: '2026-04-01',
    });

    expect((await run('2026-04-01T12:00:00Z')).booked).toBe(1);
    expect(await cashRows(pid, SOURCE_TAG_STANDING_ORDER)).toHaveLength(1);

    // Double-run of the SAME period → no second booking (fast path).
    expect((await run('2026-04-01T12:00:00Z')).booked).toBe(0);
    expect(await cashRows(pid, SOURCE_TAG_STANDING_ORDER)).toHaveLength(1);

    // Force the claim path itself: wipe the denormalized bookkeeping so the fast
    // path can't short-circuit — the per-period run claim must still guard it.
    await harness.db.update(schema.standingOrders).set({ lastPeriodKey: null });
    const forced = await run('2026-04-01T12:00:00Z');
    expect(forced.booked).toBe(0);
    expect(forced.skippedDuplicate).toBe(1);
    expect(await cashRows(pid, SOURCE_TAG_STANDING_ORDER)).toHaveLength(1);

    const [m] = await cashRows(pid, SOURCE_TAG_STANDING_ORDER);
    expect(m!.kind).toBe('deposit');
    expect(Number(m!.amountEur)).toBe(100);
    expect(m!.note).toBe('salary');
    expect(m!.source).toBe('standing-order');
  });
});

describe('standing orders — pause / resume', () => {
  it('pausing stops it; resuming does not back-fill the paused periods', async () => {
    const { agent, pid } = await setup();
    const created = await createOrder(agent, {
      portfolioId: pid,
      kind: 'cash-add',
      amount: 10,
      cadence: 'daily',
      startDate: '2026-04-01',
    });
    const id = created.body.id as string;

    expect((await run('2026-04-01T12:00:00Z')).booked).toBe(1);

    expect((await agent.post(`/api/v1/standing-orders/${id}/pause`).set(...XRW)).status).toBe(200);
    expect((await run('2026-04-02T12:00:00Z')).booked).toBe(0);
    expect((await run('2026-04-03T12:00:00Z')).booked).toBe(0);
    expect(await cashRows(pid, SOURCE_TAG_STANDING_ORDER)).toHaveLength(1);

    expect((await agent.post(`/api/v1/standing-orders/${id}/resume`).set(...XRW)).status).toBe(200);
    expect((await run('2026-04-04T12:00:00Z')).booked).toBe(1);

    // Exactly the current period was booked on resume — never Apr 2 / Apr 3.
    const keys = (await runPeriodKeys()).map((r) => r.key).sort();
    expect(keys).toEqual(['2026-04-01', '2026-04-04']);
  });
});

describe('standing orders — end date', () => {
  it('stops once the end date passes (no occurrence after it ever fires)', async () => {
    const { agent, pid } = await setup();
    await createOrder(agent, {
      portfolioId: pid,
      kind: 'cash-add',
      amount: 5,
      cadence: 'daily',
      startDate: '2026-04-01',
      endDate: '2026-04-02',
    });

    expect((await run('2026-04-01T12:00:00Z')).booked).toBe(1);
    expect((await run('2026-04-02T12:00:00Z')).booked).toBe(1);
    // Past the end: nothing new, ever.
    expect((await run('2026-04-03T12:00:00Z')).booked).toBe(0);
    expect((await run('2026-04-10T12:00:00Z')).booked).toBe(0);

    const keys = (await runPeriodKeys()).map((r) => r.key).sort();
    expect(keys).toEqual(['2026-04-01', '2026-04-02']);
  });
});

describe('standing orders — monthly clamp', () => {
  it('a day-31 monthly clamps to month-end in shorter months', async () => {
    const { agent, pid } = await setup();
    await createOrder(agent, {
      portfolioId: pid,
      kind: 'cash-add',
      amount: 50,
      cadence: 'monthly',
      anchorDay: 31,
      startDate: '2026-01-01',
    });

    // February: fires on the 28th (clamped from 31), once.
    expect((await run('2026-02-28T12:00:00Z')).booked).toBe(1);
    expect((await run('2026-02-28T12:00:00Z')).booked).toBe(0);
    // March: fires on the 31st.
    expect((await run('2026-03-31T12:00:00Z')).booked).toBe(1);

    const keys = (await runPeriodKeys()).map((r) => r.key).sort();
    expect(keys).toEqual(['2026-02-28', '2026-03-31']);
  });
});

describe('standing orders — source tag round-trips through the P0c filter', () => {
  it('booked buy + cash rows carry `standing-order` and filter cleanly', async () => {
    const { agent, pid } = await setup();
    const assetId = await seedAsset('AAA');
    await depositCash(agent, pid, 1000); // seed manual cash so the deduct covers

    await createOrder(agent, {
      portfolioId: pid,
      kind: 'buy-asset',
      assetId,
      amount: 2,
      cadence: 'daily',
      startDate: '2026-04-01',
    });
    await createOrder(agent, {
      portfolioId: pid,
      kind: 'cash-add',
      amount: 50,
      label: 'salary',
      cadence: 'daily',
      startDate: '2026-04-01',
    });
    await createOrder(agent, {
      portfolioId: pid,
      kind: 'cash-deduct',
      amount: 20,
      label: 'Netflix',
      cadence: 'daily',
      startDate: '2026-04-01',
    });

    expect((await run('2026-04-01T12:00:00Z')).booked).toBe(3);

    // Transactions filtered to the tag.
    const txns = await agent.get(`/api/v1/portfolios/${pid}/transactions?source=standing-order`);
    expect(txns.status).toBe(200);
    expect(txns.body.items).toHaveLength(1);
    expect(txns.body.items[0].source).toBe('standing-order');
    expect(txns.body.items[0].quantity).toBe(2);
    expect(txns.body.items[0].price).toBe(100);

    // Cash filtered to the tag (deposit + withdrawal), and the manual seed excluded.
    const soCash = await agent.get(`/api/v1/portfolios/${pid}/cash?source=standing-order`);
    expect(soCash.status).toBe(200);
    expect(soCash.body.movements).toHaveLength(2);
    expect(
      soCash.body.movements.every((m: { source: string }) => m.source === 'standing-order'),
    ).toBe(true);

    const manualCash = await agent.get(`/api/v1/portfolios/${pid}/cash?source=manual`);
    expect(manualCash.body.movements).toHaveLength(1);
    expect(Number(manualCash.body.movements[0].amountEur)).toBe(1000);
  });
});

describe('standing orders — provider failure on a buy', () => {
  it('books nothing on quote failure, then retries the period exactly once', async () => {
    const { agent, pid } = await setup();
    const assetId = await seedAsset('BBB');
    await createOrder(agent, {
      portfolioId: pid,
      kind: 'buy-asset',
      assetId,
      amount: 2,
      cadence: 'daily',
      startDate: '2026-04-01',
    });

    quote.mode = 'fail';
    const failed = await run('2026-04-01T12:00:00Z');
    expect(failed.booked).toBe(0);
    expect(failed.deferred).toBe(1);
    expect(await txnRows(pid)).toHaveLength(0);
    expect(await runPeriodKeys()).toHaveLength(0); // no claim was made

    quote.mode = 'ok';
    expect((await run('2026-04-01T12:00:00Z')).booked).toBe(1);
    expect(await txnRows(pid)).toHaveLength(1);
    // A further run does not double-book the recovered period.
    expect((await run('2026-04-01T12:00:00Z')).booked).toBe(0);
    expect(await txnRows(pid)).toHaveLength(1);
  });
});

describe('standing orders — catch-up after downtime', () => {
  it('books only the single most recent missed period', async () => {
    const { agent, pid } = await setup();
    await createOrder(agent, {
      portfolioId: pid,
      kind: 'cash-add',
      amount: 7,
      cadence: 'daily',
      startDate: '2026-04-01',
    });

    // First run is three periods late (Apr 1/2/3 missed) — only Apr 4 books.
    const result = await run('2026-04-04T12:00:00Z');
    expect(result.booked).toBe(1);
    expect(await cashRows(pid, SOURCE_TAG_STANDING_ORDER)).toHaveLength(1);
    expect((await runPeriodKeys()).map((r) => r.key)).toEqual(['2026-04-04']);
  });
});

describe('standing orders — cash-deduct never overdraws', () => {
  it('defers an unaffordable deduction, then books it once funds arrive (no negative balance)', async () => {
    const { agent, pid } = await setup();
    await createOrder(agent, {
      portfolioId: pid,
      kind: 'cash-deduct',
      amount: 20,
      label: 'Netflix',
      cadence: 'daily',
      startDate: '2026-04-01',
    });

    const deferred = await run('2026-04-01T12:00:00Z');
    expect(deferred.booked).toBe(0);
    expect(deferred.deferred).toBe(1);
    expect(await cashRows(pid, SOURCE_TAG_STANDING_ORDER)).toHaveLength(0);

    await depositCash(agent, pid, 100);
    expect((await run('2026-04-01T12:00:00Z')).booked).toBe(1);
    const [m] = await cashRows(pid, SOURCE_TAG_STANDING_ORDER);
    expect(m!.kind).toBe('withdrawal');
    expect(Number(m!.amountEur)).toBe(-20);
  });
});
