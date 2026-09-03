import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assets, priceHistory } from '../../schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import { createAssetRepository } from '../assetRepository';
import { createPortfolioRepository } from '../portfolioRepository';
import { createPriceJobsRepository } from '../priceJobsRepository';

/**
 * The repository-level reads that decide whether a stored price row counts
 * (§16 2026-09-03, #1694). `price_history` now holds two kinds of number: raw
 * traded closes, which may value an as-transacted quantity, and pre-rule
 * `adjusted` closes, which may not. Every probe that answers "does this asset
 * have usable history?" has to mean the first kind — otherwise migration 0110
 * leaves the durable fallback layer permanently empty for every asset that
 * existed before the rule, with nothing to refill it.
 */

const LEGACY = '019c9000-0000-7000-8000-000000000001';
const MIXED = '019c9000-0000-7000-8000-000000000002';

describe('price-basis probes', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await createTestApp();
    await h.db.insert(assets).values([
      {
        id: LEGACY,
        providerId: 'yahoo',
        providerRef: 'BAYN.DE',
        type: 'stock',
        symbol: 'BAYN.DE',
        name: 'Bayer AG',
        currency: 'EUR',
      },
      {
        id: MIXED,
        providerId: 'yahoo',
        providerRef: 'AAPL',
        type: 'stock',
        symbol: 'AAPL',
        name: 'Apple',
        currency: 'USD',
      },
    ]);
    await h.db.insert(priceHistory).values([
      // Everything this asset has is pre-rule: invisible to the value engine.
      { assetId: LEGACY, date: '2026-01-05', close: '24.1', basis: 'adjusted' },
      { assetId: LEGACY, date: '2026-01-06', close: '24.4', basis: 'adjusted' },
      // Partly repaired: an old adjusted row plus a newer raw one.
      { assetId: MIXED, date: '2026-01-05', close: '180', basis: 'adjusted' },
      { assetId: MIXED, date: '2026-01-06', close: '190', basis: 'unadjusted' },
    ]);
  });

  afterEach(async () => {
    await h.dispose();
  });

  it('hasPriceHistory ignores pre-rule rows, so the next reference re-warms the asset', async () => {
    const repo = createAssetRepository(h.db);
    expect(await repo.hasPriceHistory(LEGACY)).toBe(false);
    expect(await repo.hasPriceHistory(MIXED)).toBe(true);
  });

  it('latestClosesForAssets never carries an adjusted close into the fresh today point', async () => {
    const repo = createPortfolioRepository(h.db);
    const latest = await repo.latestClosesForAssets([LEGACY, MIXED]);
    // The legacy asset has no usable close at all — absent, so the caller
    // carries yesterday's snapshot value forward instead of mixing bases.
    expect(latest.has(LEGACY)).toBe(false);
    expect(latest.get(MIXED)).toBe(190);
  });

  it('listAssetsOffBasis finds every asset still holding pre-rule rows', async () => {
    const repo = createPriceJobsRepository(h.db);
    expect((await repo.listAssetsOffBasis([LEGACY, MIXED])).sort()).toEqual([LEGACY, MIXED].sort());
    expect(await repo.listAssetsOffBasis([])).toEqual([]);
  });

  it('deleteOffBasisRows drops exactly the unusable rows of one asset', async () => {
    const repo = createPriceJobsRepository(h.db);
    expect(await repo.deleteOffBasisRows(MIXED)).toBe(1);

    const remaining = await h.db
      .select({ date: priceHistory.date, basis: priceHistory.basis })
      .from(priceHistory)
      .where(eq(priceHistory.assetId, MIXED));
    expect(remaining).toEqual([{ date: '2026-01-06', basis: 'unadjusted' }]);
    // Scoped to the asset it was called for; the other one is untouched.
    expect(await repo.listAssetsOffBasis([LEGACY, MIXED])).toEqual([LEGACY]);
  });
});
