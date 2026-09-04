import type { AssetRef } from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import type { AssetRepository } from '../../../data/repositories/assetRepository';
import type { UserIntelAsset } from '../../../data/repositories/marketIntelRepository';
import {
  cachedIntel,
  createStubMarketData,
  sampleEarningsEvents,
} from '../../../testing/marketDataStubs';
import { createMarketIntelService } from '../marketIntelService';
import { MARKET_INTEL_ROLLUP_MAX_ASSETS } from '../rollupBudget';

// assetRepo is unused by earningsCalendar (it aggregates via intelRepo); a
// throwing stub proves the calendar path never touches per-asset resolution.
const assetRepo = {
  findByIdForUser: () => {
    throw new Error('unexpected assetRepo call');
  },
} as unknown as AssetRepository;

function intelRepo(assets: UserIntelAsset[]) {
  return {
    listUserWatchAndHoldAssets: async () => assets,
    listUserWatchAssets: async () =>
      assets.filter((asset) => asset.watched).map((asset) => ({ ...asset, held: false })),
  };
}

const AAPL: UserIntelAsset = {
  assetId: 'a-aapl',
  symbol: 'AAPL',
  name: 'Apple Inc.',
  providerId: 'yahoo',
  providerRef: 'AAPL',
  held: true,
  watched: false,
};
const MSFT: UserIntelAsset = {
  assetId: 'a-msft',
  symbol: 'MSFT',
  name: 'Microsoft',
  providerId: 'yahoo',
  providerRef: 'MSFT',
  held: false,
  watched: true,
};

/**
 * Every case pins its own clock: the calendar drops reports dated before today
 * (UTC), so a suite leaning on the wall clock would silently go vacuous the
 * moment its fixture dates passed.
 */
const clock = (iso: string) => () => Date.parse(iso);

/** A clock earlier than every date the "shape" cases below use. */
const BEFORE_ALL = clock('2026-07-20T09:00:00.000Z');

/** A single dated upcoming report for the given ref. */
function nextOn(date: string) {
  return () =>
    cachedIntel(
      sampleEarningsEvents({ next: { date, epsEstimate: 1.4, epsActual: null, estimated: true } }),
    );
}

describe('marketIntel.earningsCalendar (V5-P5)', () => {
  it('returns held + watched entries with a dated upcoming report, ascending by date', async () => {
    const marketData = createStubMarketData({
      earnings: (ref: AssetRef) =>
        cachedIntel(
          sampleEarningsEvents({
            next: {
              date:
                ref.providerRef === 'AAPL'
                  ? '2026-08-10T00:00:00.000Z'
                  : '2026-07-25T00:00:00.000Z',
              epsEstimate: 1.42,
              epsActual: null,
              estimated: ref.providerRef === 'AAPL',
            },
          }),
        ),
    });
    const service = createMarketIntelService({
      marketData,
      assetRepo,
      intelRepo: intelRepo([AAPL, MSFT]),
      enabled: true,
      now: BEFORE_ALL,
    });

    const res = await service.earningsCalendar('u1');
    expect(res.available).toBe(true);
    // Ascending by date: MSFT (Jul 25) before AAPL (Aug 10).
    expect(res.entries.map((e) => e.symbol)).toEqual(['MSFT', 'AAPL']);
    const msft = res.entries[0]!;
    expect(msft).toMatchObject({ held: false, watched: true, estimated: false });
    const aapl = res.entries[1]!;
    expect(aapl).toMatchObject({ held: true, watched: false, estimated: true });
  });

  it('drops assets whose provider lacks the earnings capability', async () => {
    const marketData = createStubMarketData({
      earnings: () => cachedIntel(sampleEarningsEvents()),
      // Only AAPL advertises earnings; MSFT does not.
      intelCapabilities: (ref: AssetRef) => ({
        dividends: false,
        earnings: ref.providerRef === 'AAPL',
        news: false,
        splits: false,
      }),
    });
    const service = createMarketIntelService({
      marketData,
      assetRepo,
      intelRepo: intelRepo([AAPL, MSFT]),
      enabled: true,
      now: BEFORE_ALL,
    });
    const res = await service.earningsCalendar('u1');
    expect(res.entries.map((e) => e.symbol)).toEqual(['AAPL']);
  });

  it('drops assets with no dated upcoming report', async () => {
    const marketData = createStubMarketData({
      earnings: () => cachedIntel(sampleEarningsEvents({ next: null })),
    });
    const service = createMarketIntelService({
      marketData,
      assetRepo,
      intelRepo: intelRepo([AAPL]),
      enabled: true,
      now: BEFORE_ALL,
    });
    const res = await service.earningsCalendar('u1');
    expect(res.available).toBe(true);
    expect(res.entries).toEqual([]);
  });

  it('degrades one bad upstream to no-entry, never throwing', async () => {
    const marketData = createStubMarketData({
      earnings: (ref: AssetRef) => {
        if (ref.providerRef === 'MSFT') throw new Error('provider down');
        return cachedIntel(
          sampleEarningsEvents({
            next: {
              date: '2026-08-10T00:00:00.000Z',
              epsEstimate: 1,
              epsActual: null,
              estimated: true,
            },
          }),
        );
      },
    });
    const service = createMarketIntelService({
      marketData,
      assetRepo,
      intelRepo: intelRepo([AAPL, MSFT]),
      enabled: true,
      now: BEFORE_ALL,
    });
    const res = await service.earningsCalendar('u1');
    expect(res.entries.map((e) => e.symbol)).toEqual(['AAPL']);
  });

  it('drops a report that already happened and keeps the genuinely upcoming one', async () => {
    const marketData = createStubMarketData({
      earnings: (ref: AssetRef) =>
        cachedIntel(
          sampleEarningsEvents({
            next: {
              // MSFT reported a fortnight ago — the keystone can serve that
              // payload stale for days once the provider breaker opens, and
              // being the smallest key it would otherwise HEAD the panel.
              date:
                ref.providerRef === 'MSFT'
                  ? '2026-07-29T00:00:00.000Z'
                  : '2026-08-20T00:00:00.000Z',
              epsEstimate: 1.42,
              epsActual: null,
              estimated: true,
            },
          }),
        ),
    });
    const service = createMarketIntelService({
      marketData,
      assetRepo,
      intelRepo: intelRepo([AAPL, MSFT]),
      enabled: true,
      now: clock('2026-08-15T09:30:00.000Z'),
    });

    const res = await service.earningsCalendar('u1');
    expect(res.available).toBe(true);
    expect(res.entries.map((e) => e.symbol)).toEqual(['AAPL']);
  });

  it('keeps a report dated exactly today — the boundary is "before today"', async () => {
    const marketData = createStubMarketData({
      earnings: nextOn('2026-08-15T00:00:00.000Z'),
    });
    const service = createMarketIntelService({
      marketData,
      assetRepo,
      intelRepo: intelRepo([AAPL]),
      enabled: true,
      // Later in the same UTC day than the report's own timestamp.
      now: clock('2026-08-15T21:45:00.000Z'),
    });

    const res = await service.earningsCalendar('u1');
    expect(res.entries.map((e) => e.symbol)).toEqual(['AAPL']);
  });

  it('defaults the clock to the wall clock when no `now` is injected', async () => {
    const marketData = createStubMarketData({
      earnings: nextOn(new Date(Date.now() - 3 * 86_400_000).toISOString()),
    });
    const service = createMarketIntelService({
      marketData,
      assetRepo,
      intelRepo: intelRepo([AAPL]),
      enabled: true,
    });

    // No `now` in the deps ⇒ Date.now, so a report three days old is dropped.
    expect((await service.earningsCalendar('u1')).entries).toEqual([]);
  });

  it('is invisible (available:false, empty) when the gate is off', async () => {
    const marketData = createStubMarketData({
      earnings: () => cachedIntel(sampleEarningsEvents()),
    });
    const service = createMarketIntelService({
      marketData,
      assetRepo,
      intelRepo: intelRepo([AAPL, MSFT]),
      enabled: false,
    });
    const res = await service.earningsCalendar('u1');
    expect(res).toEqual({ available: false, entries: [] });
  });

  it('does not mark a book inside the cap as truncated', async () => {
    const marketData = createStubMarketData({ earnings: nextOn('2026-08-10T00:00:00.000Z') });
    const service = createMarketIntelService({
      marketData,
      assetRepo,
      intelRepo: intelRepo([AAPL, MSFT]),
      enabled: true,
      now: BEFORE_ALL,
    });

    expect((await service.earningsCalendar('u1')).truncated).toBeUndefined();
  });
});

/** A synthetic book of `count` watch-only assets, symbols W000…, ids a-w000…. */
function watchBook(count: number): UserIntelAsset[] {
  return Array.from({ length: count }, (_, i) => {
    const suffix = String(i).padStart(3, '0');
    return {
      assetId: `a-w${suffix}`,
      symbol: `W${suffix}`,
      name: `Watched ${suffix}`,
      providerId: 'yahoo',
      providerRef: `W${suffix}`,
      held: false,
      watched: true,
    };
  });
}

describe('marketIntel.earningsCalendar — provider fan-out budget (§5.3)', () => {
  it('caps the provider calls at MARKET_INTEL_ROLLUP_MAX_ASSETS for a 200-asset book, and says it truncated', async () => {
    const marketData = createStubMarketData({ earnings: nextOn('2026-08-10T00:00:00.000Z') });
    const service = createMarketIntelService({
      marketData,
      assetRepo,
      intelRepo: intelRepo(watchBook(200)),
      enabled: true,
      now: BEFORE_ALL,
    });

    const res = await service.earningsCalendar('u1');
    expect(marketData.calls.earnings).toBe(MARKET_INTEL_ROLLUP_MAX_ASSETS);
    expect(res.entries).toHaveLength(MARKET_INTEL_ROLLUP_MAX_ASSETS);
    // The partial roll-up announces itself rather than passing as complete.
    expect(res.truncated).toBe(true);
  });

  it('keeps held positions over watch-only assets, then symbol order — deterministically', async () => {
    const marketData = createStubMarketData({ earnings: nextOn('2026-08-10T00:00:00.000Z') });
    // One held asset whose symbol sorts LAST, plus a full cap's worth of
    // watch-only ones: the held row must still survive the truncation.
    const held: UserIntelAsset = {
      assetId: 'a-zzz',
      symbol: 'ZZZ',
      name: 'Held last alphabetically',
      providerId: 'yahoo',
      providerRef: 'ZZZ',
      held: true,
      watched: false,
    };
    const service = createMarketIntelService({
      marketData,
      assetRepo,
      intelRepo: intelRepo([...watchBook(MARKET_INTEL_ROLLUP_MAX_ASSETS), held]),
      enabled: true,
      now: BEFORE_ALL,
    });

    const res = await service.earningsCalendar('u1');
    expect(res.truncated).toBe(true);
    const symbols = res.entries.map((e) => e.symbol).sort();
    expect(symbols).toHaveLength(MARKET_INTEL_ROLLUP_MAX_ASSETS);
    expect(symbols).toContain('ZZZ');
    // …and the watch-only survivors are the alphabetically first ones, so the
    // selection is reproducible rather than "whatever the DB returned first".
    expect(symbols.filter((s) => s !== 'ZZZ')).toEqual(
      watchBook(MARKET_INTEL_ROLLUP_MAX_ASSETS - 1).map((a) => a.symbol),
    );
  });
});
