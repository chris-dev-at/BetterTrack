import type { AssetRef } from '@bettertrack/contracts';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserIntelAssetWithUser } from '../../../data/repositories/marketIntelRepository';
import type { DispatchableEvent } from '../../notifications/notificationDispatcher';
import {
  cachedIntel,
  createStubMarketData,
  sampleEarningsEvents,
} from '../../../testing/marketDataStubs';
import { runEarningsReminderScan } from '../earningsReminder';

// A fixed clock; earnings dates are placed relative to it.
const NOW = Date.parse('2026-07-18T09:00:00.000Z');
const day = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

function asset(over: Partial<UserIntelAssetWithUser>): UserIntelAssetWithUser {
  return {
    userId: 'u1',
    assetId: 'a-aapl',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    providerId: 'yahoo',
    providerRef: 'AAPL',
    held: true,
    watched: false,
    ...over,
  };
}

/** A notification-center double: records emits, returns a controllable result. */
function stubNotify(result = true) {
  const events: DispatchableEvent[] = [];
  return {
    events,
    emit: vi.fn(async (e: DispatchableEvent) => {
      events.push(e);
      return result;
    }),
  };
}

function marketDataWithEarnings(dateByRef: Record<string, string | null>) {
  return createStubMarketData({
    earnings: (ref: AssetRef) => {
      const date = dateByRef[ref.providerRef] ?? null;
      return cachedIntel(
        sampleEarningsEvents({
          next: date ? { date, epsEstimate: 1.4, epsActual: null, estimated: true } : null,
        }),
      );
    },
  });
}

let redis: Redis;
beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  // ioredis-mock shares its keyspace across instances — flush so each test's
  // idempotency locks start clean.
  await redis.flushall();
});

describe('runEarningsReminderScan (V5-P5)', () => {
  it('emits a reminder for an asset whose report is inside the lead window', async () => {
    const notify = stubNotify();
    const res = await runEarningsReminderScan({
      intelRepo: { listAllWatchAndHoldAssets: async () => [asset({})] },
      marketData: marketDataWithEarnings({ AAPL: day(2) }),
      redis,
      notify,
      enabled: true,
      now: () => NOW,
    });
    expect(res.reminded).toBe(1);
    expect(notify.emit).toHaveBeenCalledTimes(1);
    expect(notify.events[0]).toMatchObject({
      type: 'earnings.reminder',
      userId: 'u1',
      assetId: 'a-aapl',
      symbol: 'AAPL',
      earningsDate: day(2),
      estimated: true,
    });
  });

  it('does NOT emit for a report outside the lead window or already past', async () => {
    const notify = stubNotify();
    const res = await runEarningsReminderScan({
      intelRepo: {
        listAllWatchAndHoldAssets: async () => [
          asset({ userId: 'u1', assetId: 'far', providerRef: 'FAR', symbol: 'FAR' }),
          asset({ userId: 'u2', assetId: 'past', providerRef: 'PAST', symbol: 'PAST' }),
        ],
      },
      marketData: marketDataWithEarnings({ FAR: day(10), PAST: day(-1) }),
      redis,
      notify,
      enabled: true,
      now: () => NOW,
    });
    expect(res.reminded).toBe(0);
    expect(notify.emit).not.toHaveBeenCalled();
  });

  it('fires exactly once per (user, asset, date) across repeated scans (idempotent)', async () => {
    const notify = stubNotify();
    const deps = {
      intelRepo: { listAllWatchAndHoldAssets: async () => [asset({})] },
      marketData: marketDataWithEarnings({ AAPL: day(1) }),
      redis,
      notify,
      enabled: true,
      now: () => NOW,
    };
    const first = await runEarningsReminderScan(deps);
    const second = await runEarningsReminderScan(deps);
    expect(first.reminded).toBe(1);
    expect(second.reminded).toBe(0);
    expect(notify.emit).toHaveBeenCalledTimes(1);
  });

  it('keeps distinct rows per user for the same asset+date', async () => {
    const notify = stubNotify();
    const res = await runEarningsReminderScan({
      intelRepo: {
        listAllWatchAndHoldAssets: async () => [asset({ userId: 'u1' }), asset({ userId: 'u2' })],
      },
      marketData: marketDataWithEarnings({ AAPL: day(1) }),
      redis,
      notify,
      enabled: true,
      now: () => NOW,
    });
    expect(res.reminded).toBe(2);
    expect(notify.events.map((e) => e.userId).sort()).toEqual(['u1', 'u2']);
  });

  it('releases the lock and retries when the durable enqueue fails', async () => {
    const failing = stubNotify(false);
    const deps = {
      intelRepo: { listAllWatchAndHoldAssets: async () => [asset({})] },
      marketData: marketDataWithEarnings({ AAPL: day(1) }),
      redis,
      enabled: true,
      now: () => NOW,
    };
    const first = await runEarningsReminderScan({ ...deps, notify: failing });
    expect(first.reminded).toBe(0);

    // Next scan with a healthy transport re-attempts (the lock was released).
    const ok = stubNotify(true);
    const second = await runEarningsReminderScan({ ...deps, notify: ok });
    expect(second.reminded).toBe(1);
    expect(ok.emit).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the MARKET_INTEL_ENABLED gate is off', async () => {
    const notify = stubNotify();
    const res = await runEarningsReminderScan({
      intelRepo: {
        listAllWatchAndHoldAssets: async () => {
          throw new Error('should not be queried when gated off');
        },
      },
      marketData: marketDataWithEarnings({ AAPL: day(1) }),
      redis,
      notify,
      enabled: false,
      now: () => NOW,
    });
    expect(res).toEqual({ scanned: 0, reminded: 0 });
    expect(notify.emit).not.toHaveBeenCalled();
  });
});
