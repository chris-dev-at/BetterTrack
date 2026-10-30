import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import type { Job } from 'bullmq';
import { and, asc, eq, like } from 'drizzle-orm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { describe, expect, it } from 'vitest';

import type { Database } from '../../data/db';
import * as schema from '../../data/schema';
import { createAuditRepository } from '../../data/repositories/auditRepository';
import { createCashMovementRepository } from '../../data/repositories/cashMovementRepository';
import { createPortfolioRepository } from '../../data/repositories/portfolioRepository';
import { createPortfolioSnapshotRepository } from '../../data/repositories/portfolioSnapshotRepository';
import { createTransactionRepository } from '../../data/repositories/transactionRepository';
import type { Logger } from '../../logger';
import { AssetNotFoundError } from '../../providers';
import { createAuditService } from '../../services/audit/auditService';
import { createCurrencyService } from '../../services/currency/currencyService';
import { createMarketDataFxSource } from '../../services/currency/marketDataFxSource';
import {
  checkFxHoleRepairGate,
  earliestFxHole,
  FX_HOLE_REPAIR_RUN_ID,
} from '../../services/portfolio/fxHoleRepair';
import {
  createPortfolioSnapshotService,
  findVanishedHoldings,
  SNAPSHOT_PERSIST_GUARD_VERSION,
  type PortfolioSnapshotService,
} from '../../services/portfolio/portfolioSnapshots';
import { createStubMarketData } from '../../testing/marketDataStubs';
import { createDeadLetter } from '../deadLetter';
import {
  createSnapshotsBackfillJob,
  createSnapshotsFxHoleRepairJob,
  enqueueFxHoleRepair,
  type SnapshotFxHoleRepairJobDeps,
} from '../definitions';
import { QUEUE_NAMES, type JobContext } from '../types';

/**
 * Issue #1729 — the one-off repair of the FX-probe history holes. A pre-fix
 * build persisted a run that had dropped every USD asset, the nightly heal
 * window moved past its oldest day, and that day stayed without the USD
 * position for good. These tests seed exactly that frozen state on PGlite and
 * run the real job handler over the real snapshot service and audit log.
 */

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle',
);

async function makeDb(): Promise<Database> {
  const client = new PGlite({ extensions: { pg_trgm } });
  const db = drizzlePglite(client, { schema }) as unknown as Database;
  await migratePglite(db as never, { migrationsFolder });
  return db;
}

/** A logger that keeps every line, so the structured log lines are asserted. */
function capturingLogger() {
  const lines: Array<{ level: string; fields: Record<string, unknown>; msg: string }> = [];
  const at =
    (level: string) =>
    (obj: unknown, msg?: string): void => {
      lines.push({ level, fields: obj as Record<string, unknown>, msg: msg ?? '' });
    };
  const log = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  } as unknown as Logger;
  return { log, lines };
}

function makeCtx(log: Logger): JobContext {
  const redis = new RedisMock() as unknown as Redis;
  return {
    events: {
      publish: async () => {},
      subscribe: async () => async () => {},
      close: async () => {},
    },
    deadLetter: createDeadLetter(redis),
    redis,
    logger: log,
    isFeatureEnabledGlobally: async () => true,
  };
}

function makeJob(attemptsMade = 0): Job<Record<string, never>> {
  return {
    id: FX_HOLE_REPAIR_RUN_ID,
    name: QUEUE_NAMES.snapshotsRepairFxHoles,
    data: {},
    attemptsMade,
    opts: { attempts: 3 },
    timestamp: Date.now(),
  } as unknown as Job<Record<string, never>>;
}

/** ISO day `offset` days before today (UTC). */
function dayOffset(offset: number): string {
  const ms = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  return new Date(ms + offset * 86_400_000).toISOString().slice(0, 10);
}

/** Every day the stored closes and the FX series cover: −50 … today. */
const FX_WINDOW = Array.from({ length: 51 }, (_, i) => -50 + i);

let userSeq = 0;
async function seedUser(db: Database): Promise<string> {
  userSeq += 1;
  const rows = await db
    .insert(schema.users)
    .values({ email: `u${userSeq}@example.com`, username: `u${userSeq}`, passwordHash: 'x' })
    .returning({ id: schema.users.id });
  return rows[0]!.id;
}

/** The two assets every portfolio here holds, priced from stored closes only. */
async function seedAssets(db: Database) {
  const [eur] = await db
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
  const [usd] = await db
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
  const eurId = eur!.id;
  const usdId = usd!.id;
  await db
    .insert(schema.priceHistory)
    .values([
      ...FX_WINDOW.map((d) => ({ assetId: eurId, date: dayOffset(d), close: '100' })),
      ...FX_WINDOW.map((d) => ({ assetId: usdId, date: dayOffset(d), close: '200' })),
    ]);
  return { eurId, usdId };
}

/**
 * One portfolio holding 2 × 100 EUR and 3 × 200 USD (at EURUSD 1.25: 480 EUR),
 * both bought 45 days back — far outside the 35-day heal window.
 */
async function seedPortfolio(
  db: Database,
  assets: { eurId: string; usdId: string },
  userId: string,
  name = 'Main',
) {
  const [row] = await db
    .insert(schema.portfolios)
    .values({ userId, name })
    .returning({ id: schema.portfolios.id });
  const pid = row!.id;
  const at = new Date(`${dayOffset(-45)}T00:00:00.000Z`);
  const buy = (assetId: string, quantity: string, price: string) => ({
    portfolioId: pid,
    assetId,
    side: 'buy' as const,
    quantity,
    price,
    fee: '0',
    executedAt: at,
  });
  await db
    .insert(schema.transactions)
    .values([buy(assets.eurId, '2', '100'), buy(assets.usdId, '3', '200')]);
  return pid;
}

type FxMode = 'ok' | 'not_found' | 'down';

/**
 * The worker's snapshot service at 01:30 UTC today with a fresh FX source.
 * `not_found` replays a negative-cached 404 (`AssetNotFoundError(…, true)`, the
 * #2087 shape the classifier calls `unconvertible` — refused by the
 * vanished-holding guard); `down` is a plain outage (`unavailable` — refused
 * by the degraded-run refusal).
 */
function snapshotService(db: Database, fx: FxMode, log: Logger): PortfolioSnapshotService {
  const nowMs = Date.parse(`${dayOffset(0)}T01:30:00.000Z`);
  const now = () => nowMs;
  const marketData = createStubMarketData({
    history: (ref) => {
      if (ref.providerRef !== 'EURUSD=X') throw new Error(`${ref.providerRef}: unreachable`);
      if (fx === 'not_found') {
        throw new AssetNotFoundError('EURUSD=X: no data found, symbol may be delisted', true);
      }
      if (fx === 'down') throw new Error('EURUSD=X: upstream timeout');
      return {
        value: FX_WINDOW.map((d) => ({ time: `${dayOffset(d)}T00:00:00.000Z`, close: 1.25 })),
        stale: false,
        asOf: nowMs,
      };
    },
  });
  return createPortfolioSnapshotService({
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
}

async function rowsOf(db: Database, portfolioId: string) {
  return db
    .select()
    .from(schema.portfolioDailySnapshots)
    .where(eq(schema.portfolioDailySnapshots.portfolioId, portfolioId))
    .orderBy(asc(schema.portfolioDailySnapshots.date));
}

async function stateOf(db: Database, portfolioId: string) {
  const rows = await db
    .select()
    .from(schema.portfolioSnapshotState)
    .where(eq(schema.portfolioSnapshotState.portfolioId, portfolioId));
  return rows[0] ?? null;
}

const usdOf = (row: { assetValues: unknown }, usdId: string) =>
  (row.assetValues as Record<string, number>)[usdId];

/**
 * Freeze the pre-fix hole: the stored rows of `days` as a degraded run wrote
 * them — the USD position missing from value, cost basis and `asset_values`.
 */
async function freezeHole(
  db: Database,
  portfolioId: string,
  assets: { eurId: string },
  days: number[],
) {
  for (const d of days) {
    await db
      .update(schema.portfolioDailySnapshots)
      .set({
        valueEur: '200',
        costBasisEur: '200',
        plEur: '0',
        assetValues: { [assets.eurId]: 200 },
      })
      .where(
        and(
          eq(schema.portfolioDailySnapshots.portfolioId, portfolioId),
          eq(schema.portfolioDailySnapshots.date, dayOffset(d)),
        ),
      );
  }
}

async function repairAudit(db: Database) {
  return db
    .select()
    .from(schema.auditLog)
    .where(like(schema.auditLog.action, 'snapshots.fx_hole_repair_%'))
    .orderBy(asc(schema.auditLog.id));
}

function repairDeps(
  db: Database,
  snapshots: SnapshotFxHoleRepairJobDeps['snapshots'],
  extra: Partial<SnapshotFxHoleRepairJobDeps> = {},
): SnapshotFxHoleRepairJobDeps {
  return {
    snapshotRepo: createPortfolioSnapshotRepository(db),
    transactionRepo: createTransactionRepository(db),
    snapshots,
    audit: createAuditService(createAuditRepository(db)),
    ...extra,
  };
}

/** Seed one holed portfolio (hole on −40/−39) plus one clean portfolio. */
async function seedHoledEstate(db: Database) {
  const { log } = capturingLogger();
  const assets = await seedAssets(db);
  const owner = await seedUser(db);
  const holed = await seedPortfolio(db, assets, owner, 'Holed');
  const clean = await seedPortfolio(db, assets, await seedUser(db), 'Clean');
  const healthy = snapshotService(db, 'ok', log);
  await healthy.recompute(holed);
  await healthy.recompute(clean);
  await freezeHole(db, holed, assets, [-40, -39]);
  return { assets, holed, clean };
}

describe('earliestFxHole', () => {
  type Row = { date: string; assetValues: Record<string, number> };
  const buy = (assetId: string, day: string, quantity = 1) => ({
    assetId,
    side: 'buy' as const,
    quantity,
    executedAt: new Date(`${day}T00:00:00.000Z`),
  });
  const sell = (assetId: string, day: string, quantity = 1) => ({
    ...buy(assetId, day, quantity),
    side: 'sell' as const,
  });

  it('finds the earliest day a held, previously keyed asset is missing', () => {
    const rows: Row[] = [
      { date: '2026-08-06', assetValues: { a: 1, b: 2 } },
      { date: '2026-08-07', assetValues: { a: 1, b: 2 } },
      { date: '2026-08-08', assetValues: { a: 1 } },
      { date: '2026-08-09', assetValues: { a: 1 } },
      { date: '2026-08-10', assetValues: { a: 1, b: 2 } },
    ];
    expect(earliestFxHole(rows, [buy('a', '2026-08-01'), buy('b', '2026-08-01')])).toEqual({
      day: '2026-08-08',
      vanished: [{ assetId: 'b', day: '2026-08-08' }],
    });
  });

  it('is not fooled by a position that was sold before the missing day', () => {
    const rows: Row[] = [
      { date: '2026-08-06', assetValues: { a: 1, b: 2 } },
      { date: '2026-08-08', assetValues: { a: 1 } },
    ];
    const txns = [buy('a', '2026-08-01'), buy('b', '2026-08-01'), sell('b', '2026-08-07')];
    expect(earliestFxHole(rows, txns)).toBeNull();
  });

  it('anchors a later-bought asset at the first row that carries it', () => {
    const rows: Row[] = [
      { date: '2026-08-01', assetValues: { a: 1 } },
      { date: '2026-08-02', assetValues: { a: 1, b: 3 } },
      { date: '2026-08-03', assetValues: { a: 1, b: 3 } },
      { date: '2026-08-04', assetValues: { b: 3 } },
    ];
    expect(earliestFxHole(rows, [buy('a', '2026-07-30'), buy('b', '2026-08-02')])).toEqual({
      day: '2026-08-04',
      vanished: [{ assetId: 'a', day: '2026-08-04' }],
    });
  });

  it('finds a hole that no EARLIER row can anchor: the asset is only keyed on later rows (shapes 1 and 2)', () => {
    // A first computation / backdated buy in a currency the portfolio held
    // nothing else of, persisted while the probe failed, then healed only
    // inside the nightly window: the older days never carried the asset. The
    // persist guard's anchor cannot see this; the repair must.
    const rows: Row[] = [
      { date: '2026-08-01', assetValues: { a: 1 } },
      { date: '2026-08-02', assetValues: { a: 1 } },
      { date: '2026-08-03', assetValues: { a: 1, b: 2 } },
    ];
    expect(earliestFxHole(rows, [buy('a', '2026-07-30'), buy('b', '2026-07-30')])).toEqual({
      day: '2026-08-01',
      vanished: [{ assetId: 'b', day: '2026-08-01' }],
    });
    // The same rows with b bought only on 08-03 are no hole at all.
    expect(earliestFxHole(rows, [buy('a', '2026-07-30'), buy('b', '2026-08-03')])).toBeNull();
  });

  it('needs evidence that an asset is usable: never keyed anywhere is no hole unless known usable', () => {
    const rows: Row[] = [
      { date: '2026-08-01', assetValues: { a: 1 } },
      { date: '2026-08-02', assetValues: { a: 1 } },
    ];
    const txns = [buy('a', '2026-07-30'), buy('z', '2026-07-30')];
    // A currency with no market is legitimately absent from every row.
    expect(earliestFxHole(rows, txns)).toBeNull();
    // The repair's re-scan passes the assets it found missing as known usable,
    // so a recompute that dropped them from EVERY row is not read as healed.
    expect(earliestFxHole(rows, txns, ['z'])).toEqual({
      day: '2026-08-01',
      vanished: [{ assetId: 'z', day: '2026-08-01' }],
    });
  });

  it('takes the minimum across assets, whatever order the rows arrive in', () => {
    const rows: Row[] = [
      { date: '2026-08-05', assetValues: { a: 1 } },
      { date: '2026-08-01', assetValues: { a: 1, b: 2 } },
      { date: '2026-08-03', assetValues: { b: 2 } },
    ];
    expect(earliestFxHole(rows, [buy('a', '2026-07-30'), buy('b', '2026-07-30')])).toEqual({
      day: '2026-08-03',
      vanished: [
        { assetId: 'a', day: '2026-08-03' },
        { assetId: 'b', day: '2026-08-05' },
      ],
    });
  });
});

describe('checkFxHoleRepairGate', () => {
  it('passes on this build: guard version 2 and the real guard', () => {
    expect(SNAPSHOT_PERSIST_GUARD_VERSION).toBe(2);
    expect(checkFxHoleRepairGate()).toEqual({ ok: true });
  });

  it('refuses a build whose declared guard version is below the minimum', () => {
    for (const guardVersion of [0, undefined, '1', Number.NaN]) {
      expect(checkFxHoleRepairGate({ guardVersion, findVanished: findVanishedHoldings })).toEqual({
        ok: false,
        reason: 'fix_absent',
        detail: 'guard_version',
      });
    }
  });

  it('refuses a guard that is missing, stubbed out, inverted or throwing', () => {
    const stubs: unknown[] = [
      undefined,
      () => [],
      () => [{ assetId: 'probe', day: '2000-01-03' }],
      () => {
        throw new Error('boom');
      },
    ];
    for (const findVanished of stubs) {
      expect(checkFxHoleRepairGate({ guardVersion: 1, findVanished })).toEqual({
        ok: false,
        reason: 'fix_absent',
        detail: 'guard_self_check',
      });
    }
  });
});

describe('snapshots.repairFxHoles', () => {
  it('enqueues under the deterministic run id, so every later boot coalesces into one job', async () => {
    const calls: unknown[][] = [];
    await enqueueFxHoleRepair({
      enqueue: (async (...args: unknown[]) => {
        calls.push(args);
        return {};
      }) as never,
    });
    expect(calls).toEqual([['snapshots.repairFxHoles', {}, { jobId: 'fx-hole-repair-v1' }]]);
    expect(FX_HOLE_REPAIR_RUN_ID).not.toContain(':');
  });

  it('records the pre-repair counts, marks the portfolio dirty from its earliest hole, and the guarded recompute rewrites it', async () => {
    const db = await makeDb();
    const { assets, holed, clean } = await seedHoledEstate(db);
    const cleanBefore = await rowsOf(db, clean);
    expect(
      usdOf((await rowsOf(db, holed)).find((r) => r.date === dayOffset(-40))!, assets.usdId),
    ).toBeUndefined();

    // Observe the durable state at the moment the recompute starts: the marker
    // must already be down at the earliest hole, and the rows from it gone.
    const { log, lines } = capturingLogger();
    const real = snapshotService(db, 'ok', log);
    const atRecompute: Array<{ dirtyFrom: string | null; lastRow: string | undefined }> = [];
    const snapshots: SnapshotFxHoleRepairJobDeps['snapshots'] = {
      invalidate: real.invalidate,
      recompute: async (portfolioId, opts) => {
        const rows = await rowsOf(db, portfolioId);
        atRecompute.push({
          dirtyFrom: (await stateOf(db, portfolioId))?.dirtyFrom ?? null,
          lastRow: rows.at(-1)?.date,
        });
        await real.recompute(portfolioId, opts);
      },
    };

    const summary = await createSnapshotsFxHoleRepairJob(repairDeps(db, snapshots)).handler(
      makeJob(),
      makeCtx(log),
    );

    expect(atRecompute).toEqual([{ dirtyFrom: dayOffset(-40), lastRow: dayOffset(-41) }]);

    // Every row is back, the frozen days carry the USD position again, and the
    // state is clean.
    const rows = await rowsOf(db, holed);
    expect(rows.map((r) => r.date)).toEqual(
      Array.from({ length: 45 }, (_, i) => dayOffset(-45 + i)),
    );
    for (const row of rows) {
      expect(usdOf(row, assets.usdId)).toBeCloseTo(480, 9);
      expect(Number(row.valueEur)).toBeCloseTo(680, 9);
    }
    const state = await stateOf(db, holed);
    expect(state?.dirtyFrom ?? null).toBeNull();
    expect(state?.computedThrough).toBe(dayOffset(-1));
    // The clean portfolio was read, never written.
    expect(await rowsOf(db, clean)).toEqual(cleanBefore);

    // Owner-visible: the PRE-repair counts first, then the outcome.
    const audit = await repairAudit(db);
    expect(audit.map((r) => r.action)).toEqual([
      'snapshots.fx_hole_repair_enumerated',
      'snapshots.fx_hole_repair_completed',
    ]);
    expect(audit.every((r) => r.actorId === null && r.targetId === null)).toBe(true);
    expect(audit[0]!.meta).toMatchObject({
      runId: 'fx-hole-repair-v1',
      attempt: 1,
      portfoliosScanned: 2,
      portfoliosWithHoles: 1,
      usersAffected: 1,
      earliestHoleDay: dayOffset(-40),
      skippedVaulted: 0,
      skippedParanoid: 0,
      scanFailed: 0,
    });
    expect(audit[1]!.meta).toMatchObject({
      runId: 'fx-hole-repair-v1',
      portfoliosScanned: 2,
      portfoliosWithHoles: 1,
      usersAffected: 1,
      earliestHoleDay: dayOffset(-40),
      repaired: 1,
      refused: 0,
      failed: 0,
      unmarked: 0,
      skippedVaulted: 0,
    });
    expect(typeof (audit[1]!.meta as { durationMs: unknown }).durationMs).toBe('number');
    // No identifier reaches the 400-day audit trail.
    expect(JSON.stringify(audit.map((r) => r.meta))).not.toContain(holed);

    // The structured log lines, and a numbers-only job summary.
    expect(lines.find((l) => l.msg === 'repair.enumerated')?.fields).toMatchObject({
      event: 'repair.enumerated',
      portfoliosWithHoles: 1,
    });
    expect(lines.find((l) => l.msg === 'repair.completed')?.fields).toMatchObject({
      event: 'repair.completed',
      repaired: 1,
    });
    expect(summary).toMatchObject({
      portfoliosScanned: 2,
      portfoliosWithHoles: 1,
      usersAffected: 1,
      repaired: 1,
      refused: 0,
      failed: 0,
      skippedVaulted: 0,
    });
    expect(Object.values(summary ?? {}).every((v) => typeof v === 'number')).toBe(true);

    // Idempotent: a second run finds nothing, records zeros and rewrites nothing.
    const after = await rowsOf(db, holed);
    await createSnapshotsFxHoleRepairJob(repairDeps(db, real)).handler(makeJob(), makeCtx(log));
    expect(await rowsOf(db, holed)).toEqual(after);
    const second = (await repairAudit(db)).slice(2);
    expect(second.map((r) => r.action)).toEqual([
      'snapshots.fx_hole_repair_enumerated',
      'snapshots.fx_hole_repair_completed',
    ]);
    expect(second[0]!.meta).toMatchObject({
      portfoliosScanned: 2,
      portfoliosWithHoles: 0,
      usersAffected: 0,
      earliestHoleDay: null,
    });
    expect(second[1]!.meta).toMatchObject({ repaired: 0, refused: 0, failed: 0 });
  });

  it('repairs a hole with no earlier row carrying the asset (shape 2): every day older than the heal window', async () => {
    const db = await makeDb();
    const { assets, holed } = await seedHoledEstate(db);
    // Shape 2 on top: the USD position missing from EVERY day older than the
    // 35-day window, so no stored row before the hole carries it.
    await freezeHole(
      db,
      holed,
      assets,
      Array.from({ length: 10 }, (_, i) => -45 + i),
    );
    const { log } = capturingLogger();

    await createSnapshotsFxHoleRepairJob(repairDeps(db, snapshotService(db, 'ok', log))).handler(
      makeJob(),
      makeCtx(log),
    );

    const [enumerated, completed] = await repairAudit(db);
    expect(enumerated?.meta).toMatchObject({
      portfoliosWithHoles: 1,
      earliestHoleDay: dayOffset(-45),
    });
    expect(completed?.meta).toMatchObject({ repaired: 1, refused: 0, failed: 0 });
    const rows = await rowsOf(db, holed);
    expect(rows).toHaveLength(45);
    for (const row of rows) expect(usdOf(row, assets.usdId)).toBeCloseTo(480, 9);
    expect((await stateOf(db, holed))?.dirtyFrom ?? null).toBeNull();
  });

  it('never counts a day the position was flat as a hole, but does count the re-opened position', async () => {
    // Both portfolios sell all their USD on −42 (flat −42 … −39) and buy it back
    // on −38. A healthy engine keys USD at 0 on the flat days; a frozen save
    // dropped the key there too. Only A also lost it on a HELD day (−37).
    const db = await makeDb();
    const { log } = capturingLogger();
    const assets = await seedAssets(db);
    const flatThenReopened = async (name: string) => {
      const pid = await seedPortfolio(db, assets, await seedUser(db), name);
      const trade = (side: 'buy' | 'sell', day: number) => ({
        portfolioId: pid,
        assetId: assets.usdId,
        side,
        quantity: '3',
        price: '200',
        fee: '0',
        executedAt: new Date(`${dayOffset(day)}T00:00:00.000Z`),
      });
      await db.insert(schema.transactions).values([trade('sell', -42), trade('buy', -38)]);
      return pid;
    };
    const a = await flatThenReopened('A');
    const b = await flatThenReopened('B');
    const healthy = snapshotService(db, 'ok', log);
    await healthy.recompute(a);
    await healthy.recompute(b);
    const flatDays = [-42, -41, -40, -39].map(dayOffset);
    for (const row of await rowsOf(db, b)) {
      expect(usdOf(row, assets.usdId)).toBeCloseTo(flatDays.includes(row.date) ? 0 : 480, 9);
    }
    await freezeHole(db, a, assets, [-40, -39, -37]);
    await freezeHole(db, b, assets, [-40, -39]);
    const bBefore = await rowsOf(db, b);

    await createSnapshotsFxHoleRepairJob(repairDeps(db, healthy)).handler(makeJob(), makeCtx(log));

    const [enumerated, completed] = await repairAudit(db);
    expect(enumerated?.meta).toMatchObject({
      portfoliosScanned: 2,
      portfoliosWithHoles: 1,
      usersAffected: 1,
      earliestHoleDay: dayOffset(-37),
    });
    expect(completed?.meta).toMatchObject({ repaired: 1, refused: 0, failed: 0, unmarked: 0 });
    // B was never written.
    expect(await rowsOf(db, b)).toEqual(bBefore);
    // A: rewritten from −37 only. Every held day carries USD again; the frozen
    // flat days were left alone, and the re-scan did not take them for a hole.
    const rows = await rowsOf(db, a);
    expect(rows).toHaveLength(45);
    for (const row of rows) {
      const usd = usdOf(row, assets.usdId);
      if (row.date === dayOffset(-40) || row.date === dayOffset(-39)) expect(usd).toBeUndefined();
      else expect(usd).toBeCloseTo(flatDays.includes(row.date) ? 0 : 480, 9);
    }
    expect((await stateOf(db, a))?.dirtyFrom ?? null).toBeNull();
  });

  it('does not count a shape-2 recompute that persisted WITHOUT the asset as repaired: it re-marks it dirty for the nightly', async () => {
    // With no earlier row carrying USD, a replayed 404 is invisible to the
    // persist guard, so the recompute persists every day without USD. The
    // verification must catch that, put the marker back, and say `refused`.
    const db = await makeDb();
    const { assets, holed } = await seedHoledEstate(db);
    await freezeHole(
      db,
      holed,
      assets,
      Array.from({ length: 10 }, (_, i) => -45 + i),
    );
    const { log, lines } = capturingLogger();

    await createSnapshotsFxHoleRepairJob(
      repairDeps(db, snapshotService(db, 'not_found', log)),
    ).handler(makeJob(), makeCtx(log));

    const completed = (await repairAudit(db)).find(
      (r) => r.action === 'snapshots.fx_hole_repair_completed',
    );
    expect(completed?.meta).toMatchObject({ repaired: 0, refused: 1, failed: 0, unmarked: 0 });
    expect(lines.some((l) => l.fields.event === 'repair.persisted_without_asset')).toBe(true);
    expect((await stateOf(db, holed))?.dirtyFrom).toBe(dayOffset(-45));
    expect(await rowsOf(db, holed)).toEqual([]);

    // The next healthy nightly rewrites the whole history with USD.
    await createSnapshotsBackfillJob({
      snapshots: snapshotService(db, 'ok', log),
      now: () => Date.parse(`${dayOffset(0)}T01:30:00.000Z`),
    }).handler(makeJob() as never, makeCtx(log));
    const healed = await rowsOf(db, holed);
    expect(healed).toHaveLength(45);
    for (const row of healed) expect(usdOf(row, assets.usdId)).toBeCloseTo(480, 9);
  });

  it.each<[FxMode, string]>([
    ['not_found', 'vanished-holding guard'],
    ['down', 'degraded-run refusal'],
  ])(
    'counts a recompute refused by the %s FX (%s) as refused, keeps the marker, and the next healthy nightly heals it',
    async (fx) => {
      const db = await makeDb();
      const { assets, holed } = await seedHoledEstate(db);
      const { log } = capturingLogger();

      await createSnapshotsFxHoleRepairJob(repairDeps(db, snapshotService(db, fx, log))).handler(
        makeJob(),
        makeCtx(log),
      );

      const completed = (await repairAudit(db)).find(
        (r) => r.action === 'snapshots.fx_hole_repair_completed',
      );
      expect(completed?.meta).toMatchObject({
        portfoliosWithHoles: 1,
        repaired: 0,
        refused: 1,
        failed: 0,
        unmarked: 0,
      });
      // The refusal wrote nothing: the marker stays at the earliest hole and
      // the rows end the day before it.
      expect((await stateOf(db, holed))?.dirtyFrom).toBe(dayOffset(-40));
      expect((await rowsOf(db, holed)).at(-1)?.date).toBe(dayOffset(-41));

      // The nightly roll, once FX is healthy, rewrites from the marker.
      const nightly = createSnapshotsBackfillJob({
        snapshots: snapshotService(db, 'ok', log),
        now: () => Date.parse(`${dayOffset(0)}T01:30:00.000Z`),
      });
      await nightly.handler(makeJob() as never, makeCtx(log));
      const healed = await rowsOf(db, holed);
      expect(healed).toHaveLength(45);
      for (const row of healed) expect(usdOf(row, assets.usdId)).toBeCloseTo(480, 9);
      expect((await stateOf(db, holed))?.dirtyFrom ?? null).toBeNull();
    },
  );

  it('never reads a vaulted portfolio or a paranoid owner’s portfolio, and counts both', async () => {
    const db = await makeDb();
    const { assets, holed } = await seedHoledEstate(db);

    // A vaulted stub that still has (stale, holed) rows, and a paranoid
    // owner's holed portfolio: both server-invisible.
    const vaultOwner = await seedUser(db);
    await db.insert(schema.vaults).values({
      id: '019c8700-0000-7000-8000-000000000001',
      userId: vaultOwner,
      name: 'TEST VECTOR repair vault',
      headerDocId: '019c8700-0000-7000-8000-000000000002',
      commonDocId: '019c8700-0000-7000-8000-000000000003',
      media: ['server'],
      retirementProofPublicKey: 'TEST VECTOR fx hole repair verifier',
      keyFingerprint: 'TEST-VECTOR-FX-HOLE-0001',
    });
    const vaulted = await seedPortfolio(db, assets, vaultOwner, 'Vaulted');
    const paranoid = await seedPortfolio(db, assets, await seedUser(db), 'Paranoid');
    const { log } = capturingLogger();
    const healthy = snapshotService(db, 'ok', log);
    await healthy.recompute(vaulted);
    await healthy.recompute(paranoid);
    await freezeHole(db, vaulted, assets, [-40]);
    await freezeHole(db, paranoid, assets, [-40]);
    await db
      .update(schema.portfolios)
      .set({ vaultId: '019c8700-0000-7000-8000-000000000001', vaultAlias: 'Locked' })
      .where(eq(schema.portfolios.id, vaulted));
    const vaultedBefore = await rowsOf(db, vaulted);
    const paranoidBefore = await rowsOf(db, paranoid);
    const paranoidStateBefore = await stateOf(db, paranoid);

    const read: string[] = [];
    const snapshotRepo = createPortfolioSnapshotRepository(db);
    await createSnapshotsFxHoleRepairJob(
      repairDeps(db, healthy, {
        snapshotRepo: {
          ...snapshotRepo,
          listForPortfolio: async (portfolioId: string) => {
            read.push(portfolioId);
            return snapshotRepo.listForPortfolio(portfolioId);
          },
        },
        isParanoidPortfolio: async (portfolioId) => portfolioId === paranoid,
      }),
    ).handler(makeJob(), makeCtx(log));

    expect(read).not.toContain(vaulted);
    expect(read).not.toContain(paranoid);
    expect(await rowsOf(db, vaulted)).toEqual(vaultedBefore);
    expect(await rowsOf(db, paranoid)).toEqual(paranoidBefore);
    expect(await stateOf(db, paranoid)).toEqual(paranoidStateBefore);
    // The visible holed portfolio is still repaired.
    expect((await rowsOf(db, holed)).every((r) => usdOf(r, assets.usdId) !== undefined)).toBe(true);

    const [enumerated, completed] = await repairAudit(db);
    expect(enumerated?.meta).toMatchObject({
      portfoliosScanned: 2,
      portfoliosWithHoles: 1,
      skippedVaulted: 1,
      skippedParanoid: 1,
    });
    expect(completed?.meta).toMatchObject({ repaired: 1, skippedVaulted: 1, skippedParanoid: 1 });
  });

  it('does nothing but record why when the fix is absent from the running build', async () => {
    const db = await makeDb();
    const { holed } = await seedHoledEstate(db);
    const rowsBefore = await rowsOf(db, holed);
    const stateBefore = await stateOf(db, holed);
    const { log, lines } = capturingLogger();
    let touched = 0;
    const snapshots: SnapshotFxHoleRepairJobDeps['snapshots'] = {
      invalidate: async () => {
        touched += 1;
      },
      recompute: async () => {
        touched += 1;
      },
    };

    const summary = await createSnapshotsFxHoleRepairJob(
      repairDeps(db, snapshots, {
        gate: () => checkFxHoleRepairGate({ guardVersion: 0, findVanished: findVanishedHoldings }),
      }),
    ).handler(makeJob(), makeCtx(log));

    expect(summary).toEqual({ skipped: 1 });
    expect(touched).toBe(0);
    expect(await rowsOf(db, holed)).toEqual(rowsBefore);
    expect(await stateOf(db, holed)).toEqual(stateBefore);
    const audit = await repairAudit(db);
    expect(audit.map((r) => r.action)).toEqual(['snapshots.fx_hole_repair_skipped']);
    expect(audit[0]!.meta).toMatchObject({ reason: 'fix_absent', detail: 'guard_version' });
    expect(lines.find((l) => l.msg === 'repair.skipped reason=fix_absent')?.fields).toMatchObject({
      event: 'repair.skipped',
      reason: 'fix_absent',
    });
  });

  it('throws for a BullMQ retry when a hole could not be marked, after recording the counts', async () => {
    const db = await makeDb();
    const { holed } = await seedHoledEstate(db);
    const rowsBefore = await rowsOf(db, holed);
    const { log } = capturingLogger();
    const snapshots: SnapshotFxHoleRepairJobDeps['snapshots'] = {
      invalidate: async () => {
        throw new Error('connection reset');
      },
      recompute: async () => {},
    };

    await expect(
      createSnapshotsFxHoleRepairJob(repairDeps(db, snapshots)).handler(makeJob(), makeCtx(log)),
    ).rejects.toThrow(/0 unreadable and 1 unmarked/);
    // Nothing was written, so the retry finds the same hole.
    expect(await rowsOf(db, holed)).toEqual(rowsBefore);
    const completed = (await repairAudit(db)).find(
      (r) => r.action === 'snapshots.fx_hole_repair_completed',
    );
    expect(completed?.meta).toMatchObject({ repaired: 0, unmarked: 1 });
  });
});
