import { describe, expect, it, vi } from 'vitest';

import type { CatalogSearchMatch } from '../../../data/repositories/assetRepository';
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
    searchCatalog: vi.fn(async () => matches),
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
});
