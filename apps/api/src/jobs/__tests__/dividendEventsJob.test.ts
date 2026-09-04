import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AssetRef, DividendEvents } from '@bettertrack/contracts';

import type { Database } from '../../data/db';
import type { HeldAssetHolderRow } from '../../data/repositories/marketIntelRepository';
import { createNotificationRepository } from '../../data/repositories/notificationRepository';
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
  createDividendEventsScanJob,
  dividendNotifyGate,
  runDividendEventsScan,
} from '../definitions/dividendEventsJob';
import type { JobContext } from '../types';

const NOW = Date.parse('2026-07-18T00:00:00.000Z');

let harness: TestHarness;
let db: Database;

beforeEach(async () => {
  harness = await createTestApp();
  db = harness.db;
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
    isEnabled: dividendNotifyGate(repo),
    runIfAllowed: async (_userId: string, action: () => Promise<void>) => {
      await action();
      return true;
    },
    enabled: opts.enabled ?? true,
    now: () => NOW,
  };
}

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

    // Both runs emit (the job does not dedupe), but the dispatcher's
    // (recipient, asset, ex-date) key collapses them to ONE visible row.
    expect(first.emitted).toBe(1);
    expect(second.emitted).toBe(1);
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
    expect(result).toEqual({ assetsScanned: 0, emitted: 0 });
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
    expect(result).toEqual({ assetsScanned: 0, emitted: 0 });
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

function makeJobCtx(): JobContext {
  const redis = new RedisMock() as unknown as Redis;
  return {
    events: harness.ctx.events,
    deadLetter: createDeadLetter(redis),
    redis,
    logger: pino({ level: 'silent' }) as unknown as Logger,
    isFeatureEnabled: async () => true,
  };
}

describe('marketIntel.dividendScan — run clock (#1543)', () => {
  it('scans from the execution instant: yesterday is excluded and the horizon is full', async () => {
    const user = await harness.seedUser({ email: 'clock@bt.test', username: 'clock' });
    await optIn(user.id);
    const {
      now: _now,
      notify: _notify,
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
