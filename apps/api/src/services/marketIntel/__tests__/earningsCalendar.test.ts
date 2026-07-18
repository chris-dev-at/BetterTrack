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

// assetRepo is unused by earningsCalendar (it aggregates via intelRepo); a
// throwing stub proves the calendar path never touches per-asset resolution.
const assetRepo = {
  findByIdForUser: () => {
    throw new Error('unexpected assetRepo call');
  },
} as unknown as AssetRepository;

function intelRepo(assets: UserIntelAsset[]) {
  return { listUserWatchAndHoldAssets: async () => assets };
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
    });
    const res = await service.earningsCalendar('u1');
    expect(res.entries.map((e) => e.symbol)).toEqual(['AAPL']);
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
});
