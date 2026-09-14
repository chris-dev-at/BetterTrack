import { describe, expect, it } from 'vitest';

import type { AssetMeta, AssetRef, CachedResult, PricePoint, Quote } from '@bettertrack/contracts';

import { createAssetRepository } from '../../../data/repositories/assetRepository';
import * as schema from '../../../data/schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import {
  createStubMarketData,
  type StubMarketDataControls,
} from '../../../testing/marketDataStubs';
import { createCurrencyService } from '../../currency/currencyService';
import { createAssetService } from '../assetService';

/**
 * Denomination discipline on the asset read path (§5.4, #1875).
 *
 * A catalog row's currency is the catalog's BELIEF about an instrument; a
 * provider-discovered row starts life with a search projection's value, which
 * can be a plain default. The prices, however, come from the provider and are
 * denominated in the provider's own normalised currency. Converting or
 * labelling those numbers through the row is how a EUR price gets rendered as
 * if it had been converted from USD.
 */

const FETCHED_AT = Date.parse('2026-06-20T10:00:00.000Z');

const cached = <T>(value: T): CachedResult<T> => ({ value, stale: false, asOf: FETCHED_AT });

const quote = (price: number, currency: string): CachedResult<Quote> =>
  cached({
    price,
    currency,
    prevClose: null,
    dayChangePct: null,
    asOf: '2026-06-20T09:59:00.000Z',
  });

const meta = (ref: AssetRef, currency: string): CachedResult<AssetMeta> =>
  cached({
    providerId: ref.providerId,
    providerRef: ref.providerRef,
    symbol: ref.providerRef,
    name: ref.providerRef,
    exchange: null,
    currency,
    type: 'index',
  });

const history = (): CachedResult<PricePoint[]> =>
  cached([
    { time: '2026-05-20T00:00:00.000Z', close: 11_000 },
    { time: '2026-06-20T00:00:00.000Z', close: 11_500 },
  ]);

/**
 * A row in the state the defect needs: a provider-discovered EUR index the
 * catalog stored as USD (`^IBEX` — no venue suffix, an exchange code the
 * projection's table does not know).
 */
async function seedMisdenominatedAsset(h: TestHarness, currency = 'USD') {
  const [row] = await h.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: '^IBEX',
      ownerId: null,
      type: 'index',
      symbol: '^IBEX',
      name: 'IBEX 35',
      exchange: 'MCE',
      currency,
    })
    .returning();
  if (!row) throw new Error('failed to seed asset');
  return row;
}

/** The service under test, over a real repository and the real §5.4 keystone. */
async function harness(controls: StubMarketDataControls, rates: Record<string, number> = {}) {
  const h = await createTestApp({ marketData: createStubMarketData() });
  const user = await h.seedUser();
  const marketData = createStubMarketData(controls);
  let fxCalls = 0;
  const currencyService = createCurrencyService({
    source: {
      async getSpotRate(from, to) {
        fxCalls += 1;
        const rate = rates[`${from}${to}`];
        if (rate === undefined) throw new Error(`no stub rate for ${from}->${to}`);
        return rate;
      },
      async getHistoricalRate(from, to) {
        fxCalls += 1;
        const rate = rates[`${from}${to}`];
        if (rate === undefined) throw new Error(`no stub rate for ${from}->${to}`);
        return rate;
      },
    },
  });
  const service = createAssetService({
    marketData,
    assetRepo: createAssetRepository(h.db),
    currencyService,
  });
  return { h, user, marketData, service, fxCalls: () => fxCalls };
}

describe("assetService.getDetail — the price is converted from the quote's own currency", () => {
  it('applies no conversion when the QUOTE is already in the base, whatever the row says', async () => {
    const { h, user, service, fxCalls } = await harness({
      quote: () => quote(11_500, 'EUR'),
    });
    const asset = await seedMisdenominatedAsset(h);

    const detail = await service.getDetail(user.id, asset.id, { baseCurrency: 'EUR' });

    // Row says USD, quote says EUR, base is EUR: the price needs no conversion
    // at all. Reading the row here would have converted an EUR price as if it
    // were USD — ~8 % off, rendered beside the correct native price.
    expect(detail.quote?.currency).toBe('EUR');
    expect(detail.asset.currency).toBe('USD');
    expect(detail).not.toHaveProperty('eurPrice');
    expect(fxCalls()).toBe(0);
  });

  it('converts from the quote currency when that is the foreign one', async () => {
    const { h, user, service } = await harness({ quote: () => quote(100, 'USD') }, { USDEUR: 0.9 });
    // The mirror case: the row claims EUR, the quote is genuinely USD — the
    // conversion must happen, and at the quote's rate.
    const asset = await seedMisdenominatedAsset(h, 'EUR');

    const detail = await service.getDetail(user.id, asset.id, { baseCurrency: 'EUR' });

    expect(detail.baseCurrency).toBe('EUR');
    expect(detail.eurPrice).toBeCloseTo(90, 6);
  });

  it('degrades to a null converted price when the rate is unavailable', async () => {
    const { h, user, service } = await harness({ quote: () => quote(100, 'CHF') });
    const asset = await seedMisdenominatedAsset(h);

    const detail = await service.getDetail(user.id, asset.id, { baseCurrency: 'EUR' });
    expect(detail.eurPrice).toBeNull();
  });
});

describe('assetService.getHistory — the series is labelled with the currency its points are in', () => {
  it('labels from the provider, not from the stored row', async () => {
    const { h, user, service, marketData } = await harness({
      history: () => history(),
      meta: (ref) => meta(ref, 'EUR'),
    });
    const asset = await seedMisdenominatedAsset(h);

    const series = await service.getHistory(user.id, asset.id, '1Y');
    expect(series.currency).toBe('EUR');
    expect(series.points).toHaveLength(2);
    expect(marketData.calls.meta).toBe(1);
  });

  it('falls back to the stored row when the provider cannot say', async () => {
    const { h, user, service } = await harness({
      history: () => history(),
      // No `meta` control: the stub throws, exactly like an unreachable provider.
    });
    const asset = await seedMisdenominatedAsset(h);

    const series = await service.getHistory(user.id, asset.id, '1Y');
    expect(series.currency).toBe('USD');
  });

  it('spends no meta read on the sparkline batch, which publishes no currency', async () => {
    const { h, user, service, marketData } = await harness({ history: () => history() });
    const asset = await seedMisdenominatedAsset(h);

    const batch = await service.getSparklines(user.id, [asset.id]);
    expect(batch.sparklines).toHaveLength(1);
    expect(marketData.calls.meta).toBe(0);
  });
});
