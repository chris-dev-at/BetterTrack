import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { pino } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AssetRef } from '@bettertrack/contracts';

import type { UserIntelAssetWithUser } from '../../data/repositories/marketIntelRepository';
import type { TypeRouting } from '../../data/repositories/notificationRepository';
import type { DomainEventType, EventBus, EventHandler, Unsubscribe } from '../../events';
import type { Logger } from '../../logger';
import type { NotificationCenter } from '../../services/notifications/notificationCenter';
import type { DispatchableEvent } from '../../services/notifications/notificationDispatcher';
import {
  cachedIntel,
  createStubMarketData,
  sampleEarningsEvents,
} from '../../testing/marketDataStubs';
import { createDeadLetter } from '../deadLetter';
import { createEarningsReminderJob, earningsNotifyGate } from '../definitions/earningsReminderJob';
import type { JobContext } from '../types';

/**
 * The earnings-reminder scan's clock (#1543). The scheduled daily run happens at
 * {@link RUN_AT}; BullMQ stamps `job.timestamp` when it CREATES the delayed job,
 * which for a repeatable schedule is the previous iteration's pickup — exactly
 * one period (a day) earlier. Only `processedOn` is the execution instant, and
 * the handler must use it: the scan's `occurredAt` is `new Date(now)`, so every
 * emitted reminder reveals the clock the handler actually ran with.
 */
const RUN_AT = Date.parse('2026-09-01T04:00:00.000Z');
/** What a `job.timestamp`-derived clock would have believed "now" was. */
const STALE_TIMESTAMP = Date.parse('2026-08-31T04:00:00.000Z');

const logger = pino({ level: 'silent' }) as unknown as Logger;

const inertBus: EventBus = {
  async publish() {},
  async subscribe<T extends DomainEventType>(_type: T, _handler: EventHandler<T>) {
    const unsub: Unsubscribe = async () => {};
    return unsub;
  },
  async close() {},
};

let ctx: JobContext;

beforeEach(async () => {
  const redis = new RedisMock() as unknown as Redis;
  // ioredis-mock shares its keyspace across instances — flush so each test's
  // idempotency locks start clean.
  await redis.flushall();
  ctx = {
    events: inertBus,
    deadLetter: createDeadLetter(redis),
    redis,
    logger,
    isFeatureEnabled: async () => true,
  };
});

function makeJob(): Job<Record<string, never>> {
  return {
    id: 'earnings-1',
    name: 'notifications.earningsRemind',
    data: {},
    timestamp: STALE_TIMESTAMP,
    processedOn: RUN_AT,
  } as unknown as Job<Record<string, never>>;
}

const holding: UserIntelAssetWithUser = {
  userId: 'u1',
  assetId: 'a-aapl',
  symbol: 'AAPL',
  name: 'Apple Inc.',
  providerId: 'yahoo',
  providerRef: 'AAPL',
  held: true,
  watched: false,
};

/** One held asset for one account; the global watch query returns nothing. */
const intelRepo = {
  listAllWatchAssets: async () => [],
  listNormalUserIds: async () => [holding.userId],
  listUserWatchAndHoldAssets: async () => [holding],
};

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

/** The stub provider serves one next-report date for the held asset. */
function marketDataWithReport(date: string | null) {
  return createStubMarketData({
    earnings: (_ref: AssetRef) =>
      cachedIntel(
        sampleEarningsEvents({
          next: date
            ? { date, periodEnd: null, epsEstimate: 1.4, epsActual: null, estimated: true }
            : null,
        }),
      ),
  });
}

function jobFor(
  date: string | null,
  notify: NotificationCenter,
  now?: () => number,
  isEnabled: (userId: string) => Promise<boolean> = async () => true,
) {
  return createEarningsReminderJob({
    intelRepo,
    marketData: marketDataWithReport(date),
    notify,
    isEnabled,
    enabled: true,
    runIfAllowed: async (_userId: string, action: () => Promise<void>) => {
      await action();
      return true;
    },
    now,
  });
}

describe('notifications.earningsRemind — run clock (#1543)', () => {
  it('scans against the execution instant, not the one-period-stale job.timestamp', async () => {
    // 2026-09-04 is the 3rd calendar day after the real run (inside the lead),
    // but the 4th after the stale `job.timestamp` — a `job.timestamp` clock
    // would skip it and only fire a day later, shrinking the documented 3-day
    // lead.
    const notify = recordingCenter();
    await jobFor('2026-09-04T20:00:00.000Z', notify).handler(makeJob(), ctx);

    expect(notify.emitted).toEqual([
      expect.objectContaining({
        type: 'earnings.reminder',
        userId: 'u1',
        assetId: 'a-aapl',
        earningsDate: '2026-09-04T20:00:00.000Z',
        // The scan stamps `occurredAt` from its clock — this IS the assertion
        // that the effective `now` is the execution instant and not
        // `job.timestamp` (which would read 2026-08-31T04:00:00.000Z).
        occurredAt: '2026-09-01T04:00:00.000Z',
      }),
    ]);
    expect(notify.emitted[0]).not.toMatchObject({
      occurredAt: new Date(STALE_TIMESTAMP).toISOString(),
    });
  });

  it('excludes a report dated before the execution instant', async () => {
    // Already reported at 2026-08-31T20:00Z. Under the stale clock that date is
    // 16 h in the "future" and inside the lead window, so a newly-added holding
    // would get an "upcoming earnings" reminder for a report that has happened.
    const notify = recordingCenter();
    await jobFor('2026-08-31T20:00:00.000Z', notify).handler(makeJob(), ctx);

    expect(notify.emitted).toEqual([]);
  });

  it('excludes a report past the 3-calendar-day lead edge', async () => {
    // 2026-09-05 is the 4th calendar day out from the real run — beyond
    // EARNINGS_REMINDER_LEAD_DAYS (3). It becomes due on a later daily run.
    const notify = recordingCenter();
    await jobFor('2026-09-05T20:00:00.000Z', notify).handler(makeJob(), ctx);

    expect(notify.emitted).toEqual([]);
  });

  it('still honours the injectable deps.now seam', async () => {
    // The seam wins over `processedOn`: pinning the clock a day earlier puts the
    // same report back outside the lead window.
    const notify = recordingCenter();
    await jobFor('2026-09-04T20:00:00.000Z', notify, () => STALE_TIMESTAMP).handler(makeJob(), ctx);

    expect(notify.emitted).toEqual([]);
  });

  it('passes the opt-in gate through: an un-enabled recipient gets nothing', async () => {
    const notify = recordingCenter();
    await jobFor('2026-09-04T20:00:00.000Z', notify, undefined, async () => false).handler(
      makeJob(),
      ctx,
    );

    expect(notify.emitted).toEqual([]);
  });
});

describe('earningsNotifyGate', () => {
  const routing = (over: Partial<TypeRouting> = {}): TypeRouting => ({
    inapp: false,
    email: false,
    push: false,
    webpush: false,
    telegram: false,
    discord: false,
    ...over,
  });

  it('is false when the type routes to no channel at all', async () => {
    const gate = earningsNotifyGate({ routingFor: async () => routing() });
    await expect(gate('u1')).resolves.toBe(false);
  });

  it('is true as soon as one channel carries the type, and asks for that type', async () => {
    const routingFor = vi.fn(async () => routing({ email: true }));
    const gate = earningsNotifyGate({ routingFor });

    await expect(gate('u1')).resolves.toBe(true);
    expect(routingFor).toHaveBeenCalledWith('u1', 'earnings.reminder');
  });
});

describe('notifications.earningsRemind — completion log (#1791)', () => {
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
    const captured = {
      info: push(info),
      warn: push(warn),
      error: noop,
      debug: noop,
      trace: noop,
      fatal: noop,
      child: () => captured,
    };
    return { logger: captured as unknown as Logger, info, warn };
  }

  it('logs a clean run as complete', async () => {
    const captured = capturingLogger();
    await jobFor('2026-09-04T20:00:00.000Z', recordingCenter()).handler(makeJob(), {
      ...ctx,
      logger: captured.logger,
    });

    expect(captured.warn).toEqual([]);
    expect(captured.info).toHaveLength(1);
    expect(captured.info[0]!.msg).toBe('notifications.earningsRemind complete');
    expect(captured.info[0]!.payload).toMatchObject({ reminded: 1, skipped: 0 });
  });

  it('refuses to log a run with any skip as complete', async () => {
    const captured = capturingLogger();
    const job = createEarningsReminderJob({
      intelRepo,
      marketData: marketDataWithReport('2026-09-04T20:00:00.000Z'),
      notify: recordingCenter(),
      isEnabled: async () => true,
      enabled: true,
      // The paranoid transition guard wins for this account: its book is never
      // read, so the run is degraded, not complete.
      runIfAllowed: async () => false,
    });
    await job.handler(makeJob(), { ...ctx, logger: captured.logger });

    expect(captured.info).toEqual([]);
    expect(captured.warn).toHaveLength(1);
    expect(captured.warn[0]!.msg).toBe('notifications.earningsRemind completed with skips');
    expect(captured.warn[0]!.payload).toMatchObject({ skipped: 1, usersDeferred: 1 });
  });
});
