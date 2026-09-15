import { describe, expect, it, vi } from 'vitest';

import {
  createAssetRepository,
  type CatalogSearchMatch,
} from '../../../data/repositories/assetRepository';
import * as schema from '../../../data/schema';
import { createTestApp } from '../../../testing/createTestApp';
import { createStubMarketData } from '../../../testing/marketDataStubs';
import type { CatalogEnrichment } from '../catalogEnrichment';
import { createSearchService } from '../searchService';

const USER = '018f6f00-0000-7000-8000-00000000000a';

const match = (over: Partial<CatalogSearchMatch>): CatalogSearchMatch => ({
  id: '018f6f00-0000-7000-8000-00000000000b',
  providerId: 'yahoo',
  providerRef: 'AAPL',
  symbol: 'AAPL',
  name: 'Apple Inc.',
  exchange: 'NMS',
  currency: 'USD',
  type: 'stock',
  ownerId: null,
  ...over,
});

function makeService(matches: CatalogSearchMatch[]) {
  const assetRepo = {
    searchCatalog: vi.fn(async () => ({
      matches,
      marketMatchTotal: matches.filter((m) => m.ownerId === null).length,
    })),
    catalogWatermark: vi.fn(async () => null),
  } as unknown as Parameters<typeof createSearchService>[0]['assetRepo'];
  const enrichment: CatalogEnrichment = {
    request: vi.fn(async () => false),
    settled: vi.fn(async () => {}),
  } as unknown as CatalogEnrichment;
  return createSearchService({ assetRepo, enrichment });
}

describe('searchService — best-effort market badge (§13.5 V5-P1)', () => {
  it('tags crypto rows as always-open (24/7) and leaves every other type unset', async () => {
    const service = makeService([
      match({ symbol: 'BTC-USD', type: 'crypto' }),
      match({ symbol: 'AAPL', type: 'stock' }),
      match({ symbol: 'IWDA', type: 'etf' }),
    ]);

    const { results } = await service.search(USER, 'a');

    const bySymbol = new Map(results.map((r) => [r.symbol, r.marketState]));
    // Crypto trades 24/7 — the one state knowable without a quote fetch (§6.2).
    expect(bySymbol.get('BTC-USD')).toBe('open');
    // No synchronous provider call on search ⇒ no live state for exchange-traded
    // assets; the row renders no (possibly wrong) badge.
    expect(bySymbol.get('AAPL')).toBeUndefined();
    expect(bySymbol.get('IWDA')).toBeUndefined();
  });

  it('supports a catalog-only pass without starting provider enrichment', async () => {
    const assetRepo = {
      searchCatalog: vi.fn(async () => ({ matches: [], marketMatchTotal: 0 })),
      catalogWatermark: vi.fn(async () => null),
    } as unknown as Parameters<typeof createSearchService>[0]['assetRepo'];
    const enrichment: CatalogEnrichment = {
      request: vi.fn(async () => true),
      settled: vi.fn(async () => {}),
    };
    const service = createSearchService({ assetRepo, enrichment });

    await expect(service.search(USER, 'missing', { allowEnrichment: false })).resolves.toEqual({
      results: [],
      enriching: false,
    });
    expect(enrichment.request).not.toHaveBeenCalled();
  });
});

describe('searchService — "thin" is a catalog property, not a window one (#1794)', () => {
  /** A repo whose display window and catalog-wide market total disagree. */
  function makeService(page: { matches: CatalogSearchMatch[]; marketMatchTotal: number }) {
    const assetRepo = {
      searchCatalog: vi.fn(async () => page),
      catalogWatermark: vi.fn(async () => null),
    } as unknown as Parameters<typeof createSearchService>[0]['assetRepo'];
    const enrichment: CatalogEnrichment = {
      request: vi.fn(async () => true),
      settled: vi.fn(async () => {}),
    };
    const budget = { admit: vi.fn(async () => true) };
    return {
      service: createSearchService({ assetRepo, enrichment, enrichmentBudget: budget }),
      enrichment,
      budget,
    };
  }

  it("does not enrich when the catalog holds market matches the caller's custom rows crowded out", async () => {
    // The §6.2 display window is twenty rows and this caller owns twenty custom
    // assets matching the word — so ZERO market rows fit, while the catalog
    // itself holds three.
    const { service, enrichment, budget } = makeService({
      matches: Array.from({ length: 20 }, (_, i) =>
        match({ symbol: `GOLDBAR${i}`, name: `Gold bar #${i}`, ownerId: USER, type: 'custom' }),
      ),
      marketMatchTotal: 3,
    });

    await expect(service.search(USER, 'gold')).resolves.toMatchObject({ enriching: false });
    expect(enrichment.request).not.toHaveBeenCalled();
    // …and the budget was never charged for the fan-out that never happened.
    expect(budget.admit).not.toHaveBeenCalled();
  });

  it('still enriches when the catalog genuinely holds too few market matches', async () => {
    const { service, enrichment } = makeService({
      matches: [match({ symbol: 'GC=F', name: 'Gold' })],
      marketMatchTotal: 1,
    });

    await expect(service.search(USER, 'gold')).resolves.toMatchObject({ enriching: true });
    expect(enrichment.request).toHaveBeenCalledWith('gold');
  });
});

describe('searchService — the freshness stamp never runs ahead of the body (#1810)', () => {
  it('reads the watermark BEFORE the body, so an interleaved write cannot 304 it away', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const real = createAssetRepository(h.db);
    const user = await h.seedUser({ email: 'freshness@s.test', username: 'freshness' });
    const insert = (symbol: string) =>
      h.db.insert(schema.assets).values({
        providerId: 'yahoo',
        providerRef: symbol,
        ownerId: null,
        type: 'stock' as const,
        symbol,
        name: `${symbol} Corp`,
        exchange: 'XETRA',
        currency: 'EUR',
      });
    for (const symbol of ['CONDA', 'CONDB', 'CONDC']) await insert(symbol);

    // A catalog write commits between the two reads — a background enrichment
    // landing its rows, or any other account's catalog write, since the stamp
    // is instance-wide. It fires after whichever read runs FIRST, so it lands
    // in the gap whatever the order is.
    const order: string[] = [];
    let interleaved = false;
    const afterFirstRead = async () => {
      if (interleaved) return;
      interleaved = true;
      await insert('CONDX');
    };
    const assetRepo = {
      searchCatalog: async (...args: Parameters<typeof real.searchCatalog>) => {
        order.push('searchCatalog');
        const page = await real.searchCatalog(...args);
        await afterFirstRead();
        return page;
      },
      catalogWatermark: async (...args: Parameters<typeof real.catalogWatermark>) => {
        order.push('catalogWatermark');
        const stamp = await real.catalogWatermark(...args);
        await afterFirstRead();
        return stamp;
      },
    } as unknown as Parameters<typeof createSearchService>[0]['assetRepo'];
    const service = createSearchService({
      assetRepo,
      enrichment: { request: vi.fn(async () => false), settled: vi.fn(async () => {}) },
    });

    const response = await service.searchWithFreshness(user.id, 'COND');

    expect(interleaved).toBe(true);
    expect(order).toEqual(['catalogWatermark', 'searchCatalog']);
    // The body carries the interleaved row…
    expect(response.results.map((r) => r.symbol)).toContain('CONDX');
    // …so the stamp it ships must be OLDER than the catalog state it describes.
    // Body-first would ship the pre-write body under the post-write stamp, and
    // the client's next `If-Modified-Since` — the rail with no ETag to fall back
    // on — would be answered 304 with an empty body while its cached copy still
    // said `enriching: true`, until some unrelated catalog write moved the
    // stamp again.
    const current = await real.catalogWatermark(user.id);
    expect(response.freshness).not.toBeNull();
    expect(response.freshness!.getTime()).toBeLessThan(current!.getTime());
  });
});
