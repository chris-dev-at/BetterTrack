import { describe, expect, it } from 'vitest';

import {
  assetRefSchema,
  assetSearchResultSchema,
  currencyCodeSchema,
  historyIntervalSchema,
  historyRangeSchema,
  pricePointSchema,
  quoteSchema,
} from './market';

describe('market contracts', () => {
  it('accepts a valid asset ref and rejects empty parts', () => {
    expect(assetRefSchema.safeParse({ providerId: 'yahoo', providerRef: 'BAYN.DE' }).success).toBe(
      true,
    );
    expect(assetRefSchema.safeParse({ providerId: '', providerRef: 'x' }).success).toBe(false);
    expect(assetRefSchema.safeParse({ providerId: 'y', providerRef: 'x', extra: 1 }).success).toBe(
      false,
    ); // strict
  });

  it('validates ISO-4217 currency codes', () => {
    expect(currencyCodeSchema.safeParse('EUR').success).toBe(true);
    expect(currencyCodeSchema.safeParse('eur').success).toBe(false);
    expect(currencyCodeSchema.safeParse('EU').success).toBe(false);
  });

  it('enumerates ranges and intervals', () => {
    expect(historyRangeSchema.options).toContain('1Y');
    expect(historyIntervalSchema.options).toContain('1d');
  });

  it('validates a quote and a price point', () => {
    expect(
      quoteSchema.safeParse({
        price: 100,
        currency: 'EUR',
        prevClose: 99,
        dayChangePct: 1,
        asOf: '2026-06-15T10:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      pricePointSchema.safeParse({ time: '2026-06-15T00:00:00.000Z', close: 100 }).success,
    ).toBe(true);
    expect(pricePointSchema.safeParse({ time: 'not-a-date', close: 1 }).success).toBe(false);
  });

  it('validates a search result with a type badge', () => {
    expect(
      assetSearchResultSchema.safeParse({
        providerId: 'yahoo',
        providerRef: 'NVDA',
        symbol: 'NVDA',
        name: 'NVIDIA',
        exchange: 'NASDAQ',
        type: 'stock',
        currency: 'USD',
      }).success,
    ).toBe(true);
  });
});
