import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AssetRef, DividendEvents } from '@bettertrack/contracts';

import type { Database } from '../../data/db';
import type { HeldAssetHolderRow } from '../../data/repositories/marketIntelRepository';
import {
  createNotificationRepository,
  type TypeRouting,
} from '../../data/repositories/notificationRepository';
import { notifications } from '../../data/schema';
import type { Logger } from '../../logger';
import {
  createNotificationCenter,
  type NotificationCenter,
} from '../../services/notifications/notificationCenter';
import type { DispatchableEvent } from '../../services/notifications/notificationDispatcher';
import { createStubMarketData, cachedIntel } from '../../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../../testing/createTestApp';
import { createDeadLetter } from '../deadLetter';
import {
  DIVIDEND_EVENT_HORIZON_DAYS,
  DIVIDEND_PROVIDER_ATTEMPTS_PER_ASSET,
  createDividendEventsScanJob,
  dividendNotifyGate,
  runDividendEventsScan,
  type DividendScanResult,
} from '../definitions/dividendEventsJob';
import type { JobContext } from '../types';

const NOW = Date.parse('2026-07-18T00:00:00.000Z');

let harness: TestHarness;
let db: Database;
let redis: Redis;

beforeEach(async () => {
  harness = await createTestApp();
  db = harness.db;
  redis = new RedisMock() as unknown as Redis;
  // ioredis-mock shares its keyspace across instances — flush so each test's
  // notify-once markers start clean.
  await redis.flushall();
});

afterEach(async () => {
  await harness.ctx.events.close();
});

function dividends(upcoming: DividendEvents['upcoming']): DividendEvents {
  return {
    currency: 'USD',
    history: [],
    upcoming,
    forwardYield: null,
    trailingAmount: null,
    trailingAmountBasis: null,
  };
}

/** A market-data stub serving one asset's upcoming dividends. */
function marketDataWith(upcoming: DividendEvents['upcoming']) {
  return createStubMarketData({ dividends: (_ref: AssetRef) => cachedIntel(dividends(upcoming)) });
}

function holder(userId: string, overrides: Partial<HeldAssetHolderRow> = {}): HeldAssetHolderRow {
  return {
    userId,
    assetId: 'asset-a',
    providerId: 'yahoo',
    providerRef: 'AAA',
    symbol: 'AAA',
    name: 'Asset A',
    currency: 'USD',
    ...overrides,
  };
}

/** Turn the opt-in `dividend.event` type ON in-app for a user. */
async function optIn(userId: string) {
  await createNotificationRepository(db).upsertChannelConfig(userId, 'inapp', {
    'dividend.event': true,
  });
}

async function dividendRows(userId: string) {
  const rows = await db.select().from(notifications).where(eq(notifications.userId, userId));
  return rows.filter((r) => r.type === 'dividend.event' && !r.hidden);
}

/** Every `dividend.event` row, hidden dedupe markers included. */
async function allDividendRows(userId: string) {
  const rows = await db.select().from(notifications).where(eq(notifications.userId, userId));
  return rows.filter((r) => r.type === 'dividend.event');
}

/** Build the scan deps around the harness's real dispatcher. */
function scanDeps(opts: {
  holders: HeldAssetHolderRow[];
  upcoming: DividendEvents['upcoming'];
  enabled?: boolean;
}) {
  const repo = createNotificationRepository(db);
  return {
    repo: {
      listNormalUserIds: async () => [...new Set(opts.holders.map((row) => row.userId))],
      listHeldAssetHoldersForUser: async (userId: string) =>
        opts.holders.filter((row) => row.userId === userId),
    },
    marketData: marketDataWith(opts.upcoming),
    notify: createNotificationCenter({
      enqueue: (event) => harness.ctx.notificationDispatcher.dispatch(event),
    }),
    redis,
    isEnabled: dividendNotifyGate(repo, { telegram: true, discord: true }),
    runIfAllowed: async (_userId: string, action: () => Promise<void>) => {
      await action();
      return true;
    },
    enabled: opts.enabled ?? true,
    now: () => NOW,
  };
}

/** The all-zero scan result — the shape a no-op run returns. */
const NOTHING: DividendScanResult = {
  assetsScanned: 0,
  candidates: 0,
  emitted: 0,
  suppressed: 0,
  failed: 0,
  errored: 0,
  holdersSkipped: 0,
  assetsFailed: 0,
  usersFailed: 0,
  usersDeferred: 0,
  skipped: 0,
  degraded: false,
};

describe('marketIntel.dividendScan (V5-P5)', () => {
  it('fires exactly once per user+asset+ex-date across repeated runs (clock-mocked idempotency)', async () => {
    const user = await harness.seedUser({ email: 'holder@bt.test', username: 'holder' });
    await optIn(user.id);
    const deps = scanDeps({
      holders: [holder(user.id)],
      // Ex-date 3 days out — inside the 7-day horizon.
      upcoming: [
        { exDate: '2026-07-21T00:00:00.000Z', payDate: null, amount: 0.3, currency: 'USD' },
      ],
    });

    const first = await runDividendEventsScan(deps);
    const second = await runDividendEventsScan(deps);

    // The scan's OWN durable marker stops the second emit before it happens —
    // it no longer leans on the dispatcher collapsing a re-emit.
    expect(first.emitted).toBe(1);
    expect(second).toMatchObject({ emitted: 0, suppressed: 1, candidates: 1, degraded: false });
    const rows = await dividendRows(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toContain('AAA');
  });

  it('does not fire for a user who never opted in (default off)', async () => {
    const user = await harness.seedUser({ email: 'optout@bt.test', username: 'optout' });
    // No optIn() — the type is off on every channel.
    const deps = scanDeps({
      holders: [holder(user.id)],
      upcoming: [
        { exDate: '2026-07-21T00:00:00.000Z', payDate: null, amount: 0.3, currency: 'USD' },
      ],
    });

    const result = await runDividendEventsScan(deps);
    expect(result.emitted).toBe(0);
    expect(await dividendRows(user.id)).toHaveLength(0);
  });

  it('does not fire for an ex-date beyond the horizon', async () => {
    const user = await harness.seedUser({ email: 'far@bt.test', username: 'far' });
    await optIn(user.id);
    const deps = scanDeps({
      holders: [holder(user.id)],
      // 30 days out — beyond the 7-day horizon.
      upcoming: [
        { exDate: '2026-08-17T00:00:00.000Z', payDate: null, amount: 0.3, currency: 'USD' },
      ],
    });

    const result = await runDividendEventsScan(deps);
    expect(result.emitted).toBe(0);
    expect(await dividendRows(user.id)).toHaveLength(0);
  });

  it('is a no-op when MARKET_INTEL is disabled', async () => {
    const user = await harness.seedUser({ email: 'gated@bt.test', username: 'gated' });
    await optIn(user.id);
    const deps = scanDeps({
      holders: [holder(user.id)],
      upcoming: [
        { exDate: '2026-07-21T00:00:00.000Z', payDate: null, amount: 0.3, currency: 'USD' },
      ],
      enabled: false,
    });

    const result = await runDividendEventsScan(deps);
    expect(result).toEqual(NOTHING);
    expect(await dividendRows(user.id)).toHaveLength(0);
  });

  it('does not fetch or notify from a paranoid account holding row', async () => {
    const user = await harness.seedUser({ email: 'private@bt.test', username: 'private' });
    const deps = scanDeps({
      holders: [holder(user.id)],
      upcoming: [
        { exDate: '2026-07-21T00:00:00.000Z', payDate: null, amount: 0.3, currency: 'USD' },
      ],
    });

    const result = await runDividendEventsScan({
      ...deps,
      runIfAllowed: async (userId, action) => {
        if (userId === user.id) return false;
        await action();
        return true;
      },
    });
    // Deferred, not "nothing to do": the run is degraded and names the skip.
    expect(result).toEqual({ ...NOTHING, usersDeferred: 1, skipped: 1, degraded: true });
    expect(await dividendRows(user.id)).toHaveLength(0);
  });
});

/**
 * The run's real execution instant. BullMQ stamps `job.timestamp` when it
 * CREATES the delayed job, which for a repeatable schedule is the previous
 * iteration's pickup — one full period (a day) earlier (#1543). A
 * `job.timestamp` clock would set `todayStart` to yesterday (admitting an
 * already-passed ex-date) and cut the horizon a day short.
 */
const JOB_RUN_AT = Date.parse('2026-09-01T00:00:00.000Z');
const JOB_STALE_TIMESTAMP = Date.parse('2026-08-31T00:00:00.000Z');

function makeJob(): Job<Record<string, never>> {
  return {
    id: 'dividend-1',
    name: 'marketIntel.dividendScan',
    data: {},
    timestamp: JOB_STALE_TIMESTAMP,
    processedOn: JOB_RUN_AT,
  } as unknown as Job<Record<string, never>>;
}

/** A notification-center double that records what the scan emitted. */
function recordingCenter(): NotificationCenter & { emitted: DispatchableEvent[] } {
  const emitted: DispatchableEvent[] = [];
  return {
    emitted,
    async emit(event) {
      emitted.push(event);
      return true;
    },
  };
}

function makeJobCtx(logger?: Logger): JobContext {
  return {
    events: harness.ctx.events,
    deadLetter: createDeadLetter(redis),
    redis,
    logger: logger ?? (pino({ level: 'silent' }) as unknown as Logger),
    isFeatureEnabled: async () => true,
  };
}

interface LogLine {
  payload: Record<string, unknown>;
  msg: string;
}

/** A logger double that keeps the completion line the handler wrote. */
function capturingLogger() {
  const info: LogLine[] = [];
  const warn: LogLine[] = [];
  const push = (sink: LogLine[]) => (payload: Record<string, unknown>, msg?: string) => {
    sink.push({ payload, msg: msg ?? '' });
  };
  const noop = () => {};
  const logger = {
    info: push(info),
    warn: push(warn),
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => logger,
  };
  return { logger: logger as unknown as Logger, info, warn };
}

describe('marketIntel.dividendScan — run clock (#1543)', () => {
  it('scans from the execution instant: yesterday is excluded and the horizon is full', async () => {
    const user = await harness.seedUser({ email: 'clock@bt.test', username: 'clock' });
    await optIn(user.id);
    const {
      now: _now,
      notify: _notify,
      redis: _redis,
      ...deps
    } = scanDeps({
      holders: [holder(user.id)],
      upcoming: [
        // Already past on 2026-09-01 — but "today" under the stale clock.
        { exDate: '2026-08-31T00:00:00.000Z', payDate: null, amount: 0.1, currency: 'USD' },
        // The far edge of the 7-day horizon measured from 2026-09-01; the stale
        // clock's horizon would end at 2026-09-07 and drop it.
        { exDate: '2026-09-08T00:00:00.000Z', payDate: null, amount: 0.2, currency: 'USD' },
        // One day past the horizon on either clock.
        { exDate: '2026-09-09T00:00:00.000Z', payDate: null, amount: 0.3, currency: 'USD' },
      ],
    });
    const notify = recordingCenter();

    await createDividendEventsScanJob({ ...deps, notify }).handler(makeJob(), makeJobCtx());

    expect(notify.emitted).toEqual([
      expect.objectContaining({
        type: 'dividend.event',
        userId: user.id,
        exDate: '2026-09-08T00:00:00.000Z',
        // `occurredAt` is stamped from the scan's clock — the direct proof that
        // the effective `now` is the execution instant, not `job.timestamp`.
        occurredAt: '2026-09-01T00:00:00.000Z',
      }),
    ]);
    expect(DIVIDEND_EVENT_HORIZON_DAYS).toBe(7);
  });
});

/**
 * The notify-once guard (#1791). The dispatcher's dedupe marker for an in-app
 * recipient IS the visible inbox row, and that row is hard-deletable by its
 * owner — so leaning on it alone re-notified a holder on EVERY remaining day of
 * the horizon, on every channel. The scan now holds its own durable marker.
 */
describe('marketIntel.dividendScan — notify-once guard (#1791)', () => {
  const EX_DATE = '2026-07-21T00:00:00.000Z';
  const upcoming = [{ exDate: EX_DATE, payDate: null, amount: 0.3, currency: 'USD' }];
  const day = (n: number) => NOW + n * 86_400_000;

  /** Emits into the real dispatcher AND records every emit, so "one
   *  notification across all channels" is asserted at the fan-out's source. */
  function countingCenter(): NotificationCenter & { emits: DispatchableEvent[] } {
    const emits: DispatchableEvent[] = [];
    return {
      emits,
      async emit(event) {
        emits.push(event);
        await harness.ctx.notificationDispatcher.dispatch(event);
        return true;
      },
    };
  }

  it('does not re-notify after the holder deletes the in-app row', async () => {
    const user = await harness.seedUser({ email: 'clears@bt.test', username: 'clears' });
    await optIn(user.id);
    const notify = countingCenter();
    const deps = { ...scanDeps({ holders: [holder(user.id)], upcoming }), notify };

    const first = await runDividendEventsScan(deps);
    expect(first.emitted).toBe(1);

    // The holder reads and clears it. `deleteOne` hard-deletes the visible row —
    // which used to be the ONLY thing standing between them and a re-notify.
    const [row] = await dividendRows(user.id);
    expect(await createNotificationRepository(db).deleteOne(user.id, row!.id)).toBe(true);
    expect(await allDividendRows(user.id)).toHaveLength(0);

    const second = await runDividendEventsScan({ ...deps, now: () => day(1) });

    expect(second).toMatchObject({ emitted: 0, suppressed: 1, candidates: 1, degraded: false });
    expect(notify.emits).toHaveLength(1);
    expect(await allDividendRows(user.id)).toHaveLength(0);
  });

  it('notifies once across the whole horizon window, clearing the inbox each day', async () => {
    const user = await harness.seedUser({ email: 'horizon@bt.test', username: 'horizon' });
    await optIn(user.id);
    const notify = countingCenter();
    const deps = { ...scanDeps({ holders: [holder(user.id)], upcoming }), notify };
    const repo = createNotificationRepository(db);

    for (let d = 0; d < DIVIDEND_EVENT_HORIZON_DAYS; d += 1) {
      // The ex-date stays inside the horizon on every one of these days.
      await runDividendEventsScan({ ...deps, now: () => day(d) });
      await repo.deleteBulk(user.id, 'all');
    }

    expect(notify.emits).toHaveLength(1);
  });

  it('notifies once when the provider amends the ex-date inside the horizon', async () => {
    // The #1758 ruling, applied to payouts: an amended date is the SAME event —
    // exactly one notification, no "date changed" follow-up.
    const user = await harness.seedUser({ email: 'amend@bt.test', username: 'amend' });
    await optIn(user.id);
    const notify = countingCenter();
    const deps = { ...scanDeps({ holders: [holder(user.id)], upcoming }), notify };

    const announced = await runDividendEventsScan(deps);
    const amended = await runDividendEventsScan({
      ...deps,
      marketData: marketDataWith([
        { exDate: '2026-07-22T00:00:00.000Z', payDate: null, amount: 0.3, currency: 'USD' },
      ]),
      now: () => day(1),
    });

    expect(announced.emitted).toBe(1);
    expect(amended).toMatchObject({ emitted: 0, suppressed: 1, degraded: false });
    expect(notify.emits).toHaveLength(1);
    expect(notify.emits[0]).toMatchObject({ exDate: EX_DATE });
  });

  it('still notifies for the NEXT payout, a month after the one already sent', async () => {
    // The anchor recognises an amended date, not "this asset, ever": a monthly
    // distributor's next ex-date is far outside the match window.
    const user = await harness.seedUser({ email: 'monthly@bt.test', username: 'monthly' });
    await optIn(user.id);
    const notify = countingCenter();
    const deps = { ...scanDeps({ holders: [holder(user.id)], upcoming }), notify };

    await runDividendEventsScan(deps);
    const nextMonth = await runDividendEventsScan({
      ...deps,
      marketData: marketDataWith([
        { exDate: '2026-08-21T00:00:00.000Z', payDate: null, amount: 0.3, currency: 'USD' },
      ]),
      now: () => day(31),
    });

    expect(nextMonth).toMatchObject({ emitted: 1, suppressed: 0 });
    expect(notify.emits.map((e) => e.type === 'dividend.event' && e.exDate)).toEqual([
      EX_DATE,
      '2026-08-21T00:00:00.000Z',
    ]);
  });

  it('does not count a refused enqueue as sent, and retries it on the next scan', async () => {
    const user = await harness.seedUser({ email: 'refused@bt.test', username: 'refused' });
    await optIn(user.id);
    const deps = scanDeps({ holders: [holder(user.id)], upcoming });

    const refused = await runDividendEventsScan({
      ...deps,
      notify: { emit: async () => false },
    });

    expect(refused).toEqual({
      ...NOTHING,
      assetsScanned: 1,
      candidates: 1,
      failed: 1,
      skipped: 1,
      degraded: true,
    });
    // The counters decompose exactly into the reported outcomes.
    expect(refused.emitted + refused.suppressed + refused.failed + refused.errored).toBe(
      refused.candidates,
    );
    expect(await dividendRows(user.id)).toHaveLength(0);

    // The claim was rolled back, so a healthy transport delivers next scan.
    const notify = countingCenter();
    const retried = await runDividendEventsScan({ ...deps, notify, now: () => day(1) });
    expect(retried).toMatchObject({ emitted: 1, failed: 0, degraded: false });
    expect(notify.emits).toHaveLength(1);
  });

  it('re-attempts a failed asset for the next holder instead of dropping the whole book', async () => {
    const holders: HeldAssetHolderRow[] = [];
    for (const name of ['h1', 'h2', 'h3']) {
      const user = await harness.seedUser({ email: `${name}@bt.test`, username: name });
      await optIn(user.id);
      holders.push(holder(user.id));
    }
    let calls = 0;
    const notify = countingCenter();
    const result = await runDividendEventsScan({
      ...scanDeps({ holders, upcoming }),
      notify,
      marketData: createStubMarketData({
        dividends: () => {
          calls += 1;
          // A rate-limit blip on the FIRST holder's fetch only.
          if (calls === 1) throw new Error('rate limited');
          return cachedIntel(dividends(upcoming));
        },
      }),
    });

    expect(calls).toBe(2);
    expect(notify.emits.map((e) => e.userId)).toEqual([holders[1]!.userId, holders[2]!.userId]);
    expect(result).toMatchObject({
      emitted: 2,
      holdersSkipped: 1,
      assetsFailed: 0,
      skipped: 1,
      degraded: true,
    });
  });

  it('bounds the re-attempts and reports every skipped holder when the asset never resolves', async () => {
    const holders: HeldAssetHolderRow[] = [];
    for (const name of ['d1', 'd2', 'd3', 'd4']) {
      const user = await harness.seedUser({ email: `${name}@bt.test`, username: name });
      await optIn(user.id);
      holders.push(holder(user.id));
    }
    let calls = 0;
    const result = await runDividendEventsScan({
      ...scanDeps({ holders, upcoming }),
      marketData: createStubMarketData({
        dividends: () => {
          calls += 1;
          throw new Error('provider down');
        },
      }),
    });

    expect(calls).toBe(DIVIDEND_PROVIDER_ATTEMPTS_PER_ASSET);
    expect(result).toMatchObject({
      emitted: 0,
      candidates: 0,
      holdersSkipped: holders.length,
      assetsFailed: 1,
      skipped: holders.length,
      degraded: true,
    });
  });

  it('isolates a repository throw at one user so the rest of the book still runs', async () => {
    const holders: HeldAssetHolderRow[] = [];
    for (const name of ['u1', 'u2', 'u3']) {
      const user = await harness.seedUser({ email: `${name}@bt.test`, username: name });
      await optIn(user.id);
      holders.push(holder(user.id));
    }
    const notify = countingCenter();
    const deps = scanDeps({ holders, upcoming });
    const result = await runDividendEventsScan({
      ...deps,
      notify,
      repo: {
        ...deps.repo,
        listHeldAssetHoldersForUser: async (userId: string) => {
          if (userId === holders[1]!.userId) throw new Error('db hiccup');
          return holders.filter((row) => row.userId === userId);
        },
      },
    });

    expect(notify.emits.map((e) => e.userId)).toEqual([holders[0]!.userId, holders[2]!.userId]);
    expect(result).toMatchObject({ emitted: 2, usersFailed: 1, skipped: 1, degraded: true });
  });
});

describe('marketIntel.dividendScan — completion log (#1791)', () => {
  const upcoming = [
    { exDate: '2026-09-04T00:00:00.000Z', payDate: null, amount: 0.3, currency: 'USD' },
  ];

  /** The job deps, minus what the handler supplies from its own context. */
  function jobDeps(over: Partial<ReturnType<typeof scanDeps>> = {}) {
    const {
      now: _now,
      redis: _redis,
      ...deps
    } = { ...scanDeps({ holders: [], upcoming }), ...over };
    return deps;
  }

  it('logs a clean run as complete and a run with any skip as degraded', async () => {
    const user = await harness.seedUser({ email: 'log@bt.test', username: 'log' });
    await optIn(user.id);
    const base = scanDeps({ holders: [holder(user.id)], upcoming });

    const clean = capturingLogger();
    await createDividendEventsScanJob(jobDeps(base)).handler(makeJob(), makeJobCtx(clean.logger));

    expect(clean.warn).toEqual([]);
    expect(clean.info).toHaveLength(1);
    expect(clean.info[0]!.msg).toBe('marketIntel.dividendScan complete');
    expect(clean.info[0]!.payload).toMatchObject({ emitted: 1, skipped: 0 });

    const degraded = capturingLogger();
    await createDividendEventsScanJob(
      jobDeps({
        ...base,
        runIfAllowed: async () => false,
      }),
    ).handler(makeJob(), makeJobCtx(degraded.logger));

    // A run that skipped anything cannot report as complete.
    expect(degraded.info).toEqual([]);
    expect(degraded.warn).toHaveLength(1);
    expect(degraded.warn[0]!.msg).toBe('marketIntel.dividendScan completed with skips');
    expect(degraded.warn[0]!.payload).toMatchObject({ skipped: 1, usersDeferred: 1 });
  });
});

describe('dividendNotifyGate — V5-P0 kill-switch (#1795)', () => {
  const routing = (over: Partial<TypeRouting> = {}): TypeRouting => ({
    inapp: false,
    email: false,
    push: false,
    webpush: false,
    telegram: false,
    discord: false,
    ...over,
  });

  it('does not count a deactivated Telegram/Discord as "wants this type"', async () => {
    const routingFor = async () => routing({ telegram: true, discord: true });
    const off = dividendNotifyGate({ routingFor }, { telegram: false, discord: false });
    await expect(off('u1')).resolves.toBe(false);

    // Same stored routing, kill-switch back on: the opt-in returns untouched.
    const on = dividendNotifyGate({ routingFor }, { telegram: true, discord: true });
    await expect(on('u1')).resolves.toBe(true);
  });

  it('still counts a live channel while the additive ones are deactivated', async () => {
    const gate = dividendNotifyGate(
      { routingFor: async () => routing({ inapp: true, telegram: true }) },
      { telegram: false, discord: false },
    );
    await expect(gate('u1')).resolves.toBe(true);
  });
});
