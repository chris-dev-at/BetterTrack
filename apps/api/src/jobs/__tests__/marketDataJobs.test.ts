import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import type { Job } from 'bullmq';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  AssetRef,
  CachedResult,
  HistoryInterval,
  HistoryRange,
  PricePoint,
  Quote,
} from '@bettertrack/contracts';

import type { Database } from '../../data/db';
import * as schema from '../../data/schema';
import type {
  DomainEvent,
  DomainEventType,
  EventBus,
  EventHandler,
  Unsubscribe,
} from '../../events';
import type { Logger } from '../../logger';
import {
  createManualAssetSource,
  createManualProvider,
  createMarketDataService,
  createProviderRegistry,
} from '../../providers';
import { createStubMarketData, type StubMarketDataControls } from '../../testing/marketDataStubs';
import { createDeadLetter } from '../deadLetter';
import {
  BACKFILL_LIMITER,
  BACKFILL_RANGE,
  createFxRefreshSpotJob,
  createJobDefinitions,
  createPricesBackfillJob,
  createPricesRefreshDailyJob,
  DAILY_INTERVAL,
  FX_REFRESH_SPOT_CRON,
  type MarketDataJobDeps,
  PRICES_REFRESH_DAILY_CRON,
  PRICES_REFRESH_DAILY_TZ,
  REFRESH_DAILY_RANGE,
} from '../definitions';
import { registerSchedule, registerSchedules, type SchedulableQueue } from '../scheduler';
import type { JobContext, QueueName } from '../types';
import type { QueueRegistry } from '../queues';

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle',
);

const logger = pino({ level: 'silent' }) as unknown as Logger;

async function makeDb(): Promise<Database> {
  // pg_trgm must be loadable: the 0003 migration CREATEs it (§5.5 search indexes).
  const client = new PGlite({ extensions: { pg_trgm } });
  const db = drizzlePglite(client, { schema }) as unknown as Database;
  await migratePglite(db as never, { migrationsFolder });
  return db;
}

/** Minimal in-process event bus that records what jobs publish. */
function recordingBus(): EventBus & { published: DomainEvent[] } {
  const published: DomainEvent[] = [];
  return {
    published,
    async publish(event) {
      published.push(event);
    },
    async subscribe<T extends DomainEventType>(_type: T, _handler: EventHandler<T>) {
      const unsub: Unsubscribe = async () => {};
      return unsub;
    },
    async close() {},
  };
}

function makeCtx(events: EventBus): JobContext {
  const redis = new RedisMock() as unknown as Redis;
  return { events, deadLetter: createDeadLetter(redis), redis, logger };
}

function makeJob<T>(data: T): Job<T> {
  return {
    id: 'job-1',
    name: 'test',
    data,
    timestamp: Date.parse('2026-06-23T01:00:00.000Z'),
  } as unknown as Job<T>;
}

/** A history stub that records its calls and returns canned points per provider ref. */
function recordingHistory(pointsByRef: Record<string, PricePoint[]>) {
  const calls: { ref: AssetRef; range: HistoryRange; interval?: HistoryInterval }[] = [];
  const history: StubMarketDataControls['history'] = (ref, range, interval) => {
    calls.push({ ref, range, interval });
    const points = pointsByRef[ref.providerRef] ?? [];
    return { value: points, stale: false, asOf: 0 } satisfies CachedResult<PricePoint[]>;
  };
  return { calls, history };
}

function point(date: string, close: number): PricePoint {
  return { time: `${date}T00:00:00.000Z`, close };
}

// ---- seeding helpers ------------------------------------------------------

async function seedUser(db: Database): Promise<string> {
  const rows = await db
    .insert(schema.users)
    .values({ email: 'u@example.com', username: 'u', passwordHash: 'x' })
    .returning({ id: schema.users.id });
  return rows[0]!.id;
}

/** A default (General) watchlist for a user — workboard items require one (V3-P5). */
async function seedWatchlist(db: Database, userId: string): Promise<string> {
  const rows = await db
    .insert(schema.watchlists)
    .values({ userId, name: 'General', isDefault: true })
    .returning({ id: schema.watchlists.id });
  return rows[0]!.id;
}

interface AssetInput {
  providerRef: string;
  type: schema.AssetRow['type'];
  currency?: string;
  ownerId?: string | null;
}

async function seedAsset(db: Database, input: AssetInput): Promise<string> {
  const rows = await db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: input.providerRef,
      ownerId: input.ownerId ?? null,
      type: input.type,
      symbol: input.providerRef,
      name: input.providerRef,
      currency: input.currency ?? 'USD',
    })
    .returning({ id: schema.assets.id });
  return rows[0]!.id;
}

async function closesFor(db: Database, assetId: string): Promise<Record<string, string>> {
  const rows = await db
    .select({ date: schema.priceHistory.date, close: schema.priceHistory.close })
    .from(schema.priceHistory)
    .where(eq(schema.priceHistory.assetId, assetId));
  return Object.fromEntries(rows.map((r) => [r.date, r.close]));
}

// ---- prices.refreshDaily --------------------------------------------------

describe('prices.refreshDaily', () => {
  let db: Database;
  let userId: string;

  beforeEach(async () => {
    db = await makeDb();
    userId = await seedUser(db);
  });

  it('is scheduled nightly at 03:00 Europe/Vienna', () => {
    const job = createPricesRefreshDailyJob({
      db,
      marketData: createStubMarketData(),
    });
    expect(job.name).toBe('prices.refreshDaily');
    expect(job.schedule).toMatchObject({
      id: 'prices.refreshDaily',
      pattern: PRICES_REFRESH_DAILY_CRON,
      tz: PRICES_REFRESH_DAILY_TZ,
    });
    expect(PRICES_REFRESH_DAILY_CRON).toBe('0 3 * * *');
    expect(PRICES_REFRESH_DAILY_TZ).toBe('Europe/Vienna');
  });

  it('upserts daily closes for referenced assets + FX pairs only, and nothing else', async () => {
    // Referenced three different ways, plus an FX pair, plus an unreferenced asset.
    const wbAsset = await seedAsset(db, { providerRef: 'AAPL', type: 'stock' });
    const congAsset = await seedAsset(db, { providerRef: 'MSFT', type: 'stock' });
    const txAsset = await seedAsset(db, { providerRef: 'NVDA', type: 'stock' });
    const fxAsset = await seedAsset(db, { providerRef: 'EURUSD=X', type: 'fx', currency: 'USD' });
    const unrefAsset = await seedAsset(db, { providerRef: 'TSLA', type: 'stock' });

    const wl1 = await seedWatchlist(db, userId);
    await db
      .insert(schema.workboardItems)
      .values({ userId, watchlistId: wl1, assetId: wbAsset, sortOrder: 0 });
    const congRows = await db
      .insert(schema.conglomerates)
      .values({ ownerId: userId, name: 'C', status: 'active' })
      .returning({ id: schema.conglomerates.id });
    await db.insert(schema.conglomeratePositions).values({
      conglomerateId: congRows[0]!.id,
      assetId: congAsset,
      weightPct: '100',
      sortOrder: 0,
    });
    const pfRows = await db
      .insert(schema.portfolios)
      .values({ userId, name: 'Main' })
      .returning({ id: schema.portfolios.id });
    await db.insert(schema.transactions).values({
      portfolioId: pfRows[0]!.id,
      assetId: txAsset,
      side: 'buy',
      quantity: '1',
      price: '10',
      executedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const { calls, history } = recordingHistory({
      AAPL: [point('2026-06-22', 100), point('2026-06-23', 101)],
      MSFT: [point('2026-06-23', 200)],
      NVDA: [point('2026-06-23', 300)],
      'EURUSD=X': [point('2026-06-23', 1.07)],
      TSLA: [point('2026-06-23', 999)],
    });
    const events = recordingBus();
    const job = createPricesRefreshDailyJob({ db, marketData: createStubMarketData({ history }) });

    await job.handler(makeJob({}), makeCtx(events));

    // Wrote referenced + FX, skipped the unreferenced one.
    expect(await closesFor(db, wbAsset)).toEqual({ '2026-06-22': '100', '2026-06-23': '101' });
    expect(await closesFor(db, congAsset)).toEqual({ '2026-06-23': '200' });
    expect(await closesFor(db, txAsset)).toEqual({ '2026-06-23': '300' });
    expect(await closesFor(db, fxAsset)).toEqual({ '2026-06-23': '1.07' });
    expect(await closesFor(db, unrefAsset)).toEqual({});

    // Fetched daily candles over the recent window.
    expect(
      calls.every((c) => c.range === REFRESH_DAILY_RANGE && c.interval === DAILY_INTERVAL),
    ).toBe(true);
    expect(calls.map((c) => c.ref.providerRef).sort()).toEqual(
      ['AAPL', 'EURUSD=X', 'MSFT', 'NVDA'].sort(),
    );

    // One quote.updated per asset actually written.
    expect(events.published.map((e) => e.type)).toEqual(Array(4).fill('quote.updated'));
    expect(events.published.map((e) => (e as { assetId: string }).assetId).sort()).toEqual(
      [wbAsset, congAsset, txAsset, fxAsset].sort(),
    );
    expect(events.published.every((e) => 'occurredAt' in e)).toBe(true);
  });

  it('is idempotent and corrects a revised close on re-run', async () => {
    const assetId = await seedAsset(db, { providerRef: 'AAPL', type: 'stock' });
    const wl2 = await seedWatchlist(db, userId);
    await db
      .insert(schema.workboardItems)
      .values({ userId, watchlistId: wl2, assetId, sortOrder: 0 });

    const first = createPricesRefreshDailyJob({
      db,
      marketData: createStubMarketData({
        history: recordingHistory({ AAPL: [point('2026-06-23', 100)] }).history,
      }),
    });
    await first.handler(makeJob({}), makeCtx(recordingBus()));
    expect(await closesFor(db, assetId)).toEqual({ '2026-06-23': '100' });

    // Re-run with a revised close — overwrites in place, no duplicate-key error.
    const second = createPricesRefreshDailyJob({
      db,
      marketData: createStubMarketData({
        history: recordingHistory({ AAPL: [point('2026-06-23', 105)] }).history,
      }),
    });
    await second.handler(makeJob({}), makeCtx(recordingBus()));
    expect(await closesFor(db, assetId)).toEqual({ '2026-06-23': '105' });
  });

  it('writes the assets that succeed, then throws so the job retries/dead-letters', async () => {
    const okAsset = await seedAsset(db, { providerRef: 'AAPL', type: 'stock' });
    const badAsset = await seedAsset(db, { providerRef: 'BOOM', type: 'stock' });
    const wl3 = await seedWatchlist(db, userId);
    await db.insert(schema.workboardItems).values([
      { userId, watchlistId: wl3, assetId: okAsset, sortOrder: 0 },
      { userId, watchlistId: wl3, assetId: badAsset, sortOrder: 1 },
    ]);

    const marketData = createStubMarketData({
      history: (ref) => {
        if (ref.providerRef === 'BOOM') throw new Error('upstream down');
        return { value: [point('2026-06-23', 100)], stale: false, asOf: 0 };
      },
    });
    const events = recordingBus();
    const job = createPricesRefreshDailyJob({ db, marketData });

    await expect(job.handler(makeJob({}), makeCtx(events))).rejects.toThrow(/1\/2 assets failed/);

    // The healthy asset was still persisted (idempotent retry re-runs the batch).
    expect(await closesFor(db, okAsset)).toEqual({ '2026-06-23': '100' });
    expect(await closesFor(db, badAsset)).toEqual({});
    expect(events.published).toHaveLength(1);
  });

  it('does nothing when no assets are referenced', async () => {
    const events = recordingBus();
    const job = createPricesRefreshDailyJob({
      db,
      marketData: createStubMarketData({ history: () => ({ value: [], stale: false, asOf: 0 }) }),
    });
    await job.handler(makeJob({}), makeCtx(events));
    expect(events.published).toEqual([]);
  });
});

// ---- custom assets: local-provider safety (V3-P2 value smoothing) ---------

/**
 * Regression for the smoothing feature: a custom asset's value marks ARE its
 * `price_history` rows and are the source of truth. The price jobs must never
 * fetch a local (`manual`) provider — with smoothing on, `getHistory` returns the
 * daily-interpolated reconstruction, and persisting that back would turn the
 * interpolated interior days into permanent value marks (violating "every
 * mark-day value stays exact"). These tests wire the REAL manual provider so the
 * reconstruction really happens if the guard is ever removed.
 */
describe('price jobs × custom assets (smoothing must not be persisted)', () => {
  let db: Database;
  let userId: string;

  beforeEach(async () => {
    db = await makeDb();
    userId = await seedUser(db);
  });

  /** Real manual-provider-backed market data on a fixed clock, plus the local guard. */
  function customAssetDeps(nowMs: number): MarketDataJobDeps {
    const registry = createProviderRegistry([
      createManualProvider({ source: createManualAssetSource(db), now: () => nowMs }),
    ]);
    const service = createMarketDataService({
      registry,
      redis: new RedisMock() as unknown as Redis,
    });
    return {
      db,
      marketData: service,
      isLocalProvider: (id) => registry.has(id) && registry.get(id).local === true,
    };
  }

  /** A smoothing-on custom asset held in a portfolio (so it's referenced), with marks. */
  async function seedSmoothedCustomAsset(marks: [string, number][]): Promise<string> {
    const rows = await db
      .insert(schema.assets)
      .values({
        providerId: 'manual',
        providerRef: 'house-1',
        ownerId: userId,
        type: 'custom',
        symbol: 'HOUSE',
        name: 'House',
        currency: 'EUR',
        meta: { smoothing: true },
      })
      .returning({ id: schema.assets.id });
    const assetId = rows[0]!.id;
    // A held custom asset has a BUY txn, so listReferencedAssets includes it.
    const pf = await db
      .insert(schema.portfolios)
      .values({ userId, name: 'Main' })
      .returning({ id: schema.portfolios.id });
    await db.insert(schema.transactions).values({
      portfolioId: pf[0]!.id,
      assetId,
      side: 'buy',
      quantity: '1',
      price: String(marks[0]![1]),
      executedAt: new Date(`${marks[0]![0]}T00:00:00Z`),
    });
    // The value marks live in `price_history` (§5.1).
    await db
      .insert(schema.priceHistory)
      .values(marks.map(([date, value]) => ({ assetId, date, close: String(value) })));
    return assetId;
  }

  it('refreshDaily leaves a smoothing-on custom asset marks exactly as entered', async () => {
    // 2026-07-08 clock so the 1M refresh window covers both marks (see rangeStartMs).
    const nowMs = Date.parse('2026-07-08T00:00:00.000Z');
    const assetId = await seedSmoothedCustomAsset([
      ['2026-06-25', 100],
      ['2026-07-05', 200],
    ]);

    const job = createPricesRefreshDailyJob(customAssetDeps(nowMs));
    await job.handler(makeJob({}), makeCtx(recordingBus()));

    // Only the two real marks remain — none of the 9 interpolated interior days
    // (110, 120, …) leaked into the stored value points.
    expect(await closesFor(db, assetId)).toEqual({ '2026-06-25': '100', '2026-07-05': '200' });
  });

  it('backfill skips a custom asset instead of densifying its marks', async () => {
    const nowMs = Date.parse('2026-07-08T00:00:00.000Z');
    const assetId = await seedSmoothedCustomAsset([
      ['2026-06-25', 100],
      ['2026-07-05', 200],
    ]);

    const job = createPricesBackfillJob(customAssetDeps(nowMs));
    await job.handler(makeJob({ assetId }), makeCtx(recordingBus()));

    expect(await closesFor(db, assetId)).toEqual({ '2026-06-25': '100', '2026-07-05': '200' });
  });
});

// ---- prices.backfill ------------------------------------------------------

describe('prices.backfill', () => {
  let db: Database;

  beforeEach(async () => {
    db = await makeDb();
  });

  it('is rate-limited to ~1 asset/sec and has no schedule (on demand)', () => {
    const job = createPricesBackfillJob({ db, marketData: createStubMarketData() });
    expect(job.name).toBe('prices.backfill');
    expect(job.schedule).toBeUndefined();
    expect(job.workerOptions?.limiter).toEqual(BACKFILL_LIMITER);
    expect(BACKFILL_LIMITER).toEqual({ max: 1, duration: 1000 });
  });

  it('fetches max-range daily history and upserts every close', async () => {
    const assetId = await seedAsset(db, { providerRef: 'AAPL', type: 'stock' });
    const { calls, history } = recordingHistory({
      AAPL: [point('2020-01-02', 70), point('2020-01-03', 71), point('2026-06-23', 200)],
    });
    const events = recordingBus();
    const job = createPricesBackfillJob({ db, marketData: createStubMarketData({ history }) });

    await job.handler(makeJob({ assetId }), makeCtx(events));

    expect(await closesFor(db, assetId)).toEqual({
      '2020-01-02': '70',
      '2020-01-03': '71',
      '2026-06-23': '200',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ range: BACKFILL_RANGE, interval: DAILY_INTERVAL });
    expect(BACKFILL_RANGE).toBe('MAX');
    expect(events.published).toEqual([
      { type: 'quote.updated', assetId, occurredAt: '2026-06-23T01:00:00.000Z' },
    ]);
  });

  it('is idempotent: a second run leaves the same rows', async () => {
    const assetId = await seedAsset(db, { providerRef: 'AAPL', type: 'stock' });
    const deps = {
      db,
      marketData: createStubMarketData({
        history: () => ({
          value: [point('2026-06-22', 99), point('2026-06-23', 100)],
          stale: false,
          asOf: 0,
        }),
      }),
    };
    const job = createPricesBackfillJob(deps);
    await job.handler(makeJob({ assetId }), makeCtx(recordingBus()));
    await job.handler(makeJob({ assetId }), makeCtx(recordingBus()));
    expect(await closesFor(db, assetId)).toEqual({ '2026-06-22': '99', '2026-06-23': '100' });
  });

  it('no-ops for an asset that no longer exists', async () => {
    const events = recordingBus();
    const job = createPricesBackfillJob({
      db,
      marketData: createStubMarketData({ history: () => ({ value: [], stale: false, asOf: 0 }) }),
    });
    // Missing id must not throw (would otherwise dead-letter for no reason).
    await expect(
      job.handler(makeJob({ assetId: '00000000-0000-7000-8000-000000000000' }), makeCtx(events)),
    ).resolves.toBeUndefined();
    expect(events.published).toEqual([]);
  });
});

// ---- fx.refreshSpot -------------------------------------------------------

describe('fx.refreshSpot', () => {
  let db: Database;

  beforeEach(async () => {
    db = await makeDb();
  });

  it('is scheduled hourly', () => {
    const job = createFxRefreshSpotJob({ db, marketData: createStubMarketData() });
    expect(job.name).toBe('fx.refreshSpot');
    expect(job.schedule).toMatchObject({ id: 'fx.refreshSpot', pattern: FX_REFRESH_SPOT_CRON });
    expect(FX_REFRESH_SPOT_CRON).toBe('0 * * * *');
  });

  it('refreshes the quote of every FX pair (and only FX pairs), publishing quote.updated', async () => {
    const fx1 = await seedAsset(db, { providerRef: 'EURUSD=X', type: 'fx', currency: 'USD' });
    const fx2 = await seedAsset(db, { providerRef: 'USDJPY=X', type: 'fx', currency: 'JPY' });
    await seedAsset(db, { providerRef: 'AAPL', type: 'stock' });

    const quoted: string[] = [];
    const quote = (ref: AssetRef): CachedResult<Quote> => {
      quoted.push(ref.providerRef);
      return {
        value: { price: 1.1, currency: 'USD', asOf: '2026-06-23T01:00:00.000Z' },
        stale: false,
        asOf: 0,
      };
    };
    const events = recordingBus();
    const job = createFxRefreshSpotJob({ db, marketData: createStubMarketData({ quote }) });

    await job.handler(makeJob({}), makeCtx(events));

    expect(quoted.sort()).toEqual(['EURUSD=X', 'USDJPY=X']);
    expect(events.published.map((e) => (e as { assetId: string }).assetId).sort()).toEqual(
      [fx1, fx2].sort(),
    );
  });

  it('does nothing when there are no FX pairs', async () => {
    await seedAsset(db, { providerRef: 'AAPL', type: 'stock' });
    const events = recordingBus();
    const job = createFxRefreshSpotJob({
      db,
      marketData: createStubMarketData({
        quote: () => {
          throw new Error('should not be called');
        },
      }),
    });
    await job.handler(makeJob({}), makeCtx(events));
    expect(events.published).toEqual([]);
  });

  it('throws when a pair fails so the job retries/dead-letters', async () => {
    await seedAsset(db, { providerRef: 'EURUSD=X', type: 'fx', currency: 'USD' });
    const job = createFxRefreshSpotJob({
      db,
      marketData: createStubMarketData({
        quote: () => {
          throw new Error('rate-limited');
        },
      }),
    });
    await expect(job.handler(makeJob({}), makeCtx(recordingBus()))).rejects.toThrow(
      /1\/1 FX pairs failed/,
    );
  });
});

// ---- registration ---------------------------------------------------------

// Inert notification center — the registration tests never dispatch (#368).
const inertNotify = { emit: async () => undefined };

describe('createJobDefinitions registration', () => {
  it('builds the heartbeat + market-data jobs + the alerts evaluator', async () => {
    const db = await makeDb();
    const defs = createJobDefinitions({
      db,
      marketData: createStubMarketData(),
      notify: inertNotify,
    });
    expect(defs.map((d) => d.name)).toEqual([
      'system.heartbeat',
      'prices.refreshDaily',
      'prices.backfill',
      'fx.refreshSpot',
      'alerts.evaluate',
    ]);
  });

  it('registers the scheduled jobs and skips the on-demand backfill', async () => {
    const db = await makeDb();
    const defs = createJobDefinitions({
      db,
      marketData: createStubMarketData(),
      notify: inertNotify,
    });

    const calls: { id: string; opts: unknown }[] = [];
    const queue: SchedulableQueue = {
      async upsertJobScheduler(id, opts) {
        calls.push({ id, opts });
        return undefined;
      },
    };
    const registry = { get: (_name: QueueName) => queue } as unknown as QueueRegistry;

    const ids = await registerSchedules(registry, defs);

    expect(ids).toEqual([
      'system.heartbeat',
      'prices.refreshDaily',
      'fx.refreshSpot',
      'alerts.evaluate',
    ]);
    const daily = calls.find((c) => c.id === 'prices.refreshDaily');
    expect(daily?.opts).toEqual({ pattern: '0 3 * * *', tz: 'Europe/Vienna' });
    const fx = calls.find((c) => c.id === 'fx.refreshSpot');
    expect(fx?.opts).toEqual({ pattern: '0 * * * *' });
  });

  it('registers a cron schedule on a real upsert path', async () => {
    // Guards the toRepeatOptions → upsertJobScheduler glue for a pattern+tz spec.
    const calls: unknown[][] = [];
    const queue: SchedulableQueue = {
      async upsertJobScheduler(...args: unknown[]) {
        calls.push(args);
        return undefined;
      },
    };
    await registerSchedule(queue, {
      id: 'prices.refreshDaily',
      pattern: PRICES_REFRESH_DAILY_CRON,
      tz: PRICES_REFRESH_DAILY_TZ,
    });
    expect(calls[0]).toEqual([
      'prices.refreshDaily',
      { pattern: '0 3 * * *', tz: 'Europe/Vienna' },
      { name: 'prices.refreshDaily', data: {} },
    ]);
  });
});
