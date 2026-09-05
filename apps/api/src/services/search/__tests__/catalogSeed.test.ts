import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createAssetRepository } from '../../../data/repositories/assetRepository';
import * as schema from '../../../data/schema';
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
    expect(first).toEqual({ created: 2, existing: 0, refreshed: 0 });

    const dax = await repo.findGlobal('yahoo', '^GDAXI');
    expect(dax).not.toBeNull();
    expect(dax!.ownerId).toBeNull();

    // Re-seeding (every boot) with unchanged entries writes nothing at all.
    const second = await seedAssetCatalog(repo, ENTRIES);
    expect(second).toEqual({ created: 0, existing: 2, refreshed: 0 });

    // Seeded rows are immediately searchable, catalog-first.
    const { matches } = await repo.searchCatalog('00000000-0000-7000-8000-000000000000', 'dax', 20);
    expect(matches.map((m) => m.symbol)).toEqual(['^GDAXI']);
  });

  it('corrects an existing row when the shipped entry changed, in place (#1810)', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const repo = createAssetRepository(h.db);

    await seedAssetCatalog(repo, ENTRIES);
    const before = await repo.findGlobal('yahoo', 'BAYN.DE');

    // The shipped list ships a correction in the next release: a renamed
    // issuer, a re-listed exchange, a fixed currency. Before #1810 every one of
    // those was a no-op on an existing install — `ON CONFLICT DO NOTHING` and
    // no other writer — so the wrong `name` was what search returned AND ranked
    // on, for good.
    const corrected: CatalogSeedEntry[] = [
      { ...ENTRIES[0]!, name: 'Bayer Aktiengesellschaft', exchange: 'XFRA', currency: 'USD' },
      ENTRIES[1]!,
    ];
    const third = await seedAssetCatalog(repo, corrected);
    expect(third).toEqual({ created: 0, existing: 2, refreshed: 1 });

    const after = await repo.findGlobal('yahoo', 'BAYN.DE');
    expect(after).toMatchObject({
      name: 'Bayer Aktiengesellschaft',
      exchange: 'XFRA',
      currency: 'USD',
    });
    // In place, not re-identified: the row keeps its id — every transaction,
    // holding and watchlist row still points at it — and no row was added.
    expect(after!.id).toBe(before!.id);
    expect(await h.db.select({ id: schema.assets.id }).from(schema.assets)).toHaveLength(2);

    // …and the corrected name is what the catalog read now ranks on.
    const { matches } = await repo.searchCatalog(
      '00000000-0000-7000-8000-000000000000',
      'aktiengesellschaft',
      20,
    );
    expect(matches.map((m) => m.providerRef)).toEqual(['BAYN.DE']);
  });

  it('compares a NULL exchange rather than always rewriting it (#1810)', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const repo = createAssetRepository(h.db);
    // `exchange` is the one nullable column in the refresh set, so its
    // `IS DISTINCT FROM` is the one that has to hold a null on either side —
    // both to keep an unchanged re-seed silent (the watermark is stamped per
    // content-changing statement) and to let null↔value actually correct.
    const unlisted: CatalogSeedEntry = { ...ENTRIES[0]!, exchange: null };

    expect(await seedAssetCatalog(repo, [unlisted])).toEqual({
      created: 1,
      existing: 0,
      refreshed: 0,
    });
    expect(await seedAssetCatalog(repo, [unlisted])).toEqual({
      created: 0,
      existing: 1,
      refreshed: 0,
    });

    expect(await seedAssetCatalog(repo, [ENTRIES[0]!])).toEqual({
      created: 0,
      existing: 1,
      refreshed: 1,
    });
    expect(await repo.findGlobal('yahoo', 'BAYN.DE')).toMatchObject({ exchange: 'XETRA' });

    expect(await seedAssetCatalog(repo, [unlisted])).toEqual({
      created: 0,
      existing: 1,
      refreshed: 1,
    });
    expect(await repo.findGlobal('yahoo', 'BAYN.DE')).toMatchObject({ exchange: null });
  });

  it('never overwrites a user’s custom asset with a global refresh (§10, #1810)', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const repo = createAssetRepository(h.db);
    const user = await h.seedUser({ email: 'refresh@s.test', username: 'refresh' });

    await seedAssetCatalog(repo, ENTRIES);
    // A custom asset that collides with the seed entry on (provider, ref) —
    // permitted, because the global uniqueness index is partial on
    // `owner_id IS NULL`. It is the caller's own row and no catalog write may
    // touch it.
    const [mine] = await h.db
      .insert(schema.assets)
      .values({
        providerId: 'yahoo',
        providerRef: 'BAYN.DE',
        ownerId: user.id,
        type: 'custom',
        symbol: 'BAYN.DE',
        name: 'My Bayer shares (private note)',
        exchange: null,
        currency: 'CHF',
      })
      .returning();

    const result = await seedAssetCatalog(repo, [
      { ...ENTRIES[0]!, name: 'Bayer Aktiengesellschaft', currency: 'USD' },
    ]);
    expect(result).toEqual({ created: 0, existing: 1, refreshed: 1 });

    const untouched = await h.db.select().from(schema.assets).where(eq(schema.assets.id, mine!.id));
    expect(untouched[0]).toMatchObject({
      name: 'My Bayer shares (private note)',
      currency: 'CHF',
      ownerId: user.id,
    });
    // The global twin is the one that moved.
    expect(await repo.findGlobal('yahoo', 'BAYN.DE')).toMatchObject({
      name: 'Bayer Aktiengesellschaft',
      currency: 'USD',
    });
  });
});
