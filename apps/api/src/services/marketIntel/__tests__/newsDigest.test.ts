import type { AssetRef, NewsHeadline } from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import type { AssetRepository } from '../../../data/repositories/assetRepository';
import type { UserIntelAsset } from '../../../data/repositories/marketIntelRepository';
import { cachedIntel, createStubMarketData } from '../../../testing/marketDataStubs';
import { createMarketIntelService } from '../marketIntelService';

// newsDigest aggregates via intelRepo (held + watched), never per-asset
// resolution — a throwing assetRepo proves the digest path never touches it.
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

function headline(id: string, publishedAt: string | null): NewsHeadline {
  return {
    id,
    title: `Headline ${id}`,
    publisher: 'Reuters',
    url: `https://example.com/${id}`,
    publishedAt,
  };
}

describe('marketIntel.newsDigest (V5-P5)', () => {
  it('groups held + watched headlines per asset, groups and headlines newest-first', async () => {
    const marketData = createStubMarketData({
      news: (ref: AssetRef) =>
        cachedIntel(
          ref.providerRef === 'AAPL'
            ? [
                headline('aapl-old', '2026-06-18T08:00:00.000Z'),
                headline('aapl-new', '2026-06-20T08:00:00.000Z'),
              ]
            : [headline('msft-1', '2026-06-19T08:00:00.000Z')],
        ),
    });
    const service = createMarketIntelService({
      marketData,
      assetRepo,
      intelRepo: intelRepo([AAPL, MSFT]),
      enabled: true,
    });

    const res = await service.newsDigest('u1');
    expect(res.available).toBe(true);
    // AAPL's newest headline (Jun 20) is newer than MSFT's (Jun 19) ⇒ AAPL first.
    expect(res.groups.map((g) => g.symbol)).toEqual(['AAPL', 'MSFT']);
    const aapl = res.groups[0]!;
    expect(aapl).toMatchObject({ held: true, watched: false });
    // Headlines newest-first within the group.
    expect(aapl.headlines.map((h) => h.id)).toEqual(['aapl-new', 'aapl-old']);
    const msft = res.groups[1]!;
    expect(msft).toMatchObject({ held: false, watched: true });
  });

  it('drops assets whose provider lacks the news capability', async () => {
    const marketData = createStubMarketData({
      news: () => cachedIntel([headline('n', '2026-06-20T08:00:00.000Z')]),
      // Only AAPL advertises news; MSFT does not.
      intelCapabilities: (ref: AssetRef) => ({
        dividends: false,
        earnings: false,
        news: ref.providerRef === 'AAPL',
        splits: false,
      }),
    });
    const service = createMarketIntelService({
      marketData,
      assetRepo,
      intelRepo: intelRepo([AAPL, MSFT]),
      enabled: true,
    });
    const res = await service.newsDigest('u1');
    expect(res.groups.map((g) => g.symbol)).toEqual(['AAPL']);
  });

  it('drops assets with no headlines', async () => {
    const marketData = createStubMarketData({
      news: (ref: AssetRef) =>
        cachedIntel(ref.providerRef === 'AAPL' ? [headline('n', '2026-06-20T08:00:00.000Z')] : []),
    });
    const service = createMarketIntelService({
      marketData,
      assetRepo,
      intelRepo: intelRepo([AAPL, MSFT]),
      enabled: true,
    });
    const res = await service.newsDigest('u1');
    expect(res.groups.map((g) => g.symbol)).toEqual(['AAPL']);
  });

  it('degrades one bad upstream to no-group, never throwing', async () => {
    const marketData = createStubMarketData({
      news: (ref: AssetRef) => {
        if (ref.providerRef === 'MSFT') throw new Error('provider down');
        return cachedIntel([headline('n', '2026-06-20T08:00:00.000Z')]);
      },
    });
    const service = createMarketIntelService({
      marketData,
      assetRepo,
      intelRepo: intelRepo([AAPL, MSFT]),
      enabled: true,
    });
    const res = await service.newsDigest('u1');
    expect(res.groups.map((g) => g.symbol)).toEqual(['AAPL']);
  });

  it('is invisible (available:false, empty) when the gate is off', async () => {
    const marketData = createStubMarketData({
      news: () => cachedIntel([headline('n', '2026-06-20T08:00:00.000Z')]),
    });
    const service = createMarketIntelService({
      marketData,
      assetRepo,
      intelRepo: intelRepo([AAPL, MSFT]),
      enabled: false,
    });
    const res = await service.newsDigest('u1');
    expect(res).toEqual({ available: false, groups: [] });
  });
});
