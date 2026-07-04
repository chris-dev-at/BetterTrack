import { ASSET_TYPES } from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import { createAssetRepository } from '../../../data/repositories/assetRepository';
import { createTestApp } from '../../../testing/createTestApp';
import { createStubMarketData } from '../../../testing/marketDataStubs';
import { CATALOG_SEED_ENTRIES } from '../catalogSeedData';
import { COMMON_SYMBOLS_SEED, seedAssetCatalog } from '../catalogSeed';

/**
 * The shipped §6.2(c) catalog: authored data must satisfy the acceptance
 * criteria of #155 — ≥600 global rows, well-formed entries, and instant local
 * results (no enrichment) for a fixed set of everyday queries including a
 * misspelling that must resolve via the trigram threshold.
 */
const REQUIRED_TYPES = new Set(ASSET_TYPES);

describe('COMMON_SYMBOLS_SEED (§6.2(c) content)', () => {
  it('wires the authored data as the boot seed', () => {
    expect(COMMON_SYMBOLS_SEED).toBe(CATALOG_SEED_ENTRIES);
  });

  it('ships at least 600 well-formed, non-duplicated global rows', () => {
    expect(CATALOG_SEED_ENTRIES.length).toBeGreaterThanOrEqual(600);

    const refs = new Set<string>();
    for (const e of CATALOG_SEED_ENTRIES) {
      expect(e.providerId).toBe('yahoo');
      expect(e.symbol).toBe(e.providerRef); // catalog symbol IS the provider ref
      expect(e.name.trim().length).toBeGreaterThan(0);
      expect(REQUIRED_TYPES.has(e.type)).toBe(true);
      expect(e.type).not.toBe('custom'); // seed is global market assets only
      expect(e.currency).toMatch(/^[A-Z]{3}$/); // fits char(3) NOT NULL column
      const key = `${e.providerId}:${e.providerRef}`;
      expect(refs.has(key)).toBe(false); // no duplicate upsert targets
      refs.add(key);
    }
    expect(refs.size).toBe(CATALOG_SEED_ENTRIES.length);
  });

  it('covers the flagship §6.2(c) symbols by provider ref', () => {
    const refs = new Set(CATALOG_SEED_ENTRIES.map((e) => e.providerRef));
    for (const ref of [
      '^GSPC', // S&P 500 index
      '^GDAXI', // DAX index
      '^ATX', // ATX index
      'AAPL', // S&P 500 constituent
      'SAP.DE', // DAX 40 constituent
      'OMV.VI', // ATX 20 constituent
      'SPY', // flagship US ETF
      'VWCE.DE', // popular UCITS world ETF
      'BTC-USD', // crypto
      'ETH-USD',
      'EURUSD=X', // FX
      'GC=F', // gold commodity
    ]) {
      expect(refs.has(ref)).toBe(true);
    }
  });
});

describe('seedAssetCatalog with the shipped list', () => {
  it('fills the catalog with instant, enrichment-free local hits', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const repo = createAssetRepository(h.db);
    const userId = '00000000-0000-7000-8000-000000000000';

    const first = await seedAssetCatalog(repo, COMMON_SYMBOLS_SEED);
    expect(first.created).toBe(COMMON_SYMBOLS_SEED.length);
    expect(first.existing).toBe(0);

    // Every acceptance query resolves against the local catalog, no provider call.
    const cases: [string, string][] = [
      ['msci world', 'EUNL.DE'],
      ['ethereum', 'ETH-USD'],
      ['etherium', 'ETH-USD'], // fuzzy misspelling must still resolve
      ['apple', 'AAPL'],
      ['dax', '^GDAXI'],
      ['gold', 'GC=F'],
      ['btc', 'BTC-USD'],
    ];
    for (const [query, expectedRef] of cases) {
      const matches = await repo.searchCatalog(userId, query, 20);
      expect(matches.length, `no local results for "${query}"`).toBeGreaterThan(0);
      expect(
        matches.some((m) => m.providerRef === expectedRef),
        `"${query}" did not surface ${expectedRef}`,
      ).toBe(true);
    }

    // Re-seeding every boot is a pure no-op (idempotent upsert, no backfill).
    const second = await seedAssetCatalog(repo, COMMON_SYMBOLS_SEED);
    expect(second).toEqual({ created: 0, existing: COMMON_SYMBOLS_SEED.length });
  });
});
