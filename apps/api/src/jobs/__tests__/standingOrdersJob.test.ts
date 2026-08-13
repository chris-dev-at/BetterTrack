import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SOURCE_TAG_STANDING_ORDER } from '@bettertrack/contracts';

import { createAssetRepository } from '../../data/repositories/assetRepository';
import { createCashMovementRepository } from '../../data/repositories/cashMovementRepository';
import { createCashSourceRepository } from '../../data/repositories/cashSourceRepository';
import { createPortfolioRepository } from '../../data/repositories/portfolioRepository';
import {
  createStandingOrderRepository,
  type StandingOrderRepository,
} from '../../data/repositories/standingOrderRepository';
import { createTransactionRepository } from '../../data/repositories/transactionRepository';
import * as schema from '../../data/schema';
import type {
  DomainEvent,
  DomainEventType,
  EventBus,
  EventHandler,
  Unsubscribe,
} from '../../events';
import type { Logger } from '../../logger';
import type { CashMovementRepository } from '../../data/repositories/cashMovementRepository';
import {
  createStandingOrderService,
  type ProcessDueResult,
} from '../../services/standingOrders/standingOrderService';
import { createStubMarketData } from '../../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../../testing/createTestApp';
import { createDeadLetter } from '../deadLetter';
import {
  STANDING_ORDERS_CRON,
  STANDING_ORDERS_SCHEDULER_ID,
  STANDING_ORDERS_TZ,
  createStandingOrdersJob,
} from '../definitions/standingOrdersJob';
import type { JobContext } from '../types';

/**
 * `standingOrders.process` at the job seam (§13.5 V5-P6b, #593 / SO4 #1119).
 *
 * The service isolates a per-order failure so the rest of the sweep still books
 * — but isolation must not silently delete the retry the sweep used to get for
 * free. These tests pin the handler's half of that contract: a non-zero `failed`
 * tally rejects the run (so BullMQ's `attempts: 3` re-runs it seconds later and
 * a persistent poison reaches dead-letter), a retry never double-books what an
 * earlier attempt already booked, and neither a graceful defer nor a post-claim
 * at-most-once tombstone may provoke a re-run.
 */

const SCAN_AT = '2026-04-01T07:00:00.000Z';
const PERIOD = '2026-04-01';

const logger = pino({ level: 'silent' }) as unknown as Logger;

let harness: TestHarness;
let redisMocks: Redis[];

beforeEach(async () => {
  redisMocks = [];
  harness = await createTestApp();
});

afterEach(async () => {
  await harness.ctx.events.close();
  for (const redis of redisMocks) redis.disconnect();
});

function silentBus(): EventBus {
  return {
    async publish(_event: DomainEvent) {},
    async subscribe<T extends DomainEventType>(_type: T, _handler: EventHandler<T>) {
      const unsub: Unsubscribe = async () => {};
      return unsub;
    },
    async close() {},
  };
}

function makeCtx(): JobContext {
  const redis = new RedisMock() as unknown as Redis;
  redisMocks.push(redis);
  return { events: silentBus(), deadLetter: createDeadLetter(redis), redis, logger };
}

function makeJob(): Job<Record<string, never>> {
  return {
    id: 'job-1',
    name: 'standingOrders.process',
    data: {},
    timestamp: Date.parse(SCAN_AT),
  } as unknown as Job<Record<string, never>>;
}

async function seedPortfolio(email: string, username: string, name: string) {
  const user = await harness.seedUser({ email, username });
  const [portfolio] = await harness.db
    .insert(schema.portfolios)
    .values({ userId: user.id, name })
    .returning({ id: schema.portfolios.id });
  return { userId: user.id, portfolioId: portfolio!.id };
}

/** One daily `cash-add` order, created at a fixed instant so the sweep order is stable. */
async function seedDailyOrder(
  owner: { userId: string; portfolioId: string },
  label: string,
  amount: number,
  createdAt: string,
): Promise<string> {
  const order = await createStandingOrderRepository(harness.db).create({
    userId: owner.userId,
    portfolioId: owner.portfolioId,
    kind: 'cash-add',
    assetId: null,
    amount,
    currency: 'EUR',
    label,
    cadence: 'daily',
    anchorDay: null,
    startDate: PERIOD,
    endDate: null,
  });
  await harness.db
    .update(schema.standingOrders)
    .set({ createdAt: new Date(createdAt) })
    .where(eq(schema.standingOrders.id, order.id));
  return order.id;
}

interface BuiltJob {
  handler: () => Promise<void>;
  /** The tally of each completed scan, in order. */
  scans: ProcessDueResult[];
}

/** The real service (real repos over PGlite) behind the real job definition. */
function buildJob(
  overrides: {
    repo?: (repo: StandingOrderRepository) => StandingOrderRepository;
    cashMovementRepo?: (
      repo: CashMovementRepository,
    ) => Pick<CashMovementRepository, 'insert' | 'listForPortfolio'>;
  } = {},
): BuiltJob {
  const baseRepo = createStandingOrderRepository(harness.db);
  const baseCash = createCashMovementRepository(harness.db);
  const service = createStandingOrderService({
    repo: overrides.repo ? overrides.repo(baseRepo) : baseRepo,
    portfolioRepo: createPortfolioRepository(harness.db),
    assetRepo: createAssetRepository(harness.db),
    transactionRepo: createTransactionRepository(harness.db),
    cashMovementRepo: overrides.cashMovementRepo ? overrides.cashMovementRepo(baseCash) : baseCash,
    cashSourceRepo: createCashSourceRepository(harness.db),
    marketData: createStubMarketData(),
    snapshots: { async invalidate() {} },
    notify: {
      async emit() {
        return true;
      },
    },
    // The handler calls processDueOrders() with no argument, so the scan clock
    // is the injected one — a retry lands seconds later, i.e. the same day.
    now: () => Date.parse(SCAN_AT),
  });

  const scans: ProcessDueResult[] = [];
  const job = createStandingOrdersJob({
    standingOrders: {
      async processDueOrders(opts) {
        const result = await service.processDueOrders(opts);
        scans.push(result);
        return result;
      },
    },
  });
  return { handler: () => job.handler(makeJob(), makeCtx()), scans };
}

function bookedRows(portfolioId: string) {
  return harness.db
    .select()
    .from(schema.portfolioCashMovements)
    .where(
      and(
        eq(schema.portfolioCashMovements.portfolioId, portfolioId),
        eq(schema.portfolioCashMovements.source, SOURCE_TAG_STANDING_ORDER),
      ),
    );
}

function claimedPeriods(orderId: string) {
  return harness.db
    .select({ periodKey: schema.standingOrderRuns.periodKey })
    .from(schema.standingOrderRuns)
    .where(eq(schema.standingOrderRuns.standingOrderId, orderId));
}

describe('standingOrders.process job — schedule', () => {
  it('runs daily at 07:00 in the deploy timezone', () => {
    const job = createStandingOrdersJob({
      standingOrders: {
        async processDueOrders() {
          return {
            scanned: 0,
            booked: 0,
            bookingFailed: 0,
            skippedDuplicate: 0,
            deferred: 0,
            skippedArchived: 0,
            failed: 0,
          };
        },
      },
    });
    expect(job.name).toBe('standingOrders.process');
    expect(job.schedule).toEqual({
      id: STANDING_ORDERS_SCHEDULER_ID,
      pattern: STANDING_ORDERS_CRON,
      tz: STANDING_ORDERS_TZ,
    });
  });
});

describe('standingOrders.process job — a poisoned order must not silently pass', () => {
  it('books the later order, then fails the run so the retry path engages', async () => {
    const poisonedOwner = await seedPortfolio('poison@bettertrack.test', 'poison', 'Poisoned');
    const healthyOwner = await seedPortfolio('healthy@bettertrack.test', 'healthy', 'Healthy');
    const poisonedId = await seedDailyOrder(
      poisonedOwner,
      'poisoned',
      10,
      '2026-01-01T00:00:00.000Z',
    );
    const healthyId = await seedDailyOrder(healthyOwner, 'healthy', 20, '2026-01-02T00:00:00.000Z');

    const claimAttempts: string[] = [];
    const { handler, scans } = buildJob({
      repo: (repo) => ({
        ...repo,
        async claimPeriod(orderId, periodKey, executor) {
          claimAttempts.push(orderId);
          if (orderId === poisonedId) throw new Error('injected poisoned claim');
          return repo.claimPeriod(orderId, periodKey, executor);
        },
      }),
    });

    // Attempt 1: the healthy order still books, and the run fails.
    await expect(handler()).rejects.toThrow(/1\/2 orders failed unexpectedly/);
    expect(scans[0]).toMatchObject({ scanned: 2, booked: 1, failed: 1 });
    expect(await bookedRows(healthyOwner.portfolioId)).toHaveLength(1);
    expect(await bookedRows(poisonedOwner.portfolioId)).toEqual([]);
    expect(await claimedPeriods(poisonedId)).toEqual([]);

    // Attempt 2 (the BullMQ retry): the healthy order is not re-booked, and the
    // still-poisoned one is re-attempted on its way to dead-letter.
    await expect(handler()).rejects.toThrow(/1\/2 orders failed unexpectedly/);
    expect(scans[1]).toMatchObject({ scanned: 2, booked: 0, failed: 1 });
    expect(await bookedRows(healthyOwner.portfolioId)).toHaveLength(1);
    expect(await claimedPeriods(healthyId)).toEqual([{ periodKey: PERIOD }]);
    expect(claimAttempts).toEqual([poisonedId, healthyId, poisonedId]);
  });

  it('retries the very same period once the transient failure clears', async () => {
    const owner = await seedPortfolio('transient@bettertrack.test', 'transient', 'Transient');
    const orderId = await seedDailyOrder(owner, 'salary', 30, '2026-01-01T00:00:00.000Z');

    let failNextClaim = true;
    const { handler, scans } = buildJob({
      repo: (repo) => ({
        ...repo,
        async claimPeriod(id, periodKey, executor) {
          if (failNextClaim) {
            failNextClaim = false;
            throw new Error('transient claim failure');
          }
          return repo.claimPeriod(id, periodKey, executor);
        },
      }),
    });

    await expect(handler()).rejects.toThrow(/1\/1 orders failed unexpectedly/);
    expect(await bookedRows(owner.portfolioId)).toEqual([]);

    // Seconds later, on the same calendar day: Apr 1 books rather than ageing
    // into a period the next daily scan would report as dropped.
    await expect(handler()).resolves.toBeUndefined();
    expect(scans[1]).toMatchObject({ booked: 1, failed: 0 });
    const [movement] = await bookedRows(owner.portfolioId);
    expect(Number(movement?.amountEur)).toBe(30);
    expect(await claimedPeriods(orderId)).toEqual([{ periodKey: PERIOD }]);
  });

  it('does not re-book a period whose watermark update failed after booking', async () => {
    const poisonedOwner = await seedPortfolio('poison2@bettertrack.test', 'poison2', 'Poisoned');
    const healthyOwner = await seedPortfolio('healthy2@bettertrack.test', 'healthy2', 'Healthy');
    const poisonedId = await seedDailyOrder(
      poisonedOwner,
      'poisoned',
      10,
      '2026-01-01T00:00:00.000Z',
    );
    const healthyId = await seedDailyOrder(healthyOwner, 'healthy', 20, '2026-01-02T00:00:00.000Z');

    // The watermark is best-effort bookkeeping; the run ledger is the claim of
    // record. With `lastPeriodKey` left stale, the retry re-reaches the claim
    // lookup — which must classify the period as an already-taken duplicate.
    let markBookedFails = true;
    const { handler, scans } = buildJob({
      repo: (repo) => ({
        ...repo,
        async claimPeriod(orderId, periodKey, executor) {
          if (orderId === poisonedId) throw new Error('injected poisoned claim');
          return repo.claimPeriod(orderId, periodKey, executor);
        },
        async markBooked(orderId, periodKey, bookedAt) {
          if (markBookedFails) {
            markBookedFails = false;
            throw new Error('injected markBooked failure');
          }
          return repo.markBooked(orderId, periodKey, bookedAt);
        },
      }),
    });

    await expect(handler()).rejects.toThrow(/1\/2 orders failed unexpectedly/);
    expect(scans[0]).toMatchObject({ booked: 1, skippedDuplicate: 0, failed: 1 });
    expect(await bookedRows(healthyOwner.portfolioId)).toHaveLength(1);

    await expect(handler()).rejects.toThrow(/1\/2 orders failed unexpectedly/);
    expect(scans[1]).toMatchObject({ booked: 0, skippedDuplicate: 1, failed: 1 });
    expect(await bookedRows(healthyOwner.portfolioId)).toHaveLength(1);
    expect(await claimedPeriods(healthyId)).toEqual([{ periodKey: PERIOD }]);
  });
});

describe('standingOrders.process job — only an isolated failure fails the run', () => {
  it('completes when a period is gracefully deferred (insufficient cash)', async () => {
    const owner = await seedPortfolio('defer@bettertrack.test', 'defer', 'Deferred');
    await createStandingOrderRepository(harness.db).create({
      userId: owner.userId,
      portfolioId: owner.portfolioId,
      kind: 'cash-deduct',
      assetId: null,
      amount: 50,
      currency: 'EUR',
      label: 'Netflix',
      cadence: 'daily',
      anchorDay: null,
      startDate: PERIOD,
      endDate: null,
    });

    const { handler, scans } = buildJob();

    // A defer already retries on the next daily scan; failing the run here would
    // just burn upstream calls against the §5.3 budget.
    await expect(handler()).resolves.toBeUndefined();
    expect(scans[0]).toMatchObject({ scanned: 1, booked: 0, deferred: 1, failed: 0 });
    expect(await bookedRows(owner.portfolioId)).toEqual([]);
  });

  it('completes when a booking fails after the claim (at-most-once tombstone)', async () => {
    const owner = await seedPortfolio('tomb@bettertrack.test', 'tomb', 'Tombstone');
    const orderId = await seedDailyOrder(owner, 'salary', 40, '2026-01-01T00:00:00.000Z');

    const { handler, scans } = buildJob({
      cashMovementRepo: (repo) => ({
        ...repo,
        async insert() {
          throw new Error('injected ledger write failure');
        },
      }),
    });

    // Retrying this would risk a double-book, so the claim stays as a tombstone
    // and the run must NOT fail.
    await expect(handler()).resolves.toBeUndefined();
    expect(scans[0]).toMatchObject({ scanned: 1, booked: 0, failed: 0 });
    expect(await bookedRows(owner.portfolioId)).toEqual([]);
    expect(await claimedPeriods(orderId)).toEqual([{ periodKey: PERIOD }]);
  });
});
