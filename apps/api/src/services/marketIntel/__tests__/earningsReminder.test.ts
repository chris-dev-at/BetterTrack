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

/** A fixture row; `custom` marks an account-OWNED asset (`assets.owner_id`). */
type IntelRow = UserIntelAssetWithUser & { custom?: boolean };

function asset(over: Partial<IntelRow>): IntelRow {
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

/**
 * Models the production queries: the unguarded all-users watch query is
 * GLOBAL-only (it never selects an account-owned asset row), while the
 * per-user query the scan runs inside that account's transition lock returns
 * everything that account holds or watches.
 */
function intelRepo(rows: IntelRow[]) {
  const strip = ({ custom: _custom, ...row }: IntelRow): UserIntelAssetWithUser => row;
  return {
    listAllWatchAssets: async () =>
      rows
        .filter((row) => row.watched && !row.custom)
        .map((row) => ({ ...strip(row), held: false })),
    listNormalUserIds: async () => [...new Set(rows.map((row) => row.userId))],
    listUserWatchAndHoldAssets: async (userId: string) =>
      rows.filter((row) => row.userId === userId).map(strip),
  };
}

const runIfAllowed = async (_userId: string, action: () => Promise<void>) => {
  await action();
  return true;
};

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
      intelRepo: intelRepo([asset({})]),
      marketData: marketDataWithEarnings({ AAPL: day(2) }),
      redis,
      notify,
      enabled: true,
      runIfAllowed,
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
      intelRepo: intelRepo([
        asset({ userId: 'u1', assetId: 'far', providerRef: 'FAR', symbol: 'FAR' }),
        asset({ userId: 'u2', assetId: 'past', providerRef: 'PAST', symbol: 'PAST' }),
      ]),
      marketData: marketDataWithEarnings({ FAR: day(10), PAST: day(-1) }),
      redis,
      notify,
      enabled: true,
      runIfAllowed,
      now: () => NOW,
    });
    expect(res.reminded).toBe(0);
    expect(notify.emit).not.toHaveBeenCalled();
  });

  it('fires exactly once per (user, asset, date) across repeated scans (idempotent)', async () => {
    const notify = stubNotify();
    const deps = {
      intelRepo: intelRepo([asset({})]),
      marketData: marketDataWithEarnings({ AAPL: day(1) }),
      redis,
      notify,
      enabled: true,
      runIfAllowed,
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
      intelRepo: intelRepo([asset({ userId: 'u1' }), asset({ userId: 'u2' })]),
      marketData: marketDataWithEarnings({ AAPL: day(1) }),
      redis,
      notify,
      enabled: true,
      runIfAllowed,
      now: () => NOW,
    });
    expect(res.reminded).toBe(2);
    expect(notify.events.map((e) => e.userId).sort()).toEqual(['u1', 'u2']);
  });

  it('releases the lock and retries when the durable enqueue fails', async () => {
    const failing = stubNotify(false);
    const deps = {
      intelRepo: intelRepo([asset({})]),
      marketData: marketDataWithEarnings({ AAPL: day(1) }),
      redis,
      enabled: true,
      runIfAllowed,
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
        listAllWatchAssets: async () => {
          throw new Error('should not be queried when gated off');
        },
        listNormalUserIds: async () => {
          throw new Error('should not be queried when gated off');
        },
        listUserWatchAndHoldAssets: async () => {
          throw new Error('should not be queried when gated off');
        },
      },
      marketData: marketDataWithEarnings({ AAPL: day(1) }),
      redis,
      notify,
      enabled: false,
      runIfAllowed,
      now: () => NOW,
    });
    expect(res).toEqual({ scanned: 0, reminded: 0 });
    expect(notify.emit).not.toHaveBeenCalled();
  });

  it('skips paranoid holding-only rows but preserves their private watchlist reminders', async () => {
    const notify = stubNotify();
    const res = await runEarningsReminderScan({
      intelRepo: intelRepo([
        asset({ assetId: 'held', providerRef: 'HELD', symbol: 'HELD' }),
        asset({
          assetId: 'watched',
          providerRef: 'WATCH',
          symbol: 'WATCH',
          held: true,
          watched: true,
        }),
      ]),
      marketData: marketDataWithEarnings({ HELD: day(1), WATCH: day(1) }),
      redis,
      notify,
      enabled: true,
      runIfAllowed: async () => false,
      now: () => NOW,
    });

    expect(res).toEqual({ scanned: 1, reminded: 1 });
    expect(notify.events).toHaveLength(1);
    expect(notify.events[0]).toMatchObject({ assetId: 'watched', symbol: 'WATCH' });
  });

  it('never reads a paranoid account custom watchlist asset, but keeps a normal one', async () => {
    const rows = [
      asset({
        userId: 'paranoid',
        assetId: 'house',
        providerRef: 'HOUSE',
        symbol: 'HOUSE',
        name: 'Paranoid House',
        held: false,
        watched: true,
        custom: true,
      }),
      asset({
        userId: 'paranoid',
        assetId: 'global',
        providerRef: 'GLOBAL',
        symbol: 'GLOBAL',
        held: false,
        watched: true,
      }),
      asset({
        userId: 'normal',
        assetId: 'boat',
        providerRef: 'BOAT',
        symbol: 'BOAT',
        name: 'Normal Boat',
        held: false,
        watched: true,
        custom: true,
      }),
    ];
    const notify = stubNotify();
    const res = await runEarningsReminderScan({
      intelRepo: intelRepo(rows),
      marketData: marketDataWithEarnings({ HOUSE: day(1), GLOBAL: day(1), BOAT: day(1) }),
      redis,
      notify,
      enabled: true,
      // Only the paranoid account's guarded pass is refused; the global pass
      // above it is unguarded and the normal account's pass runs.
      runIfAllowed: async (userId, action) => {
        if (userId === 'paranoid') return false;
        await action();
        return true;
      },
      now: () => NOW,
    });

    // The paranoid account's OWN custom watchlist row is never processed —
    // it is not in the global pass, and its guarded pass never runs.
    expect(notify.events.map((event) => (event as { symbol: string }).symbol).sort()).toEqual([
      'BOAT',
      'GLOBAL',
    ]);
    expect(res.reminded).toBe(2);
  });
});
