import type { AssetProvider } from '../../../providers/AssetProvider';
import type { AssetRef, NewsHeadline } from '@bettertrack/contracts';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { describe, expect, it } from 'vitest';

import type { AssetRepository } from '../../../data/repositories/assetRepository';
import type { UserIntelAsset } from '../../../data/repositories/marketIntelRepository';
import { createMarketDataService } from '../../../providers/marketDataService';
import { createProviderRegistry } from '../../../providers/registry';
import { cachedIntel, createStubMarketData } from '../../../testing/marketDataStubs';
import { createMarketIntelService } from '../marketIntelService';
import { MARKET_INTEL_ROLLUP_MAX_ASSETS } from '../rollupBudget';

// newsDigest aggregates via intelRepo (held + watched), never per-asset
// resolution — a throwing assetRepo proves the digest path never touches it.
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
    // A book inside the cap is never marked truncated.
    expect(res.truncated).toBeUndefined();
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

describe('marketIntel.newsDigest — provider fan-out budget (§5.3)', () => {
  it('caps the provider calls at MARKET_INTEL_ROLLUP_MAX_ASSETS for a 200-asset book, and says it truncated', async () => {
    const marketData = createStubMarketData({
      news: () => cachedIntel([headline('n', '2026-06-20T08:00:00.000Z')]),
    });
    const service = createMarketIntelService({
      marketData,
      assetRepo,
      intelRepo: intelRepo(watchBook(200)),
      enabled: true,
    });

    const res = await service.newsDigest('u1');
    expect(marketData.calls.news).toBe(MARKET_INTEL_ROLLUP_MAX_ASSETS);
    expect(res.groups).toHaveLength(MARKET_INTEL_ROLLUP_MAX_ASSETS);
    // The partial roll-up announces itself rather than passing as complete.
    expect(res.truncated).toBe(true);
  });

  it('keeps held positions over watch-only assets, then symbol order — deterministically', async () => {
    const marketData = createStubMarketData({
      news: (ref: AssetRef) => cachedIntel([headline(ref.providerRef, '2026-06-20T08:00:00.000Z')]),
    });
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
    });

    const res = await service.newsDigest('u1');
    expect(res.truncated).toBe(true);
    const symbols = res.groups.map((g) => g.symbol).sort();
    expect(symbols).toHaveLength(MARKET_INTEL_ROLLUP_MAX_ASSETS);
    expect(symbols).toContain('ZZZ');
    // …and the watch-only survivors are the alphabetically first ones, so the
    // selection is reproducible rather than "whatever the DB returned first".
    expect(symbols.filter((s) => s !== 'ZZZ')).toEqual(
      watchBook(MARKET_INTEL_ROLLUP_MAX_ASSETS - 1).map((a) => a.symbol),
    );
  });

  it('a second digest inside the news TTL issues zero new provider calls', async () => {
    // The real cache/coalescing keystone (not the stub): the digest may only be
    // cheap on a repeat load if NEWS_TTL_SECONDS actually absorbs it.
    let upstreamCalls = 0;
    const provider: AssetProvider = {
      id: 'yahoo',
      search: () => Promise.resolve([]),
      getQuote: () => Promise.reject(new Error('unused')),
      getHistory: () => Promise.reject(new Error('unused')),
      getMeta: () => Promise.reject(new Error('unused')),
      getNewsHeadlines: () => {
        upstreamCalls += 1;
        return Promise.resolve([headline('n', '2026-06-20T08:00:00.000Z')]);
      },
    };
    const redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    const marketData = createMarketDataService({
      registry: createProviderRegistry([provider]),
      redis,
    });
    const service = createMarketIntelService({
      marketData,
      assetRepo,
      intelRepo: intelRepo([AAPL, MSFT]),
      enabled: true,
    });

    const first = await service.newsDigest('u1');
    expect(first.groups.map((g) => g.symbol).sort()).toEqual(['AAPL', 'MSFT']);
    expect(upstreamCalls).toBe(2);

    const second = await service.newsDigest('u1');
    expect(second.groups.map((g) => g.symbol).sort()).toEqual(['AAPL', 'MSFT']);
    expect(upstreamCalls).toBe(2);
  });
});
