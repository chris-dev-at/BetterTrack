import { and, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  notificationListResponseSchema,
  SOURCE_TAG_STANDING_ORDER,
  STANDING_ORDER_QUOTE_REFUSAL_VECTORS,
  STANDING_ORDER_QUOTE_VECTOR_CURRENCY,
  standingOrderListResponseSchema,
  standingOrderRunListResponseSchema,
} from '@bettertrack/contracts';

import { newId } from '../../../data/ids';
import * as schema from '../../../data/schema';
import { createAssetRepository } from '../../../data/repositories/assetRepository';
import { createCashMovementRepository } from '../../../data/repositories/cashMovementRepository';
import { createCashSourceRepository } from '../../../data/repositories/cashSourceRepository';
import { createPortfolioRepository } from '../../../data/repositories/portfolioRepository';
import { createStandingOrderRepository } from '../../../data/repositories/standingOrderRepository';
import { createTransactionRepository } from '../../../data/repositories/transactionRepository';
import {
  createManualAssetSource,
  createManualProvider,
  createMarketDataService,
  createProviderRegistry,
} from '../../../providers';
import type { DispatchableEvent } from '../../notifications/notificationDispatcher';
import {
  createStandingOrderService,
  STANDING_ORDER_MAX_QUOTE_AGE_MS,
} from '../standingOrderService';
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
let marketData: ReturnType<typeof createStubMarketData>;
// `asOf` is the provider's market timestamp: buys accept it only within the
// four-day booking ceiling, so tests scanning far from the default reset it.
const quote = {
  mode: 'ok' as 'ok' | 'fail',
  price: 100,
  currency: 'EUR',
  asOf: '2026-04-01T00:00:00.000Z',
};
let portfolioNow: number | undefined;

beforeEach(async () => {
  quote.mode = 'ok';
  quote.price = 100;
  quote.currency = 'EUR';
  quote.asOf = '2026-04-01T00:00:00.000Z';
  portfolioNow = undefined;
  marketData = createStubMarketData({
    quote: () => {
      if (quote.mode === 'fail') throw new Error('provider down');
      return {
        value: { price: quote.price, currency: quote.currency, asOf: quote.asOf },
        stale: false,
        asOf: 0,
      };
    },
  });
  harness = await createTestApp({ marketData, portfolioNow: () => portfolioNow ?? Date.now() });
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

function runPeriodKeys(standingOrderId?: string) {
  const query = harness.db
    .select({ key: schema.standingOrderRuns.periodKey })
    .from(schema.standingOrderRuns);
  return standingOrderId === undefined
    ? query
    : query.where(eq(schema.standingOrderRuns.standingOrderId, standingOrderId));
}

async function standingOrderNotifications(agent: Agent) {
  const res = await agent.get('/api/v1/notifications');
  expect(res.status).toBe(200);
  return notificationListResponseSchema
    .parse(res.body)
    .items.filter((item) => item.type === 'standing_order.skipped');
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

  it('scopes the raw run ledger to the owner', async () => {
    // `/runs` is the paranoid capture's read of the authoritative exactly-once
    // ledger, so it enumerates rows rather than taking an id — the ownership
    // join is the whole access control. A stranger seeing these rows would read
    // another account's booking history, and restoring them through disable
    // would tombstone periods that were never theirs.
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

    const owned = await agent.get('/api/v1/standing-orders/runs');
    expect(owned.status).toBe(200);
    expect(standingOrderRunListResponseSchema.parse(owned.body).runs).toHaveLength(1);

    const other = await harness.seedUser({ email: 'runs@bettertrack.test', username: 'runsbob' });
    const otherAgent = await loginAgent(harness.app, other.email, other.password);
    const strangerView = await otherAgent.get('/api/v1/standing-orders/runs');
    expect(strangerView.status).toBe(200);
    expect(standingOrderRunListResponseSchema.parse(strangerView.body).runs).toEqual([]);
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

  it('skips a stale due row after its account enters paranoid mode', async () => {
    const { user, agent, pid } = await setup();
    await createOrder(agent, {
      portfolioId: pid,
      kind: 'cash-add',
      amount: 100,
      label: 'must not book',
      cadence: 'daily',
      startDate: '2026-04-01',
    });
    await harness.db
      .update(schema.users)
      .set({
        privacyMode: 'paranoid',
        paranoidMediaSet: ['drive'],
        paranoidDriveAttestedVersion: 1,
      })
      .where(eq(schema.users.id, user.id));

    expect(await run('2026-04-01T12:00:00Z')).toEqual({
      scanned: 1,
      booked: 0,
      bookingFailed: 0,
      skippedDuplicate: 0,
      deferred: 0,
      skippedArchived: 0,
      failed: 0,
    });
    expect(await cashRows(pid, SOURCE_TAG_STANDING_ORDER)).toHaveLength(0);
    await expect(harness.ctx.standingOrders.list(user.id)).rejects.toMatchObject({
      code: 'PARANOID_MODE',
    });
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

  it('does not claim or book when a pause lands between the scan snapshot and claim', async () => {
    const { user, agent, pid } = await setup();
    const created = await createOrder(agent, {
      portfolioId: pid,
      kind: 'cash-add',
      amount: 10,
      cadence: 'daily',
      startDate: '2026-04-01',
    });
    const id = created.body.id as string;
    const repo = createStandingOrderRepository(harness.db);
    let pauseLanded = false;
    const service = createStandingOrderService({
      repo: {
        ...repo,
        // AC 1 (#1119): the pause commits after this scan's `listActive`
        // snapshot but before the locked claim. The in-lock status re-check
        // (`withActivePortfolioLock`) must turn the stale row into a no-op.
        async withActivePortfolioLock(portfolioId, orderId, periodKey, action) {
          expect(orderId).toBe(id);
          const paused = await repo.setStatus(user.id, orderId, 'paused');
          expect(paused?.status).toBe('paused');
          pauseLanded = true;
          return repo.withActivePortfolioLock(portfolioId, orderId, periodKey, action);
        },
      },
      portfolioRepo: createPortfolioRepository(harness.db),
      assetRepo: createAssetRepository(harness.db),
      transactionRepo: createTransactionRepository(harness.db),
      cashMovementRepo: createCashMovementRepository(harness.db),
      cashSourceRepo: createCashSourceRepository(harness.db),
      marketData: createStubMarketData(),
      snapshots: { async invalidate() {} },
      notify: {
        async emit() {
          return true;
        },
      },
    });

    const result = await service.processDueOrders({ now: Date.parse('2026-04-01T12:00:00Z') });

    expect(pauseLanded).toBe(true);
    expect(result).toMatchObject({
      booked: 0,
      skippedDuplicate: 0,
      skippedArchived: 1,
      failed: 0,
    });
    expect(await cashRows(pid, SOURCE_TAG_STANDING_ORDER)).toEqual([]);
    expect(await runPeriodKeys()).toEqual([]);
  });
});

/**
 * A service whose portfolio lock runs `mutate` in exactly the window the daily
 * scan leaves open (#1836): after `listActive` snapshotted the row, before the
 * locked claim re-reads it. Everything else is the harness's real wiring, so
 * the booking below goes through the real repositories.
 */
function serviceWithLockHook(mutate: (orderId: string) => Promise<void>) {
  const repo = createStandingOrderRepository(harness.db);
  return createStandingOrderService({
    repo: {
      ...repo,
      async withActivePortfolioLock(portfolioId, orderId, periodKey, action) {
        await mutate(orderId);
        return repo.withActivePortfolioLock(portfolioId, orderId, periodKey, action);
      },
    },
    portfolioRepo: createPortfolioRepository(harness.db),
    assetRepo: createAssetRepository(harness.db),
    transactionRepo: createTransactionRepository(harness.db),
    cashMovementRepo: createCashMovementRepository(harness.db),
    cashSourceRepo: createCashSourceRepository(harness.db),
    marketData,
    snapshots: { async invalidate() {} },
    notify: {
      async emit() {
        return true;
      },
    },
  });
}

describe('standing orders — an edit between the scan snapshot and the claim', () => {
  it('books the amount and note in force at the claim, not the snapshotted ones', async () => {
    const { user, agent, pid } = await setup();
    const created = await createOrder(agent, {
      portfolioId: pid,
      kind: 'cash-deduct',
      amount: 3000,
      label: 'rent',
      cadence: 'monthly',
      anchorDay: 1,
      startDate: '2026-04-01',
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    await depositCash(agent, pid, 5000);

    const repo = createStandingOrderRepository(harness.db);
    let edited = false;
    const service = serviceWithLockHook(async (orderId) => {
      expect(orderId).toBe(id);
      const patched = await repo.update(user.id, orderId, { amount: 30, label: 'rent (cut)' });
      expect(patched?.amount).toBe(30);
      edited = true;
    });

    const result = await service.processDueOrders({ now: Date.parse('2026-04-01T12:00:00Z') });

    expect(edited).toBe(true);
    expect(result).toMatchObject({ booked: 1, deferred: 0, skippedArchived: 0, failed: 0 });
    const rows = await cashRows(pid, SOURCE_TAG_STANDING_ORDER);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.amountEur)).toBe(-30);
    expect(rows[0]!.note).toBe('rent (cut)');
    expect((await runPeriodKeys(id)).map((r) => r.key)).toEqual(['2026-04-01']);
  });

  it('books the buy quantity in force at the claim, not the snapshotted one', async () => {
    const { user, agent, pid } = await setup();
    const assetId = await seedAsset('EDIT');
    const created = await createOrder(agent, {
      portfolioId: pid,
      kind: 'buy-asset',
      assetId,
      amount: 10,
      cadence: 'monthly',
      anchorDay: 1,
      startDate: '2026-04-01',
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const repo = createStandingOrderRepository(harness.db);
    const service = serviceWithLockHook(async (orderId) => {
      const patched = await repo.update(user.id, orderId, { amount: 2 });
      expect(patched?.amount).toBe(2);
    });

    const result = await service.processDueOrders({ now: Date.parse('2026-04-01T12:00:00Z') });

    expect(result).toMatchObject({ booked: 1, deferred: 0, skippedArchived: 0, failed: 0 });
    const txns = await txnRows(pid);
    expect(txns).toHaveLength(1);
    expect(Number(txns[0]!.quantity)).toBe(2);
    expect(Number(txns[0]!.price)).toBe(100);
    expect(txns[0]!.source).toBe(SOURCE_TAG_STANDING_ORDER);
    expect((await runPeriodKeys(id)).map((r) => r.key)).toEqual(['2026-04-01']);
  });

  it('does not book a period an end date pulled back behind it has retired', async () => {
    const { user, agent, pid } = await setup();
    const created = await createOrder(agent, {
      portfolioId: pid,
      kind: 'cash-add',
      amount: 10,
      cadence: 'daily',
      startDate: '2026-04-01',
    });
    const id = created.body.id as string;
    expect((await run('2026-04-01T12:00:00Z')).booked).toBe(1);

    const repo = createStandingOrderRepository(harness.db);
    const service = serviceWithLockHook(async (orderId) => {
      const patched = await repo.update(user.id, orderId, { endDate: '2026-04-01' });
      expect(patched?.endDate).toBe('2026-04-01');
    });

    const result = await service.processDueOrders({ now: Date.parse('2026-04-02T12:00:00Z') });

    expect(result).toMatchObject({
      booked: 0,
      skippedDuplicate: 0,
      deferred: 0,
      skippedArchived: 1,
      failed: 0,
    });
    // Only Apr 1 — Apr 2 is neither booked nor claimed, so nothing was burnt.
    expect(await cashRows(pid, SOURCE_TAG_STANDING_ORDER)).toHaveLength(1);
    expect((await runPeriodKeys(id)).map((r) => r.key)).toEqual(['2026-04-01']);
  });

  it('judges affordability against the fresh amount, not the snapshotted one', async () => {
    const { user, agent, pid } = await setup();
    const created = await createOrder(agent, {
      portfolioId: pid,
      kind: 'cash-deduct',
      amount: 10,
      label: 'netflix',
      cadence: 'daily',
      startDate: '2026-04-01',
    });
    const id = created.body.id as string;
    await depositCash(agent, pid, 50);

    const repo = createStandingOrderRepository(harness.db);
    const service = serviceWithLockHook(async (orderId) => {
      const patched = await repo.update(user.id, orderId, { amount: 200 });
      expect(patched?.amount).toBe(200);
    });

    const result = await service.processDueOrders({ now: Date.parse('2026-04-01T12:00:00Z') });

    // The snapshotted €10 was covered; the €200 in force is not — so the period
    // defers (and retries) instead of overdrawing the portfolio.
    expect(result).toMatchObject({ booked: 0, deferred: 1, skippedArchived: 0, failed: 0 });
    expect(await cashRows(pid, SOURCE_TAG_STANDING_ORDER)).toEqual([]);
    expect(await runPeriodKeys(id)).toEqual([]);
  });
});

describe('standing orders — archived portfolios', () => {
  it('suspends archived orders and resumes only at the first later anchor', async () => {
    const { agent, pid: activePid } = await setup();
    const portfolio = await agent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Retired' });
    expect(portfolio.status).toBe(201);
    const pid = portfolio.body.portfolio.id as string;

    const retiredOrder = await createOrder(agent, {
      portfolioId: pid,
      kind: 'cash-add',
      amount: 100,
      label: 'salary',
      cadence: 'monthly',
      anchorDay: 1,
      startDate: '2026-04-01',
    });
    const pausedOrder = await createOrder(agent, {
      portfolioId: pid,
      kind: 'cash-add',
      amount: 10,
      label: 'paused',
      cadence: 'daily',
      startDate: '2026-04-01',
    });
    expect(pausedOrder.status).toBe(201);
    expect(
      (
        await agent
          .post(`/api/v1/standing-orders/${pausedOrder.body.id as string}/pause`)
          .set(...XRW)
      ).status,
    ).toBe(200);
    await createOrder(agent, {
      portfolioId: activePid,
      kind: 'cash-add',
      amount: 10,
      label: 'still active',
      cadence: 'monthly',
      anchorDay: 1,
      startDate: '2026-04-01',
    });
    expect((await run('2026-04-01T12:00:00Z')).booked).toBe(2);

    portfolioNow = Date.parse('2026-04-02T12:00:00Z');
    expect((await agent.post(`/api/v1/portfolios/${pid}/archive`).set(...XRW)).status).toBe(200);

    const suspended = await agent.get(`/api/v1/standing-orders?portfolioId=${pid}`);
    expect(suspended.status).toBe(200);
    const suspendedOrders = standingOrderListResponseSchema.parse(suspended.body).orders;
    expect(suspendedOrders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: retiredOrder.body.id,
          status: 'active',
          suspendedByArchive: true,
          nextRunDate: null,
        }),
        expect.objectContaining({
          id: pausedOrder.body.id,
          status: 'paused',
          suspendedByArchive: true,
          nextRunDate: null,
        }),
      ]),
    );

    // The scanner never sees the archived portfolio, while a second active
    // portfolio remains scannable through the same global listActive query.
    expect(await run('2026-05-01T12:00:00Z')).toEqual({
      scanned: 1,
      booked: 1,
      bookingFailed: 0,
      skippedDuplicate: 0,
      deferred: 0,
      skippedArchived: 0,
      failed: 0,
    });
    expect(await cashRows(pid, SOURCE_TAG_STANDING_ORDER)).toHaveLength(1);
    expect(await cashRows(activePid, SOURCE_TAG_STANDING_ORDER)).toHaveLength(2);

    // May's anchor elapsed while archived. Restore claims it as a no-money
    // tombstone before reopening the portfolio, so the next eligible anchor
    // is June 1 rather than a catch-up booking for May 1.
    portfolioNow = Date.parse('2026-05-15T12:00:00Z');
    expect((await agent.post(`/api/v1/portfolios/${pid}/restore`).set(...XRW)).status).toBe(200);

    const restored = await agent.get(`/api/v1/standing-orders?portfolioId=${pid}`);
    const restoredOrder = standingOrderListResponseSchema
      .parse(restored.body)
      .orders.find((order) => order.id === retiredOrder.body.id);
    expect(restoredOrder).toBeDefined();
    expect(restoredOrder).toMatchObject({
      status: 'active',
      suspendedByArchive: false,
      nextRunDate: '2026-06-01',
    });

    expect((await run('2026-05-15T12:00:00Z')).booked).toBe(0);
    expect(await cashRows(pid, SOURCE_TAG_STANDING_ORDER)).toHaveLength(1);
    expect((await run('2026-06-01T12:00:00Z')).booked).toBe(2);
    expect(await cashRows(pid, SOURCE_TAG_STANDING_ORDER)).toHaveLength(2);

    // May's run is a durable no-booking claim; only April and June made money.
    expect(
      (await runPeriodKeys(retiredOrder.body.id as string)).map((row) => row.key).sort(),
    ).toEqual(['2026-04-01', '2026-05-01', '2026-06-01']);
  });

  it('books the period due on the restore day itself (anchor-day restore)', async () => {
    const { agent } = await setup();
    const portfolio = await agent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Anchor-day restore' });
    expect(portfolio.status).toBe(201);
    const pid = portfolio.body.portfolio.id as string;

    const order = await createOrder(agent, {
      portfolioId: pid,
      kind: 'cash-add',
      amount: 100,
      label: 'salary',
      cadence: 'monthly',
      anchorDay: 1,
      startDate: '2026-04-01',
    });
    expect(order.status).toBe(201);
    expect((await run('2026-04-01T12:00:00Z')).booked).toBe(1);

    portfolioNow = Date.parse('2026-04-20T12:00:00Z');
    expect((await agent.post(`/api/v1/portfolios/${pid}/archive`).set(...XRW)).status).toBe(200);

    // Restoring ON the anchor day must not tombstone that period: only
    // strictly-past periods are skipped, and April is already booked, so the
    // restore claims nothing and May 1 books normally on the day's scan.
    portfolioNow = Date.parse('2026-05-01T08:00:00Z');
    expect((await agent.post(`/api/v1/portfolios/${pid}/restore`).set(...XRW)).status).toBe(200);

    const restored = await agent.get(`/api/v1/standing-orders?portfolioId=${pid}`);
    const restoredOrder = standingOrderListResponseSchema
      .parse(restored.body)
      .orders.find((candidate) => candidate.id === order.body.id);
    expect(restoredOrder).toMatchObject({
      status: 'active',
      suspendedByArchive: false,
      lastPeriodKey: '2026-04-01',
      nextRunDate: '2026-05-01',
    });
    expect((await runPeriodKeys(order.body.id as string)).map((row) => row.key)).toEqual([
      '2026-04-01',
    ]);

    expect(await run('2026-05-01T12:00:00Z')).toEqual({
      scanned: 1,
      booked: 1,
      bookingFailed: 0,
      skippedDuplicate: 0,
      deferred: 0,
      skippedArchived: 0,
      failed: 0,
    });
    expect(await cashRows(pid, SOURCE_TAG_STANDING_ORDER)).toHaveLength(2);
    expect((await runPeriodKeys(order.body.id as string)).map((row) => row.key).sort()).toEqual([
      '2026-04-01',
      '2026-05-01',
    ]);
  });

  it('tombstones an archived buy before the post-restore quote pre-check', async () => {
    const { agent } = await setup();
    const portfolio = await agent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Archived buy' });
    expect(portfolio.status).toBe(201);
    const pid = portfolio.body.portfolio.id as string;
    const assetId = await seedAsset('ARCH');

    await createOrder(agent, {
      portfolioId: pid,
      kind: 'buy-asset',
      assetId,
      amount: 1,
      cadence: 'monthly',
      anchorDay: 1,
      startDate: '2026-04-01',
    });
    expect((await run('2026-04-01T12:00:00Z')).booked).toBe(1);

    portfolioNow = Date.parse('2026-04-02T12:00:00Z');
    expect((await agent.post(`/api/v1/portfolios/${pid}/archive`).set(...XRW)).status).toBe(200);

    portfolioNow = Date.parse('2026-05-15T12:00:00Z');
    expect((await agent.post(`/api/v1/portfolios/${pid}/restore`).set(...XRW)).status).toBe(200);

    // May is already watermark-tombstoned, so this scan must not attempt a
    // quote (which would otherwise defer the archived period).
    quote.mode = 'fail';
    expect(await run('2026-05-15T12:00:00Z')).toEqual({
      scanned: 1,
      booked: 0,
      bookingFailed: 0,
      skippedDuplicate: 0,
      deferred: 0,
      skippedArchived: 0,
      failed: 0,
    });
    expect(await txnRows(pid)).toHaveLength(1);

    quote.mode = 'ok';
    quote.asOf = '2026-06-01T00:00:00.000Z'; // stay inside the booking age ceiling
    expect((await run('2026-06-01T12:00:00Z')).booked).toBe(1);
    expect(await txnRows(pid)).toHaveLength(2);
  });

  it('does not book an order scanned before its portfolio is archived', async () => {
    let quoteStarted!: () => void;
    let releaseQuote!: () => void;
    const quoteIsInFlight = new Promise<void>((resolve) => {
      quoteStarted = resolve;
    });
    const delayedMarketData = createStubMarketData({
      quote: async () => {
        quoteStarted();
        await new Promise<void>((resolve) => {
          releaseQuote = resolve;
        });
        return {
          value: { price: 100, currency: 'EUR', asOf: '2026-04-01T00:00:00.000Z' },
          stale: false,
          asOf: 0,
        };
      },
    });
    // Rebuild this test's app around the delayed quote so the worker has a
    // controlled gap after listActive() but before its final archive guard.
    harness = await createTestApp({
      marketData: delayedMarketData,
      portfolioNow: () => portfolioNow ?? Date.now(),
    });
    const { agent } = await setup();
    const portfolio = await agent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Archive race' });
    expect(portfolio.status).toBe(201);
    const pid = portfolio.body.portfolio.id as string;
    const assetId = await seedAsset('RACE');
    const created = await createOrder(agent, {
      portfolioId: pid,
      kind: 'buy-asset',
      assetId,
      amount: 1,
      cadence: 'daily',
      startDate: '2026-04-01',
    });
    expect(created.status).toBe(201);

    const processing = run('2026-04-01T12:00:00Z');
    await quoteIsInFlight;

    // The archive wins while the worker is awaiting its provider response. The
    // worker must repeat the active check under the shared portfolio lock before
    // it claims or inserts the trade.
    portfolioNow = Date.parse('2026-04-01T12:00:01Z');
    expect((await agent.post(`/api/v1/portfolios/${pid}/archive`).set(...XRW)).status).toBe(200);
    releaseQuote();

    expect(await processing).toEqual({
      scanned: 1,
      booked: 0,
      bookingFailed: 0,
      skippedDuplicate: 0,
      deferred: 0,
      // The in-lock recheck's abort is visible in the scan tally.
      skippedArchived: 1,
      failed: 0,
    });
    expect(await txnRows(pid)).toHaveLength(0);
    expect(await runPeriodKeys(created.body.id as string)).toEqual([]);
  });

  it('does not let a delayed pre-midnight scan book behind a restored watermark', async () => {
    let quoteStarted!: () => void;
    let releaseQuote!: () => void;
    let released = false;
    const quoteIsInFlight = new Promise<void>((resolve) => {
      quoteStarted = resolve;
    });
    const delayedMarketData = createStubMarketData({
      quote: async () => {
        // Only the first quote is held in flight; later scans resolve directly.
        if (!released) {
          quoteStarted();
          await new Promise<void>((resolve) => {
            releaseQuote = () => {
              released = true;
              resolve();
            };
          });
        }
        return {
          value: { price: 100, currency: 'EUR', asOf: '2026-04-01T00:00:00.000Z' },
          stale: false,
          asOf: 0,
        };
      },
    });
    harness = await createTestApp({
      marketData: delayedMarketData,
      portfolioNow: () => portfolioNow ?? Date.now(),
    });
    const { agent } = await setup();
    const portfolio = await agent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Restore boundary race' });
    expect(portfolio.status).toBe(201);
    const pid = portfolio.body.portfolio.id as string;
    const assetId = await seedAsset('BOUNDARY');
    const created = await createOrder(agent, {
      portfolioId: pid,
      kind: 'buy-asset',
      assetId,
      amount: 1,
      cadence: 'daily',
      startDate: '2026-04-01',
    });
    expect(created.status).toBe(201);

    // Europe/Vienna is UTC+2 here. The scan sees Apr 1 just before Vienna
    // midnight; archive + restore cross to Apr 2 while its quote is in flight.
    const processing = run('2026-04-01T21:59:00Z');
    await quoteIsInFlight;

    portfolioNow = Date.parse('2026-04-01T21:59:30Z');
    expect((await agent.post(`/api/v1/portfolios/${pid}/archive`).set(...XRW)).status).toBe(200);

    portfolioNow = Date.parse('2026-04-01T22:00:30Z');
    expect((await agent.post(`/api/v1/portfolios/${pid}/restore`).set(...XRW)).status).toBe(200);
    releaseQuote();

    expect(await processing).toEqual({
      scanned: 1,
      booked: 0,
      bookingFailed: 0,
      skippedDuplicate: 0,
      deferred: 0,
      skippedArchived: 1,
      failed: 0,
    });
    expect(await txnRows(pid)).toHaveLength(0);
    expect(await cashRows(pid, SOURCE_TAG_STANDING_ORDER)).toHaveLength(0);
    // Restore tombstones only the strictly-past Apr 1 period the delayed worker
    // was still holding; Apr 2 — due on the restore day itself — stays bookable.
    expect((await runPeriodKeys(created.body.id as string)).map((row) => row.key)).toEqual([
      '2026-04-01',
    ]);

    const restored = await agent.get(`/api/v1/standing-orders?portfolioId=${pid}`);
    const restoredOrder = standingOrderListResponseSchema
      .parse(restored.body)
      .orders.find((order) => order.id === created.body.id);
    expect(restoredOrder).toMatchObject({
      lastPeriodKey: '2026-04-01',
      nextRunDate: '2026-04-02',
    });

    // The watermark blocks only the elapsed period: the restore-day occurrence
    // books normally on its own scan.
    expect((await run('2026-04-02T10:00:00Z')).booked).toBe(1);
    expect(await txnRows(pid)).toHaveLength(1);
    expect((await runPeriodKeys(created.body.id as string)).map((row) => row.key).sort()).toEqual([
      '2026-04-01',
      '2026-04-02',
    ]);
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
  it('notifies on the anchor day itself, then dedupes the later retry (#1793)', async () => {
    const { agent, pid } = await setup();
    const assetId = await seedAsset('BBB');
    const created = await createOrder(agent, {
      portfolioId: pid,
      kind: 'buy-asset',
      assetId,
      amount: 2,
      cadence: 'monthly',
      anchorDay: 1,
      startDate: '2026-04-01',
    });

    quote.mode = 'fail';
    const failed = await run('2026-04-01T12:00:00Z');
    expect(failed.booked).toBe(0);
    expect(failed.deferred).toBe(1);
    expect(await txnRows(pid)).toHaveLength(0);
    expect(await runPeriodKeys()).toHaveLength(0); // no claim was made
    // The period is named on the day it was owed, not a day later (#1793) —
    // the old `due < today` gate never opened at all for a daily cadence.
    const anchorDayNotice = [
      expect.objectContaining({
        type: 'standing_order.skipped',
        payload: expect.objectContaining({
          standingOrderId: created.body.id,
          periodKey: '2026-04-01',
          outcome: 'deferred',
        }),
      }),
    ];
    expect(await standingOrderNotifications(agent)).toEqual(anchorDayNotice);

    // Still unbooked on Apr 2: the same (period, outcome) key, so the repeat
    // failure dedupes into the one stable notice rather than nagging daily.
    expect((await run('2026-04-02T12:00:00Z')).deferred).toBe(1);
    expect(await standingOrderNotifications(agent)).toEqual(anchorDayNotice);

    quote.mode = 'ok';
    expect((await run('2026-04-02T12:00:00Z')).booked).toBe(1);
    expect(await txnRows(pid)).toHaveLength(1);
    // A further run does not double-book the recovered period.
    expect((await run('2026-04-02T12:00:00Z')).booked).toBe(0);
    expect(await txnRows(pid)).toHaveLength(1);
  });

  it('announces a daily buy’s deferral on the only day it is ever due (#1793)', async () => {
    const { agent, pid } = await setup();
    const assetId = await seedAsset('DLY');
    const created = await createOrder(agent, {
      portfolioId: pid,
      kind: 'buy-asset',
      assetId,
      amount: 1,
      cadence: 'daily',
      startDate: '2026-04-01',
    });
    expect(created.status).toBe(201);

    // A daily order's due occurrence IS today on every scan, so the old
    // `due < today` gate never opened: the provider could be down for a week
    // and not one deferred notice would ever be sent.
    quote.mode = 'fail';
    expect(await run('2026-04-01T12:00:00Z')).toMatchObject({
      booked: 0,
      deferred: 1,
      failed: 0,
    });
    expect(await txnRows(pid)).toEqual([]);
    expect(await runPeriodKeys()).toEqual([]);
    expect(await standingOrderNotifications(agent)).toEqual([
      expect.objectContaining({
        type: 'standing_order.skipped',
        payload: expect.objectContaining({
          standingOrderId: created.body.id,
          periodKey: '2026-04-01',
          outcome: 'deferred',
        }),
      }),
    ]);
  });

  it('polls a definitive quote and defers one past the four-day age ceiling', async () => {
    const { agent, pid } = await setup();
    const assetId = await seedAsset('HALT');
    const created = await createOrder(agent, {
      portfolioId: pid,
      kind: 'buy-asset',
      assetId,
      amount: 2,
      cadence: 'monthly',
      anchorDay: 1,
      startDate: '2026-04-01',
    });

    // A halted/delisted symbol keeps answering with its frozen last close —
    // here five days old at the Apr 1 scan. The synchronous poll succeeds, but
    // the age ceiling refuses it: no claim, no transaction, period deferred.
    quote.asOf = '2026-03-27T12:00:00.000Z';
    expect(await run('2026-04-01T12:00:00Z')).toMatchObject({
      booked: 0,
      deferred: 1,
      failed: 0,
    });
    expect(await txnRows(pid)).toEqual([]);
    expect(await runPeriodKeys()).toEqual([]);
    // The booking path must bypass the serve-stale cache read entirely: the
    // reachable staleness guard is `pollQuote` + the age ceiling, not the
    // never-set-on-poll `stale` flag.
    expect(marketData.calls).toMatchObject({ quote: 0, poll: 1 });
    // The SO3 deferred notice lands on the anchor day (#1793) and dedupes when
    // the symbol is still frozen the next day.
    const frozenNotice = [
      expect.objectContaining({
        type: 'standing_order.skipped',
        payload: expect.objectContaining({
          standingOrderId: created.body.id,
          periodKey: '2026-04-01',
          outcome: 'deferred',
        }),
      }),
    ];
    expect(await standingOrderNotifications(agent)).toEqual(frozenNotice);

    expect((await run('2026-04-02T12:00:00Z')).deferred).toBe(1);
    expect(await standingOrderNotifications(agent)).toEqual(frozenNotice);

    // The market reopens: a current close books — dated at the scan instant,
    // with the quote's own timestamp recorded on `lastRunAt` (AC 4).
    quote.asOf = '2026-04-02T05:00:00.000Z';
    expect(await run('2026-04-02T13:00:00Z')).toMatchObject({ booked: 1, deferred: 0 });
    const [transaction] = await txnRows(pid);
    expect(Number(transaction?.price)).toBe(100);
    expect(transaction?.executedAt.toISOString()).toBe('2026-04-02T13:00:00.000Z');
    const order = await agent.get(`/api/v1/standing-orders/${created.body.id as string}`);
    expect(order.status).toBe(200);
    expect(order.body.lastRunAt).toBe(quote.asOf);
    expect(marketData.calls).toMatchObject({ quote: 0, poll: 3 });
  });

  it('books a prior-session close from a long weekend inside the ceiling', async () => {
    const { agent, pid } = await setup();
    const assetId = await seedAsset('CLOSED');
    const created = await createOrder(agent, {
      portfolioId: pid,
      kind: 'buy-asset',
      assetId,
      amount: 2,
      cadence: 'daily',
      startDate: '2026-03-30',
    });
    // Friday's close at a Monday 07:00-ish scan (~2.7 days): a legitimate
    // exchange closure must NOT defer — the ceiling only rejects older stamps.
    quote.asOf = '2026-03-27T20:00:00.000Z';

    expect(await run('2026-03-30T12:00:00Z')).toMatchObject({
      booked: 1,
      deferred: 0,
      failed: 0,
    });
    const [transaction] = await txnRows(pid);
    expect(transaction?.executedAt.toISOString()).toBe('2026-03-30T12:00:00.000Z');
    const order = await agent.get(`/api/v1/standing-orders/${created.body.id as string}`);
    expect(order.body.lastRunAt).toBe(quote.asOf);
  });

  it('books a year-boundary scan into the current tax year, recording the prior-year close', async () => {
    const { agent, pid } = await setup();
    const assetId = await seedAsset('NYSE');
    const created = await createOrder(agent, {
      portfolioId: pid,
      kind: 'buy-asset',
      assetId,
      amount: 1,
      cadence: 'daily',
      startDate: '2027-01-01',
    });
    // Jan 1, 07:00 Europe/Vienna — before any exchange opens, so the provider
    // still reports Dec 31's close. The engine books at scan time, so the money
    // row stays in the current (2027) Vienna tax year (#1168); the prior-year
    // quote time is record-only on `lastRunAt`.
    quote.asOf = '2026-12-31T21:00:00.000Z';

    expect(await run('2027-01-01T06:00:00Z')).toMatchObject({
      booked: 1,
      deferred: 0,
      failed: 0,
    });
    const [transaction] = await txnRows(pid);
    expect(transaction?.executedAt.toISOString()).toBe('2027-01-01T06:00:00.000Z');
    const order = await agent.get(`/api/v1/standing-orders/${created.body.id as string}`);
    expect(order.body.lastRunAt).toBe('2026-12-31T21:00:00.000Z');
  });

  it('dates a manual-asset buy at the scan instant while recording its valuation day', async () => {
    const { agent, pid } = await setup();
    const createdAsset = await agent
      .post('/api/v1/custom-assets')
      .set(...XRW)
      .send({ name: 'Family house', category: 'other', currency: 'EUR' });
    expect(createdAsset.status).toBe(201);
    const assetId = createdAsset.body.asset.id as string;
    const points = await agent
      .put(`/api/v1/custom-assets/${assetId}/value-points`)
      .set(...XRW)
      .send({ points: [{ date: '2025-01-15', value: 400_000 }] });
    expect(points.status).toBe(200);

    const createdOrder = await createOrder(agent, {
      portfolioId: pid,
      kind: 'buy-asset',
      assetId,
      amount: 1,
      cadence: 'daily',
      startDate: '2026-04-01',
    });
    expect(createdOrder.status).toBe(201);

    // Exercise the production manual provider, not the file-level quote stub:
    // it reports the latest value-point day as Quote.asOf and is marked local —
    // a months-old value point must neither defer on the age ceiling nor be
    // recorded as the run's market stamp.
    const redis = new RedisMock() as unknown as Redis;
    const manual = createManualProvider({ source: createManualAssetSource(harness.db) });
    const manualMarketData = createMarketDataService({
      registry: createProviderRegistry([manual]),
      redis,
    });
    const invalidatedDays: string[] = [];
    const service = createStandingOrderService({
      repo: createStandingOrderRepository(harness.db),
      portfolioRepo: createPortfolioRepository(harness.db),
      assetRepo: createAssetRepository(harness.db),
      transactionRepo: createTransactionRepository(harness.db),
      cashMovementRepo: createCashMovementRepository(harness.db),
      cashSourceRepo: createCashSourceRepository(harness.db),
      marketData: manualMarketData,
      snapshots: {
        async invalidate(_portfolioId, fromDay) {
          invalidatedDays.push(fromDay);
        },
      },
      notify: {
        async emit() {
          return true;
        },
      },
    });
    const scanAt = '2026-04-01T12:00:00.000Z';

    expect(await service.processDueOrders({ now: Date.parse(scanAt) })).toMatchObject({
      booked: 1,
      deferred: 0,
      failed: 0,
    });
    const [transaction] = await txnRows(pid);
    expect(Number(transaction?.price)).toBe(400_000);
    expect(transaction?.executedAt.toISOString()).toBe(scanAt);
    expect(invalidatedDays).toEqual(['2026-04-01']);
    const order = await agent.get(`/api/v1/standing-orders/${createdOrder.body.id as string}`);
    // The exemption from the age ceiling is not an exemption from stating the
    // age (#1793): `lastRunAt` is the market stamp for every other buy, so here
    // it is the owner's own value-point day — 14 months before this booking.
    // Recording `scanAt` made a 2025 valuation indistinguishable from a fresh
    // quote, on the one surface that reports when a buy was priced.
    expect(order.body.lastRunAt).toBe('2025-01-15T00:00:00.000Z');
    expect(order.body.lastRunAt).not.toBe(scanAt);
    expect(Date.parse(scanAt) - Date.parse(order.body.lastRunAt as string)).toBeGreaterThan(
      STANDING_ORDER_MAX_QUOTE_AGE_MS,
    );
    redis.disconnect();
  });
});

describe('standing orders — unbookable quotes (#1712)', () => {
  /**
   * The refusal table is the SHARED contract vector list, so this suite and the
   * vault twin's (`apps/web/src/user/vault/standingOrders/materialize.test.ts`)
   * assert the same bad quotes are refused on both sides.
   */
  it.each([...STANDING_ORDER_QUOTE_REFUSAL_VECTORS])(
    'refuses $name and leaves the period unclaimed',
    async (vector) => {
      const { agent, pid } = await setup();
      const assetId = await seedAsset('REFUSE');
      const created = await createOrder(agent, {
        portfolioId: pid,
        kind: 'buy-asset',
        assetId,
        amount: 3,
        cadence: 'monthly',
        anchorDay: 1,
        startDate: '2026-04-01',
      });
      expect(created.status).toBe(201);
      expect(created.body.currency).toBe(STANDING_ORDER_QUOTE_VECTOR_CURRENCY);

      quote.price = vector.price;
      quote.currency = vector.currency;
      expect(await run('2026-04-01T12:00:00Z')).toMatchObject({
        booked: 0,
        deferred: 1,
        bookingFailed: 0,
        failed: 0,
      });
      // No money row, and — the point — no claim: the period is retryable, not
      // tombstoned behind a booking that never happened.
      expect(await txnRows(pid)).toEqual([]);
      expect(await runPeriodKeys(created.body.id as string)).toEqual([]);

      // A sound quote on the very next scan books that same period.
      quote.price = 100;
      quote.currency = STANDING_ORDER_QUOTE_VECTOR_CURRENCY;
      expect(await run('2026-04-01T13:00:00Z')).toMatchObject({ booked: 1, deferred: 0 });
      const [transaction] = await txnRows(pid);
      expect(Number(transaction?.price)).toBe(100);
      expect((await runPeriodKeys(created.body.id as string)).map((row) => row.key)).toEqual([
        '2026-04-01',
      ]);
    },
  );

  it('refuses a quote the ASSET row does not agree with, and notifies past the anchor', async () => {
    const { agent, pid } = await setup();
    const assetId = await seedAsset('DUALLIST');
    const created = await createOrder(agent, {
      portfolioId: pid,
      kind: 'buy-asset',
      assetId,
      amount: 3,
      cadence: 'monthly',
      anchorDay: 1,
      startDate: '2026-04-01',
    });
    expect(created.status).toBe(201);

    // The failover chain answers from a secondary listing in another currency.
    // The order's stored currency alone cannot catch this — the stored price is
    // a bare number later converted at `assets.currency`, so the joined asset
    // currency is what the guard has to consult.
    await harness.db
      .update(schema.assets)
      .set({ currency: 'USD' })
      .where(eq(schema.assets.id, assetId));
    quote.currency = 'USD';
    quote.price = 128.4;

    expect(await run('2026-04-01T12:00:00Z')).toMatchObject({ booked: 0, deferred: 1, failed: 0 });
    expect(await txnRows(pid)).toEqual([]);
    expect(await runPeriodKeys(created.body.id as string)).toEqual([]);

    // The standard SO3 deferred notice lands on the anchor day, exactly like a
    // provider outage: the period is still owed, never silently booked wrong.
    const refusalNotice = [
      expect.objectContaining({
        type: 'standing_order.skipped',
        payload: expect.objectContaining({
          standingOrderId: created.body.id,
          periodKey: '2026-04-01',
          outcome: 'deferred',
        }),
      }),
    ];
    expect(await standingOrderNotifications(agent)).toEqual(refusalNotice);

    expect((await run('2026-04-02T12:00:00Z')).deferred).toBe(1);
    expect(await standingOrderNotifications(agent)).toEqual(refusalNotice);
    expect(await txnRows(pid)).toEqual([]);
  });
});

describe('standing orders — vault move-in during a scan (#1712)', () => {
  it('provisions no cash source for a portfolio that moved into a vault mid-scan', async () => {
    const { user, agent } = await setup();
    const portfolio = await agent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Move-in race' });
    expect(portfolio.status).toBe(201);
    const pid = portfolio.body.portfolio.id as string;
    const created = await createOrder(agent, {
      portfolioId: pid,
      kind: 'cash-add',
      amount: 10,
      label: 'salary',
      cadence: 'daily',
      startDate: '2026-04-01',
    });
    expect(created.status).toBe(201);

    const [vault] = await harness.db
      .insert(schema.vaults)
      .values({
        userId: user.id,
        name: 'Race vault',
        headerDocId: newId(),
        commonDocId: newId(),
        media: ['server'],
        retirementProofPublicKey: 'race-retirement-key',
        keyFingerprint: 'race-key-fingerprint',
      })
      .returning();

    const repo = createStandingOrderRepository(harness.db);
    const service = createStandingOrderService({
      // The move-in commits in the gap between the scan's optimistic candidate
      // list and the booking: it purges the portfolio's cleartext cash sources
      // and binds the portfolio to the vault, exactly as the transition does.
      repo: {
        ...repo,
        async listActive() {
          const orders = await repo.listActive();
          await harness.db
            .delete(schema.portfolioCashSources)
            .where(eq(schema.portfolioCashSources.portfolioId, pid));
          await harness.db
            .update(schema.portfolios)
            .set({ vaultId: vault!.id })
            .where(eq(schema.portfolios.id, pid));
          return orders;
        },
      },
      portfolioRepo: createPortfolioRepository(harness.db),
      assetRepo: createAssetRepository(harness.db),
      transactionRepo: createTransactionRepository(harness.db),
      cashMovementRepo: createCashMovementRepository(harness.db),
      cashSourceRepo: createCashSourceRepository(harness.db),
      marketData: createStubMarketData(),
      snapshots: { async invalidate() {} },
      notify: {
        async emit() {
          return true;
        },
      },
    });

    expect(
      await service.processDueOrders({ now: Date.parse('2026-04-01T12:00:00Z') }),
    ).toMatchObject({ scanned: 1, booked: 0, skippedArchived: 1, failed: 0 });
    expect(await cashRows(pid)).toEqual([]);
    expect(await runPeriodKeys(created.body.id as string)).toEqual([]);
    // The pre-check used to run `getOrCreateMain` outside the lock, leaving a
    // fresh cleartext row inside a portfolio that is now vault-owned.
    const sources = await harness.db
      .select()
      .from(schema.portfolioCashSources)
      .where(eq(schema.portfolioCashSources.portfolioId, pid));
    expect(sources).toEqual([]);
  });
});

describe('standing orders — per-order failure isolation', () => {
  it('counts a failed claim and continues to a later order', async () => {
    const first = await setup();
    const poisoned = await createOrder(first.agent, {
      portfolioId: first.pid,
      kind: 'cash-add',
      amount: 10,
      label: 'poisoned',
      cadence: 'daily',
      startDate: '2026-04-01',
    });
    const secondUser = await harness.seedUser({
      email: 'healthy-order@bettertrack.test',
      username: 'healthyorder',
    });
    const secondAgent = await loginAgent(harness.app, secondUser.email, secondUser.password);
    const secondPid = await defaultPortfolioId(secondAgent);
    const healthy = await createOrder(secondAgent, {
      portfolioId: secondPid,
      kind: 'cash-add',
      amount: 20,
      label: 'healthy',
      cadence: 'daily',
      startDate: '2026-04-01',
    });
    const poisonedId = poisoned.body.id as string;
    const healthyId = healthy.body.id as string;
    await harness.db
      .update(schema.standingOrders)
      .set({ createdAt: new Date('2026-01-01T00:00:00.000Z') })
      .where(eq(schema.standingOrders.id, poisonedId));
    await harness.db
      .update(schema.standingOrders)
      .set({ createdAt: new Date('2026-01-02T00:00:00.000Z') })
      .where(eq(schema.standingOrders.id, healthyId));

    const repo = createStandingOrderRepository(harness.db);
    const claimOrder: string[] = [];
    const service = createStandingOrderService({
      repo: {
        ...repo,
        async claimPeriod(orderId, periodKey, executor) {
          claimOrder.push(orderId);
          if (orderId === poisonedId) throw new Error('injected poisoned claim');
          return repo.claimPeriod(orderId, periodKey, executor);
        },
      },
      portfolioRepo: createPortfolioRepository(harness.db),
      assetRepo: createAssetRepository(harness.db),
      transactionRepo: createTransactionRepository(harness.db),
      cashMovementRepo: createCashMovementRepository(harness.db),
      cashSourceRepo: createCashSourceRepository(harness.db),
      marketData: createStubMarketData(),
      snapshots: { async invalidate() {} },
      notify: {
        async emit() {
          return true;
        },
      },
    });

    const result = await service.processDueOrders({ now: Date.parse('2026-04-01T12:00:00Z') });

    expect(claimOrder).toEqual([poisonedId, healthyId]);
    expect(result).toMatchObject({ scanned: 2, booked: 1, failed: 1 });
    expect(await cashRows(first.pid, SOURCE_TAG_STANDING_ORDER)).toEqual([]);
    const [movement] = await cashRows(secondPid, SOURCE_TAG_STANDING_ORDER);
    expect(movement).toMatchObject({ note: 'healthy', source: SOURCE_TAG_STANDING_ORDER });
    expect(Number(movement?.amountEur)).toBe(20);
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

  it('aggregates a backlog and re-emits a byte-identical notice on retry', async () => {
    const { user, agent, pid } = await setup();
    const created = await createOrder(agent, {
      portfolioId: pid,
      kind: 'cash-deduct',
      amount: 20,
      label: 'Daily bill',
      cadence: 'daily',
      startDate: '2026-04-01',
    });
    const emitted: DispatchableEvent[] = [];
    const service = createStandingOrderService({
      repo: createStandingOrderRepository(harness.db),
      portfolioRepo: createPortfolioRepository(harness.db),
      assetRepo: createAssetRepository(harness.db),
      transactionRepo: createTransactionRepository(harness.db),
      cashMovementRepo: createCashMovementRepository(harness.db),
      cashSourceRepo: createCashSourceRepository(harness.db),
      marketData: createStubMarketData(),
      snapshots: { async invalidate() {} },
      notify: {
        async emit(event) {
          emitted.push(event);
          return true;
        },
      },
    });

    // Three old periods exist, but each scan emits one aggregate. A retry later
    // that same day reproduces the same logical event; both inbox and webhook
    // delivery key it by order+period+outcome.
    expect(
      (await service.processDueOrders({ now: Date.parse('2026-04-04T12:00:00Z') })).deferred,
    ).toBe(1);
    expect(
      (await service.processDueOrders({ now: Date.parse('2026-04-04T18:00:00Z') })).deferred,
    ).toBe(1);

    const aggregate = {
      type: 'standing_order.skipped',
      userId: user.id,
      standingOrderId: created.body.id,
      periodKey: '2026-04-03',
      outcome: 'dropped',
      droppedCount: 3,
      orderLabel: 'Daily bill',
      occurredAt: '2026-04-03T00:00:00.000Z',
    } as const;
    // The Apr 4 period itself deferred (no cash), and a daily cadence is due on
    // its own day — so the deferred notice rides along with the aggregate on
    // every scan instead of being suppressed forever (#1793). Both are keyed by
    // order+period+outcome, so the same pair repeats byte-identically.
    const deferredToday = {
      type: 'standing_order.skipped',
      userId: user.id,
      standingOrderId: created.body.id,
      periodKey: '2026-04-04',
      outcome: 'deferred',
      orderLabel: 'Daily bill',
      occurredAt: '2026-04-04T00:00:00.000Z',
    } as const;
    expect(emitted).toEqual([aggregate, deferredToday, aggregate, deferredToday]);
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

  it("notifies when April's deferred period drops at the May anchor, then books May", async () => {
    const { agent, pid } = await setup();
    const created = await createOrder(agent, {
      portfolioId: pid,
      kind: 'cash-deduct',
      amount: 20,
      label: 'Netflix',
      cadence: 'monthly',
      anchorDay: 1,
      startDate: '2026-04-01',
    });

    // April defers. At the May anchor, newest-only catch-up permanently drops
    // April and May itself remains deferred until cash arrives on May 3.
    expect((await run('2026-04-01T12:00:00Z')).deferred).toBe(1);
    expect((await run('2026-05-01T12:00:00Z')).deferred).toBe(1);
    await depositCash(agent, pid, 100);
    expect((await run('2026-05-03T12:00:00Z')).booked).toBe(1);

    const dropped = (await standingOrderNotifications(agent)).filter(
      (item) =>
        (item.payload as { outcome?: unknown } | undefined)?.outcome === 'dropped' &&
        (item.payload as { periodKey?: unknown } | undefined)?.periodKey === '2026-04-01',
    );
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({
      type: 'standing_order.skipped',
      payload: {
        standingOrderId: created.body.id,
        periodKey: '2026-04-01',
        outcome: 'dropped',
        droppedCount: 1,
      },
    });
    expect((await runPeriodKeys()).map((row) => row.key)).toEqual(['2026-05-01']);
  });
});

describe('standing orders — post-claim booking tombstone', () => {
  it('does not reclassify a booking-failure tombstone as dropped at the next anchor', async () => {
    const { user, agent, pid } = await setup();
    const created = await createOrder(agent, {
      portfolioId: pid,
      kind: 'cash-add',
      amount: 100,
      label: 'Salary',
      cadence: 'daily',
      startDate: '2026-04-01',
    });
    const emitted: DispatchableEvent[] = [];
    const cashMovementRepo = createCashMovementRepository(harness.db);
    const service = createStandingOrderService({
      repo: createStandingOrderRepository(harness.db),
      portfolioRepo: createPortfolioRepository(harness.db),
      assetRepo: createAssetRepository(harness.db),
      transactionRepo: createTransactionRepository(harness.db),
      cashMovementRepo: {
        ...cashMovementRepo,
        async insert() {
          throw new Error('injected booking failure');
        },
      },
      cashSourceRepo: createCashSourceRepository(harness.db),
      marketData: createStubMarketData(),
      snapshots: { async invalidate() {} },
      notify: {
        async emit(event) {
          emitted.push(event);
          return true;
        },
      },
    });

    const result = await service.processDueOrders({ now: Date.parse('2026-04-01T12:00:00Z') });

    expect(result).toMatchObject({ booked: 0, bookingFailed: 1, deferred: 0, failed: 0 });
    expect((await runPeriodKeys()).map((row) => row.key)).toEqual(['2026-04-01']);
    expect(emitted).toEqual([
      {
        type: 'standing_order.skipped',
        userId: user.id,
        standingOrderId: created.body.id,
        periodKey: '2026-04-01',
        outcome: 'booking_failed',
        orderLabel: 'Salary',
        occurredAt: '2026-04-01T00:00:00.000Z',
      },
    ]);

    emitted.length = 0;
    const nextAnchor = await service.processDueOrders({
      now: Date.parse('2026-04-02T12:00:00Z'),
    });

    expect(nextAnchor).toMatchObject({ booked: 0, bookingFailed: 1, deferred: 0, failed: 0 });
    expect((await runPeriodKeys()).map((row) => row.key).sort()).toEqual([
      '2026-04-01',
      '2026-04-02',
    ]);
    expect(emitted).toEqual([
      expect.objectContaining({
        periodKey: '2026-04-02',
        outcome: 'booking_failed',
      }),
    ]);
  });

  it('does not report a committed row as dropped when markBooked leaves a stale watermark', async () => {
    const { agent, pid } = await setup();
    await createOrder(agent, {
      portfolioId: pid,
      kind: 'cash-add',
      amount: 100,
      label: 'Salary',
      cadence: 'daily',
      startDate: '2026-04-01',
    });
    const emitted: DispatchableEvent[] = [];
    const repo = createStandingOrderRepository(harness.db);
    const service = createStandingOrderService({
      repo: {
        ...repo,
        async markBooked() {
          throw new Error('injected watermark failure');
        },
      },
      portfolioRepo: createPortfolioRepository(harness.db),
      assetRepo: createAssetRepository(harness.db),
      transactionRepo: createTransactionRepository(harness.db),
      cashMovementRepo: createCashMovementRepository(harness.db),
      cashSourceRepo: createCashSourceRepository(harness.db),
      marketData: createStubMarketData(),
      snapshots: { async invalidate() {} },
      notify: {
        async emit(event) {
          emitted.push(event);
          return true;
        },
      },
    });

    expect(
      (await service.processDueOrders({ now: Date.parse('2026-04-01T12:00:00Z') })).booked,
    ).toBe(1);
    expect(
      (await service.processDueOrders({ now: Date.parse('2026-04-02T12:00:00Z') })).booked,
    ).toBe(1);

    expect(await cashRows(pid, SOURCE_TAG_STANDING_ORDER)).toHaveLength(2);
    expect((await runPeriodKeys()).map((row) => row.key).sort()).toEqual([
      '2026-04-01',
      '2026-04-02',
    ]);
    expect(emitted).toEqual([]);
  });
});
