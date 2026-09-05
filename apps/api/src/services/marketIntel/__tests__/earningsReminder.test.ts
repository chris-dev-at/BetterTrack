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

/** Every user has `earnings.reminder` enabled on at least one channel. */
const optedIn = async (_userId: string) => true;
/** Nobody enabled the type — the default state of an opt-in notification. */
const optedOut = async (_userId: string) => false;

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
          next: date
            ? { date, periodEnd: null, epsEstimate: 1.4, epsActual: null, estimated: true }
            : null,
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
      isEnabled: optedIn,
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

  it('emits nothing and leaves NO marker for a recipient who never opted in', async () => {
    const notify = stubNotify();
    const res = await runEarningsReminderScan({
      intelRepo: intelRepo([asset({})]),
      marketData: marketDataWithEarnings({ AAPL: day(2) }),
      redis,
      notify,
      isEnabled: optedOut,
      enabled: true,
      runIfAllowed,
      now: () => NOW,
    });

    expect(res.reminded).toBe(0);
    // No emit ⇒ the dispatcher never writes its inbox row, which doubles as the
    // dedupe marker; and no 45-day idempotency lock is taken either. Both would
    // otherwise say "already handled" once the recipient enables the type.
    expect(notify.emit).not.toHaveBeenCalled();
    expect(await redis.keys('earnings:reminded:*')).toEqual([]);
  });

  it('still reminds on the next scan when the type is enabled after a skipped one', async () => {
    const deps = {
      intelRepo: intelRepo([asset({})]),
      marketData: marketDataWithEarnings({ AAPL: day(2) }),
      redis,
      enabled: true,
      runIfAllowed,
      now: () => NOW,
    };
    const skipped = stubNotify();
    const first = await runEarningsReminderScan({
      ...deps,
      notify: skipped,
      isEnabled: optedOut,
    });
    expect(first.reminded).toBe(0);

    // Same report, next daily scan, type now enabled: it must arrive.
    const delivered = stubNotify();
    const second = await runEarningsReminderScan({
      ...deps,
      notify: delivered,
      isEnabled: optedIn,
    });
    expect(second.reminded).toBe(1);
    expect(delivered.events[0]).toMatchObject({
      type: 'earnings.reminder',
      assetId: 'a-aapl',
      earningsDate: day(2),
    });
  });

  it('reads each recipient’s opt-in once per run, not once per row', async () => {
    const gate = vi.fn(optedIn);
    await runEarningsReminderScan({
      intelRepo: intelRepo([
        asset({ assetId: 'a-aapl', providerRef: 'AAPL' }),
        asset({ assetId: 'a-msft', providerRef: 'MSFT', symbol: 'MSFT' }),
      ]),
      marketData: marketDataWithEarnings({ AAPL: day(1), MSFT: day(2) }),
      redis,
      notify: stubNotify(),
      isEnabled: gate,
      enabled: true,
      runIfAllowed,
      now: () => NOW,
    });

    expect(gate).toHaveBeenCalledTimes(1);
    expect(gate).toHaveBeenCalledWith('u1');
  });

  it('reminds an after-close reporter a full LEAD_DAYS calendar days ahead', async () => {
    // NOW is 09:00 UTC on the 18th; the report is stamped 20:00 on the 21st —
    // the 3rd calendar day, but 3 d 11 h of elapsed time. A milliseconds window
    // of 3 × 24 h skips it here and only fires on the next daily run, silently
    // shrinking the documented 3-day lead to 2.
    const notify = stubNotify();
    const res = await runEarningsReminderScan({
      intelRepo: intelRepo([asset({})]),
      marketData: marketDataWithEarnings({ AAPL: '2026-07-21T20:00:00.000Z' }),
      redis,
      notify,
      isEnabled: optedIn,
      enabled: true,
      runIfAllowed,
      now: () => NOW,
    });

    expect(res.reminded).toBe(1);
    expect(notify.events[0]).toMatchObject({ earningsDate: '2026-07-21T20:00:00.000Z' });
  });

  it('does not reach a report on the day after the lead window', async () => {
    const notify = stubNotify();
    const res = await runEarningsReminderScan({
      intelRepo: intelRepo([asset({})]),
      // The 4th calendar day out — a later scan owns it.
      marketData: marketDataWithEarnings({ AAPL: '2026-07-22T00:00:00.000Z' }),
      redis,
      notify,
      isEnabled: optedIn,
      enabled: true,
      runIfAllowed,
      now: () => NOW,
    });

    expect(res.reminded).toBe(0);
    expect(notify.emit).not.toHaveBeenCalled();
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
      isEnabled: optedIn,
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
      isEnabled: optedIn,
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

  it('notifies once for a report whose estimated date firms up inside the lead window', async () => {
    // Yahoo publishes an ESTIMATED window until the company confirms; the date a
    // scan sees legitimately moves by a day or two. That is one report, and the
    // decision (#1758) is exactly one reminder — no "date changed" follow-up.
    const notify = stubNotify();
    const base = {
      intelRepo: intelRepo([asset({})]),
      redis,
      notify,
      isEnabled: optedIn,
      enabled: true,
      runIfAllowed,
      now: () => NOW,
    };
    const estimated = await runEarningsReminderScan({
      ...base,
      marketData: marketDataWithEarnings({ AAPL: day(3) }),
    });
    const confirmed = await runEarningsReminderScan({
      ...base,
      marketData: marketDataWithEarnings({ AAPL: day(2) }),
    });

    expect(estimated.reminded).toBe(1);
    expect(confirmed.reminded).toBe(0);
    expect(notify.emit).toHaveBeenCalledTimes(1);
    expect(notify.events[0]).toMatchObject({ earningsDate: day(3) });
  });

  it('still reminds for the NEXT report, a quarter after the one already sent', async () => {
    // The anchor recognises a corrected date, not "this asset, ever": a report
    // ~90 days out is far outside the match window and must fire on its own.
    const notify = stubNotify();
    const laterNow = NOW + 90 * 86_400_000;
    const base = {
      intelRepo: intelRepo([asset({})]),
      redis,
      notify,
      isEnabled: optedIn,
      enabled: true,
      runIfAllowed,
    };
    const first = await runEarningsReminderScan({
      ...base,
      marketData: marketDataWithEarnings({ AAPL: day(1) }),
      now: () => NOW,
    });
    const nextQuarter = new Date(laterNow + 86_400_000).toISOString();
    const second = await runEarningsReminderScan({
      ...base,
      marketData: marketDataWithEarnings({ AAPL: nextQuarter }),
      now: () => laterNow,
    });

    expect(first.reminded).toBe(1);
    expect(second.reminded).toBe(1);
    expect(notify.events.map((e) => e.type === 'earnings.reminder' && e.earningsDate)).toEqual([
      day(1),
      nextQuarter,
    ]);
  });

  it('keeps distinct rows per user for the same asset+date', async () => {
    const notify = stubNotify();
    const res = await runEarningsReminderScan({
      intelRepo: intelRepo([asset({ userId: 'u1' }), asset({ userId: 'u2' })]),
      marketData: marketDataWithEarnings({ AAPL: day(1) }),
      redis,
      notify,
      isEnabled: optedIn,
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
      isEnabled: optedIn,
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
      isEnabled: optedIn,
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
      isEnabled: optedIn,
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
      isEnabled: optedIn,
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
