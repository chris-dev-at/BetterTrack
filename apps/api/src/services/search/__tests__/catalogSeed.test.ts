import { describe, expect, it } from 'vitest';

import { createAssetRepository } from '../../../data/repositories/assetRepository';
import { createTestApp } from '../../../testing/createTestApp';
import { createStubMarketData } from '../../../testing/marketDataStubs';
import { seedAssetCatalog, type CatalogSeedEntry } from '../catalogSeed';

const ENTRIES: CatalogSeedEntry[] = [
  {
    providerId: 'yahoo',
    providerRef: 'BAYN.DE',
    type: 'stock',
    symbol: 'BAYN.DE',
    name: 'Bayer AG',
    exchange: 'XETRA',
    currency: 'EUR',
  },
  {
    providerId: 'yahoo',
    providerRef: '^GDAXI',
    type: 'index',
    symbol: '^GDAXI',
    name: 'DAX Performance Index',
    exchange: 'XETRA',
    currency: 'EUR',
  },
];

describe('seedAssetCatalog (§6.2(c) plumbing)', () => {
  it('inserts seed entries as global rows, idempotently across re-runs', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const repo = createAssetRepository(h.db);

    const first = await seedAssetCatalog(repo, ENTRIES);
    expect(first).toEqual({ created: 2, existing: 0 });

    const dax = await repo.findGlobal('yahoo', '^GDAXI');
    expect(dax).not.toBeNull();
    expect(dax!.ownerId).toBeNull();

    // Re-seeding (every boot) must be a no-op per existing entry.
    const second = await seedAssetCatalog(repo, ENTRIES);
    expect(second).toEqual({ created: 0, existing: 2 });

    // Seeded rows are immediately searchable, catalog-first.
    const matches = await repo.searchCatalog('00000000-0000-7000-8000-000000000000', 'dax', 20);
    expect(matches.map((m) => m.symbol)).toEqual(['^GDAXI']);
  });
});
