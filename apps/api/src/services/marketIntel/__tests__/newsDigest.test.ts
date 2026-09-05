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
import {
  createMarketIntelService,
  NEWS_DIGEST_HEADLINES_PER_GROUP,
  NEWS_DIGEST_MAX_HEADLINES,
} from '../marketIntelService';
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

  it('carries a market-wide article once, attributed to a held asset', async () => {
    // One macro story is the newest headline for every large cap in the book.
    // Repeated per group it made the Home widget (held groups, 2 headlines
    // each) one article wide — #1758.
    const macro = headline('macro-1', '2026-06-21T08:00:00.000Z');
    const marketData = createStubMarketData({
      news: (ref: AssetRef) =>
        cachedIntel(
          ref.providerRef === 'AAPL'
            ? [macro, headline('aapl-own', '2026-06-19T08:00:00.000Z')]
            : [macro, headline('msft-own', '2026-06-20T08:00:00.000Z')],
        ),
    });
    const service = createMarketIntelService({
      marketData,
      assetRepo,
      // MSFT is watch-only and carries the story more recently, but AAPL is
      // HELD — attribution prefers it so the Home widget can still show it.
      intelRepo: intelRepo([AAPL, MSFT]),
      enabled: true,
    });

    const res = await service.newsDigest('u1');
    const all = res.groups.flatMap((g) => g.headlines.map((h) => h.id));
    expect(all.filter((id) => id === 'macro-1')).toHaveLength(1);
    expect(res.groups.find((g) => g.symbol === 'AAPL')?.headlines.map((h) => h.id)).toEqual([
      'macro-1',
      'aapl-own',
    ]);
    expect(res.groups.find((g) => g.symbol === 'MSFT')?.headlines.map((h) => h.id)).toEqual([
      'msft-own',
    ]);
  });

  it('drops a group whose every headline already belongs to another asset', async () => {
    const macro = headline('macro-1', '2026-06-21T08:00:00.000Z');
    const marketData = createStubMarketData({ news: () => cachedIntel([macro]) });
    const service = createMarketIntelService({
      marketData,
      assetRepo,
      intelRepo: intelRepo([AAPL, MSFT]),
      enabled: true,
    });

    const res = await service.newsDigest('u1');
    expect(res.groups.map((g) => g.symbol)).toEqual(['AAPL']);
    expect(res.groups[0]!.headlines.map((h) => h.id)).toEqual(['macro-1']);
  });

  it('bounds a group at the service, not at whichever provider answered', async () => {
    // A stub provider returning far more than the Yahoo provider's own 20: the
    // per-group cap must live in the provider-abstracted service (#1758).
    const flood = Array.from({ length: NEWS_DIGEST_HEADLINES_PER_GROUP * 5 }, (_, i) =>
      headline(
        `n-${String(i).padStart(3, '0')}`,
        `2026-06-${String(1 + (i % 28)).padStart(2, '0')}T08:00:00.000Z`,
      ),
    );
    const marketData = createStubMarketData({
      news: (ref: AssetRef) =>
        cachedIntel(flood.map((h) => ({ ...h, id: `${ref.providerRef}-${h.id}` }))),
    });
    const service = createMarketIntelService({
      marketData,
      assetRepo,
      intelRepo: intelRepo([AAPL, MSFT]),
      enabled: true,
    });

    const res = await service.newsDigest('u1');
    for (const group of res.groups) {
      expect(group.headlines).toHaveLength(NEWS_DIGEST_HEADLINES_PER_GROUP);
    }
    // …and the kept ones are the newest, not the first the provider listed.
    const newest = [...flood]
      .sort((x, y) => (y.publishedAt ?? '').localeCompare(x.publishedAt ?? ''))
      .slice(0, NEWS_DIGEST_HEADLINES_PER_GROUP)
      .map((h) => `AAPL-${h.id}`);
    expect(res.groups.find((g) => g.symbol === 'AAPL')?.headlines.map((h) => h.id)).toEqual(newest);
    // The stated response ceiling holds for the whole digest.
    expect(res.groups.flatMap((g) => g.headlines).length).toBeLessThanOrEqual(
      NEWS_DIGEST_MAX_HEADLINES,
    );
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
      // A distinct article per asset: the cross-group dedupe is exercised
      // elsewhere, and this case is about the provider fan-out budget.
      news: (ref: AssetRef) => cachedIntel([headline(ref.providerRef, '2026-06-20T08:00:00.000Z')]),
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
      getNewsHeadlines: (ref: AssetRef) => {
        upstreamCalls += 1;
        return Promise.resolve([headline(ref.providerRef, '2026-06-20T08:00:00.000Z')]);
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
