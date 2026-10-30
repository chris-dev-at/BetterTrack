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
import { AssetNotFoundError } from '../../providers';
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
    isFeatureEnabledGlobally: async () => true,
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
      recomputeAll: vi.fn().mockResolvedValue({ total: 3, failures: ['p-broken'], degraded: [] }),
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

  it('warns about FX-degraded portfolios without failing the sweep (issue #1729)', async () => {
    // A degraded portfolio persisted nothing because FX was unavailable: not a
    // failure (nothing threw, reads stay correct), but it stays dirty and
    // recomputes on every read, so a sustained outage must not read as a clean
    // sweep — the operator gets a warn line instead of silence.
    const degrading: Pick<PortfolioSnapshotService, 'recomputeAll'> = {
      recomputeAll: vi
        .fn()
        .mockResolvedValue({ total: 4, failures: [], degraded: ['p-fx-a', 'p-fx-b'] }),
    };
    const def = createSnapshotsBackfillJob({
      snapshots: degrading as PortfolioSnapshotService,
    });
    const warns: Array<[Record<string, unknown>, string]> = [];
    const capturing: JobContext = {
      ...makeCtx(),
      logger: {
        debug: () => {},
        info: () => {},
        warn: (obj: unknown, msg?: string) => {
          warns.push([obj as Record<string, unknown>, msg ?? '']);
        },
        error: () => {},
      } as unknown as Logger,
    };

    await expect(def.handler(makeJob({}), capturing)).resolves.toBeUndefined();

    expect(warns).toHaveLength(1);
    const [fields, message] = warns[0]!;
    expect(message).toMatch(/unavailable FX/);
    expect(fields).toMatchObject({ total: 4, degraded: 2, firstDegraded: 'p-fx-a' });
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

  it('skips a stale recompute job for a paranoid account without side effects', async () => {
    const recompute = vi.fn(async () => {});
    const def = createSnapshotsRecomputeJob({
      snapshots: { recompute } as unknown as PortfolioSnapshotService,
      isParanoidPortfolio: async () => true,
    });

    await def.handler(makeJob({ portfolioId: 'paranoid-portfolio' }) as never, makeCtx());
    expect(recompute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Issue #1729, guard (a): a nightly run that loses a held currency persists
// nothing, whatever the FX classifier said.
// ---------------------------------------------------------------------------

/** FX behaviour of one simulated night. */
type FxNight = 'ok' | 'not_found';

/** Every day the stored closes and the FX series cover: −50 … today. */
const FX_WINDOW = Array.from({ length: 51 }, (_, i) => -50 + i);

/** Inclusive day-offset range, ascending. */
function offsets(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** A logger that keeps every `warn`, so a refusal is asserted, not inferred. */
function capturingLogger() {
  const warns: Array<{ fields: Record<string, unknown>; msg: string }> = [];
  const log = {
    debug: () => {},
    info: () => {},
    error: () => {},
    warn: (obj: unknown, msg?: string) => {
      warns.push({ fields: obj as Record<string, unknown>, msg: msg ?? '' });
    },
  } as unknown as Logger;
  return { log, warns };
}

/**
 * One EUR asset (2 × 100 EUR) and one USD asset (3 × 200 USD at EURUSD 1.25 =
 * 480 EUR), both bought 45 days back — far outside the 35-day heal window — and
 * priced from stored closes, so the ONLY thing a night varies is FX.
 */
async function seedUsdPortfolio(
  db: Database,
  opts: { sellUsdOn?: number; usdBoughtOn?: number } = {},
) {
  const userId = await seedUser(db);
  const pid = await seedPortfolio(db, userId, 'Main');
  const eurId = await seedAsset(db);
  const usdRows = await db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: 'AAPL',
      type: 'stock',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      currency: 'USD',
    })
    .returning({ id: schema.assets.id });
  const usdId = usdRows[0]!.id;
  await db
    .insert(schema.priceHistory)
    .values([
      ...FX_WINDOW.map((d) => ({ assetId: eurId, date: dayOffset(d), close: '100' })),
      ...FX_WINDOW.map((d) => ({ assetId: usdId, date: dayOffset(d), close: '200' })),
    ]);
  const at = (d: number) => new Date(`${dayOffset(d)}T00:00:00.000Z`);
  const buyOf = (assetId: string, quantity: string, price: string) => ({
    portfolioId: pid,
    assetId,
    side: 'buy' as const,
    quantity,
    price,
    fee: '0',
    executedAt: at(-45),
  });
  await db
    .insert(schema.transactions)
    .values([
      buyOf(eurId, '2', '100'),
      { ...buyOf(usdId, '3', '200'), executedAt: at(opts.usdBoughtOn ?? -45) },
      ...(opts.sellUsdOn === undefined
        ? []
        : [{ ...buyOf(usdId, '3', '200'), side: 'sell' as const, executedAt: at(opts.sellUsdOn) }]),
    ]);
  return { pid, eurId, usdId };
}

/**
 * The snapshot service as one night's worker runs it: the clock at 01:30 UTC of
 * day `night` (03:30 Vienna) and a FRESH FX source. The fresh source is the
 * faithful model, not a convenience: the FX series memo lives at most one
 * history TTL (≤ 6 h), so a night never sees the previous night's series. A
 * `not_found` night gets the shape a negative-cache hit replays —
 * `AssetNotFoundError(…, fromNegativeCache = true)` — which the classifier
 * calls `unconvertible`, i.e. the case the FX classification alone persists.
 */
function nightService(db: Database, night: number, fx: FxNight, log: Logger) {
  const nowMs = Date.parse(`${dayOffset(night)}T01:30:00.000Z`);
  const now = () => nowMs;
  const marketData = createStubMarketData({
    history: (ref) => {
      if (ref.providerRef !== 'EURUSD=X') {
        // Assets fall back to their stored closes.
        throw new Error(`${ref.providerRef}: provider unreachable`);
      }
      if (fx === 'not_found') {
        throw new AssetNotFoundError('EURUSD=X: no data found, symbol may be delisted', true);
      }
      return {
        value: FX_WINDOW.map((d) => ({ time: `${dayOffset(d)}T00:00:00.000Z`, close: 1.25 })),
        stale: false,
        asOf: nowMs,
      };
    },
  });
  const snapshots = createPortfolioSnapshotService({
    snapshotRepo: createPortfolioSnapshotRepository(db),
    portfolioRepo: createPortfolioRepository(db),
    transactionRepo: createTransactionRepository(db),
    cashMovementRepo: createCashMovementRepository(db),
    marketData,
    currencyService: createCurrencyService({
      source: createMarketDataFxSource(marketData, { now }),
    }),
    logger: log,
    now,
  });
  return { snapshots, now };
}

/** Run the real `snapshots.backfill` handler for one night. */
async function runNight(db: Database, night: number, fx: FxNight) {
  const { log, warns } = capturingLogger();
  const { snapshots, now } = nightService(db, night, fx, log);
  const def = createSnapshotsBackfillJob({ snapshots, now });
  await def.handler(makeJob({}), { ...makeCtx(), logger: log });
  return { warns };
}

async function stateOf(db: Database, portfolioId: string) {
  const rows = await db
    .select()
    .from(schema.portfolioSnapshotState)
    .where(eq(schema.portfolioSnapshotState.portfolioId, portfolioId));
  return rows[0] ?? null;
}

const assetValuesOf = (row: { assetValues: unknown }) => row.assetValues as Record<string, number>;

describe('snapshots.backfill — a run that lost a held currency is never persisted (#1729 guard a)', () => {
  it('refuses a night whose EURUSD 404 is replayed from the negative cache, and the next healthy night heals the boundary day', async () => {
    const db = await makeDb();
    const { pid, usdId } = await seedUsdPortfolio(db);

    // Night −2, healthy: the whole history, USD at its own FX.
    await runNight(db, -2, 'ok');
    const healthy = await allSnapshotRows(db, pid);
    expect(healthy.map((r) => r.date)).toEqual(offsets(-45, -3).map(dayOffset));
    for (const row of healthy) {
      expect(assetValuesOf(row)[usdId]).toBeCloseTo(480, 9);
      expect(Number(row.valueEur)).toBeCloseTo(680, 9);
    }

    // Night −1: the classifier reads the replayed 404 as "this currency has no
    // market". Persisting that run would overwrite its heal window [−36, −2]
    // without the USD position; the guard refuses it instead — the rows are
    // untouched to the byte (computed_at included) and the state did not move.
    const degraded = await runNight(db, -1, 'not_found');
    expect(await allSnapshotRows(db, pid)).toEqual(healthy);
    const stateAfter = await stateOf(db, pid);
    expect(stateAfter?.computedThrough).toBe(dayOffset(-3));
    expect(stateAfter?.dirtyFrom ?? null).toBeNull();

    // The refusal is recorded, structured, and the sweep reports it.
    const guardWarn = degraded.warns.find((w) => w.fields.guard === 'vanished_holding');
    expect(guardWarn?.fields).toMatchObject({
      portfolioId: pid,
      anchorDay: dayOffset(-37),
      vanishedCount: 1,
      vanished: [{ assetId: usdId, day: dayOffset(-36) }],
      healFrom: dayOffset(-36),
    });
    const sweepWarn = degraded.warns.find((w) => w.msg.startsWith('snapshots.backfill'));
    expect(sweepWarn?.fields).toMatchObject({ degraded: 1, firstDegraded: pid });

    // Night 0, healthy, heal window [−35, −1]. Had night −1 persisted, its
    // oldest written day (−36) would now be outside every future window and
    // would stay without the USD position forever — the owner's 08-08/09 hole.
    await runNight(db, 0, 'ok');
    const healed = await allSnapshotRows(db, pid);
    expect(healed.map((r) => r.date)).toEqual(offsets(-45, -1).map(dayOffset));
    const boundary = healed.find((r) => r.date === dayOffset(-36))!;
    expect(assetValuesOf(boundary)[usdId]).toBeCloseTo(480, 9);
    expect(Number(boundary.valueEur)).toBeCloseTo(680, 9);
    for (const row of healed) {
      expect(assetValuesOf(row)[usdId]).toBeCloseTo(480, 9);
    }
    expect((await stateOf(db, pid))?.computedThrough).toBe(dayOffset(-1));
  });

  it('keeps dirty_from through an on-demand refill and a sweep while the 404 is replayed, then rewrites the whole range', async () => {
    const db = await makeDb();
    const { pid, usdId } = await seedUsdPortfolio(db);
    const { log } = capturingLogger();
    const healthyNow = nightService(db, 0, 'ok', log).snapshots;
    await healthyNow.recompute(pid);
    expect(await allSnapshotRows(db, pid)).toHaveLength(45);

    // A backdated 500 EUR deposit on −20 invalidates from its day.
    const [source] = await db
      .insert(schema.portfolioCashSources)
      .values({ portfolioId: pid, name: 'Main', type: 'bank', isMain: true })
      .returning({ id: schema.portfolioCashSources.id });
    await db.insert(schema.portfolioCashMovements).values({
      portfolioId: pid,
      sourceId: source!.id,
      kind: 'deposit',
      amountEur: '500',
      executedAt: new Date(`${dayOffset(-20)}T00:00:00.000Z`),
    });
    await healthyNow.invalidate(pid, dayOffset(-20));
    const kept = await allSnapshotRows(db, pid);
    expect(kept.map((r) => r.date)).toEqual(offsets(-45, -21).map(dayOffset));

    // The on-demand job runs while EURUSD is negative-cached: refused.
    const outage = nightService(db, 0, 'not_found', log).snapshots;
    await createSnapshotsRecomputeJob({ snapshots: outage }).handler(
      makeJob({ portfolioId: pid }) as never,
      makeCtx(),
    );
    expect(await allSnapshotRows(db, pid)).toEqual(kept);
    expect((await stateOf(db, pid))?.dirtyFrom).toBe(dayOffset(-20));

    // The sweep lists it as degraded — not a failure, not converged.
    expect(await outage.recomputeAll({ healFrom: dayOffset(-35) })).toEqual({
      total: 1,
      failures: [],
      degraded: [pid],
    });
    expect((await stateOf(db, pid))?.dirtyFrom).toBe(dayOffset(-20));

    // A read still serves (the engine, minus the unpriceable asset) and still
    // refuses to freeze it.
    const served = await outage.getSeries(pid);
    expect(served.fromSnapshots).toBe(false);
    expect(served.assets.map((a) => a.assetId)).not.toContain(usdId);
    expect(await allSnapshotRows(db, pid)).toEqual(kept);

    // FX recovers: the marker drives a rewrite of the whole range.
    await nightService(db, 0, 'ok', log).snapshots.recompute(pid);
    const rows = await allSnapshotRows(db, pid);
    expect(rows.map((r) => r.date)).toEqual(offsets(-45, -1).map(dayOffset));
    const deposit = rows.find((r) => r.date === dayOffset(-20))!;
    expect(assetValuesOf(deposit)[usdId]).toBeCloseTo(480, 9);
    expect(Number(deposit.valueEur)).toBeCloseTo(680 + 500, 9);
    expect((await stateOf(db, pid))?.dirtyFrom ?? null).toBeNull();
  });

  it('refuses a night whose heal floor is exactly the first buy day of the only USD asset (shape 1: the stored floor row is a reference too)', async () => {
    // USD is first bought on −36 = night −1's heal floor, so night −1's anchor
    // (−37) carries no USD key at all. Only the row stored AT the floor (night
    // −2 wrote it with USD) says the asset was valued there; without it, the
    // replayed 404 would overwrite −36 without USD, and night 0's window starts
    // at −35 — the day would freeze for good.
    const db = await makeDb();
    const { pid, usdId } = await seedUsdPortfolio(db, { usdBoughtOn: -36 });

    await runNight(db, -2, 'ok');
    const healthy = await allSnapshotRows(db, pid);
    expect(
      Object.hasOwn(assetValuesOf(healthy.find((r) => r.date === dayOffset(-37))!), usdId),
    ).toBe(false);
    expect(assetValuesOf(healthy.find((r) => r.date === dayOffset(-36))!)[usdId]).toBeCloseTo(
      480,
      9,
    );

    const degraded = await runNight(db, -1, 'not_found');
    expect(await allSnapshotRows(db, pid)).toEqual(healthy);
    expect(degraded.warns.find((w) => w.fields.guard === 'vanished_holding')?.fields).toMatchObject(
      {
        portfolioId: pid,
        anchorDay: dayOffset(-37),
        floorRowDay: dayOffset(-36),
        vanished: [{ assetId: usdId, day: dayOffset(-36) }],
      },
    );

    await runNight(db, 0, 'ok');
    const healed = await allSnapshotRows(db, pid);
    expect(assetValuesOf(healed.find((r) => r.date === dayOffset(-36))!)[usdId]).toBeCloseTo(
      480,
      9,
    );
  });

  it('persists normally when the dropped asset was fully sold before every day it is missing from', async () => {
    // Same replayed 404, but the USD position was closed on −40: from then on
    // it contributes 0 with or without its key, so the run loses nothing and
    // must not be refused (a guard that ignored holdings would refuse it).
    const db = await makeDb();
    const { pid, usdId } = await seedUsdPortfolio(db, { sellUsdOn: -40 });

    await runNight(db, -2, 'ok');
    const healthy = await allSnapshotRows(db, pid);
    expect(healthy.map((r) => r.date)).toEqual(offsets(-45, -3).map(dayOffset));
    const anchor = healthy.find((r) => r.date === dayOffset(-37))!;
    expect(assetValuesOf(anchor)[usdId]).toBe(0);

    const night = await runNight(db, -1, 'not_found');
    expect(night.warns.filter((w) => w.fields.guard === 'vanished_holding')).toEqual([]);
    expect(night.warns.filter((w) => w.msg.startsWith('snapshots.backfill'))).toEqual([]);
    expect((await stateOf(db, pid))?.computedThrough).toBe(dayOffset(-2));

    const rows = await allSnapshotRows(db, pid);
    expect(rows.map((r) => r.date)).toEqual(offsets(-45, -2).map(dayOffset));
    const before = new Map(healthy.map((r) => [r.date, Number(r.valueEur)]));
    for (const row of rows) {
      if (row.date < dayOffset(-36)) {
        // Outside night −1's window: untouched, still keyed.
        expect(Object.hasOwn(assetValuesOf(row), usdId)).toBe(true);
        continue;
      }
      // Rewritten without the (flat) USD key, at the identical value.
      expect(Object.hasOwn(assetValuesOf(row), usdId)).toBe(false);
      expect(Number(row.valueEur)).toBeCloseTo(before.get(row.date) ?? 200, 9);
      expect(Number(row.valueEur)).toBeCloseTo(200, 9);
    }
  });
});
