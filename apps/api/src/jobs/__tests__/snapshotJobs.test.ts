import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import type { Job } from 'bullmq';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { asc, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../../data/db';
import * as schema from '../../data/schema';
import { createCashMovementRepository } from '../../data/repositories/cashMovementRepository';
import { createPortfolioRepository } from '../../data/repositories/portfolioRepository';
import { createPortfolioSnapshotRepository } from '../../data/repositories/portfolioSnapshotRepository';
import { createTransactionRepository } from '../../data/repositories/transactionRepository';
import type { Logger } from '../../logger';
import { createCurrencyService } from '../../services/currency/currencyService';
import { createMarketDataFxSource } from '../../services/currency/marketDataFxSource';
import {
  createPortfolioSnapshotService,
  type PortfolioSnapshotService,
} from '../../services/portfolio/portfolioSnapshots';
import { createStubMarketData } from '../../testing/marketDataStubs';
import { createDeadLetter } from '../deadLetter';
import {
  createSnapshotsBackfillJob,
  createSnapshotsRecomputeJob,
  SNAPSHOTS_BACKFILL_CRON,
  SNAPSHOTS_BACKFILL_SCHEDULER_ID,
  SNAPSHOTS_BACKFILL_TZ,
} from '../definitions';
import type { JobContext } from '../types';
import { handleWorkerFailure } from '../worker';

/**
 * V5-P1 snapshot jobs (issue #553): the nightly roll doubles as the backfill
 * of all existing portfolios — idempotent (a re-run converges to identical
 * rows) and resumable (per-portfolio persistence) — and a persistent failure
 * walks the retry → dead-letter path. The on-demand recompute refills exactly
 * the portfolio a write invalidated.
 */

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle',
);

const logger = pino({ level: 'silent' }) as unknown as Logger;

async function makeDb(): Promise<Database> {
  const client = new PGlite({ extensions: { pg_trgm } });
  const db = drizzlePglite(client, { schema }) as unknown as Database;
  await migratePglite(db as never, { migrationsFolder });
  return db;
}

function makeCtx(): JobContext {
  const redis = new RedisMock() as unknown as Redis;
  return {
    events: {
      publish: async () => {},
      subscribe: async () => async () => {},
      close: async () => {},
    },
    deadLetter: createDeadLetter(redis),
    redis,
    logger,
  };
}

function makeJob<T>(data: T, opts: { attemptsMade?: number; attempts?: number } = {}): Job<T> {
  return {
    id: 'job-1',
    name: 'test',
    data,
    attemptsMade: opts.attemptsMade ?? 1,
    opts: { attempts: opts.attempts ?? 1 },
    timestamp: Date.now(),
  } as unknown as Job<T>;
}

/** ISO day `offset` days before today (UTC). */
function dayOffset(offset: number): string {
  const ms = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  return new Date(ms + offset * 86_400_000).toISOString().slice(0, 10);
}

async function seedUser(db: Database): Promise<string> {
  const rows = await db
    .insert(schema.users)
    .values({ email: 'u@example.com', username: 'u', passwordHash: 'x' })
    .returning({ id: schema.users.id });
  return rows[0]!.id;
}

async function seedPortfolio(db: Database, userId: string, name: string): Promise<string> {
  const rows = await db
    .insert(schema.portfolios)
    .values({ userId, name })
    .returning({ id: schema.portfolios.id });
  return rows[0]!.id;
}

async function seedAsset(db: Database): Promise<string> {
  const rows = await db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: 'BAYN.DE',
      type: 'stock',
      symbol: 'BAYN.DE',
      name: 'Bayer AG',
      currency: 'EUR',
    })
    .returning({ id: schema.assets.id });
  return rows[0]!.id;
}

/** A real snapshot service over PGlite; prices come from stored rows only. */
function makeSnapshotService(db: Database): PortfolioSnapshotService {
  const marketData = createStubMarketData(); // unconfigured: provider hard-down
  return createPortfolioSnapshotService({
    snapshotRepo: createPortfolioSnapshotRepository(db),
    portfolioRepo: createPortfolioRepository(db),
    transactionRepo: createTransactionRepository(db),
    cashMovementRepo: createCashMovementRepository(db),
    marketData,
    currencyService: createCurrencyService({ source: createMarketDataFxSource(marketData) }),
    logger,
  });
}

async function allSnapshotRows(db: Database, portfolioId: string) {
  return db
    .select()
    .from(schema.portfolioDailySnapshots)
    .where(eq(schema.portfolioDailySnapshots.portfolioId, portfolioId))
    .orderBy(asc(schema.portfolioDailySnapshots.date));
}

describe('snapshots.backfill', () => {
  it('is scheduled as the nightly roll (03:30 Europe/Vienna, after prices.refreshDaily)', () => {
    const def = createSnapshotsBackfillJob({ snapshots: {} as PortfolioSnapshotService });
    expect(def.schedule).toEqual({
      id: SNAPSHOTS_BACKFILL_SCHEDULER_ID,
      pattern: SNAPSHOTS_BACKFILL_CRON,
      tz: SNAPSHOTS_BACKFILL_TZ,
    });
    expect(SNAPSHOTS_BACKFILL_CRON).toBe('30 3 * * *');
  });

  it('populates history for every existing portfolio and converges on a re-run (idempotent)', async () => {
    const db = await makeDb();
    const userId = await seedUser(db);
    const assetId = await seedAsset(db);
    const p1 = await seedPortfolio(db, userId, 'Main');
    const p2 = await seedPortfolio(db, userId, 'Cash only');
    await db
      .insert(schema.priceHistory)
      .values(
        [-4, -3, -2, -1].map((d, i) => ({ assetId, date: dayOffset(d), close: String(100 + i) })),
      );
    await db.insert(schema.transactions).values({
      portfolioId: p1,
      assetId,
      side: 'buy',
      quantity: '2',
      price: '100',
      fee: '0',
      executedAt: new Date(`${dayOffset(-4)}T00:00:00.000Z`),
    });
    const [source] = await db
      .insert(schema.portfolioCashSources)
      .values({ portfolioId: p2, name: 'Main', type: 'bank', isMain: true })
      .returning({ id: schema.portfolioCashSources.id });
    await db.insert(schema.portfolioCashMovements).values({
      portfolioId: p2,
      sourceId: source!.id,
      kind: 'deposit',
      amountEur: '500',
      executedAt: new Date(`${dayOffset(-3)}T00:00:00.000Z`),
    });

    const snapshots = makeSnapshotService(db);
    const def = createSnapshotsBackfillJob({ snapshots });
    await def.handler(makeJob({}), makeCtx());

    const rows1 = await allSnapshotRows(db, p1);
    expect(rows1.map((r) => r.date)).toEqual([-4, -3, -2, -1].map(dayOffset));
    expect(rows1.map((r) => Number(r.valueEur))).toEqual([200, 202, 204, 206]);
    expect(rows1.map((r) => Number(r.costBasisEur))).toEqual([200, 200, 200, 200]);
    const rows2 = await allSnapshotRows(db, p2);
    expect(rows2.map((r) => r.date)).toEqual([-3, -2, -1].map(dayOffset));
    expect(rows2.map((r) => Number(r.valueEur))).toEqual([500, 500, 500]);

    // Re-run: converges — identical values, nothing duplicated, nothing lost.
    await def.handler(makeJob({}), makeCtx());
    const rows1Again = await allSnapshotRows(db, p1);
    expect(rows1Again.map((r) => r.date)).toEqual(rows1.map((r) => r.date));
    expect(rows1Again.map((r) => r.valueEur)).toEqual(rows1.map((r) => r.valueEur));
    expect(rows1Again.map((r) => r.flowEur)).toEqual(rows1.map((r) => r.flowEur));
    expect(await allSnapshotRows(db, p2)).toHaveLength(3);
  });

  it('throws on a failing portfolio and dead-letters once attempts are exhausted', async () => {
    const failing: Pick<PortfolioSnapshotService, 'recomputeAll'> = {
      recomputeAll: vi.fn().mockResolvedValue({ total: 3, failures: ['p-broken'] }),
    };
    const def = createSnapshotsBackfillJob({
      snapshots: failing as PortfolioSnapshotService,
    });
    const ctx = makeCtx();
    const job = makeJob<Record<string, never>>({}, { attemptsMade: 3, attempts: 3 });
    await expect(def.handler(job as never, ctx)).rejects.toThrow(/1\/3 portfolios failed/);

    // The worker glue (createJobWorkers → handleWorkerFailure) dead-letters the
    // final attempt — exercised here exactly as the `failed` listener runs it.
    handleWorkerFailure({
      queue: def.name,
      job: job as never,
      err: new Error('snapshots.backfill: 1/3 portfolios failed (first: p-broken)'),
      ctx,
      logger,
    });
    await vi.waitFor(async () => {
      expect(await ctx.deadLetter.size()).toBe(1);
    });
    const [entry] = await ctx.deadLetter.list();
    expect(entry?.queue).toBe('snapshots.backfill');
    expect(entry?.failedReason).toContain('p-broken');
  });
});

describe('snapshots.recompute', () => {
  it('refills exactly the invalidated portfolio', async () => {
    const db = await makeDb();
    const userId = await seedUser(db);
    const assetId = await seedAsset(db);
    const pid = await seedPortfolio(db, userId, 'Main');
    await db
      .insert(schema.priceHistory)
      .values(
        [-3, -2, -1].map((d, i) => ({ assetId, date: dayOffset(d), close: String(100 + i) })),
      );
    await db.insert(schema.transactions).values({
      portfolioId: pid,
      assetId,
      side: 'buy',
      quantity: '1',
      price: '100',
      fee: '0',
      executedAt: new Date(`${dayOffset(-3)}T00:00:00.000Z`),
    });

    const snapshots = makeSnapshotService(db);
    await snapshots.recompute(pid);
    expect(await allSnapshotRows(db, pid)).toHaveLength(3);

    // A write invalidated from -2: rows deleted, state dirty…
    await snapshots.invalidate(pid, dayOffset(-2));
    expect(await allSnapshotRows(db, pid)).toHaveLength(1);

    // …and the on-demand job puts them back.
    const def = createSnapshotsRecomputeJob({ snapshots });
    await def.handler(makeJob({ portfolioId: pid }) as never, makeCtx());
    const rows = await allSnapshotRows(db, pid);
    expect(rows.map((r) => r.date)).toEqual([-3, -2, -1].map(dayOffset));
    const state = await db
      .select()
      .from(schema.portfolioSnapshotState)
      .where(eq(schema.portfolioSnapshotState.portfolioId, pid));
    expect(state[0]?.dirtyFrom ?? null).toBeNull();
    expect(state[0]?.computedThrough).toBe(dayOffset(-1));
  });
});
