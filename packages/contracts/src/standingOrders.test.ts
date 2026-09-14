import { describe, expect, it } from 'vitest';

import { MAX_TRANSACTION_PRICE } from './portfolio';
import {
  STANDING_ORDER_QUOTE_REFUSAL_VECTORS,
  STANDING_ORDER_QUOTE_VECTOR_CURRENCY,
  standingOrderQuoteRefusal,
} from './standingOrders';

/**
 * The one bookable-quote rule both standing-order engines enforce (#1712): the
 * API's `resolveBookQuote` and the vault twin's materializer/store both call
 * {@link standingOrderQuoteRefusal}, so what may price an automatic buy is
 * defined here once.
 */

const sound = {
  price: 128.4,
  quoteCurrency: 'EUR',
  orderCurrency: 'EUR',
  assetCurrency: 'EUR',
};

describe('standingOrderQuoteRefusal', () => {
  it('accepts a finite, positive, in-currency quote below the transaction ceiling', () => {
    expect(standingOrderQuoteRefusal(sound)).toBeNull();
    expect(standingOrderQuoteRefusal({ ...sound, price: MAX_TRANSACTION_PRICE - 1 })).toBeNull();
    expect(standingOrderQuoteRefusal({ ...sound, price: 0.0001 })).toBeNull();
  });

  it.each([
    ['NaN', Number.NaN, 'price-not-finite'],
    ['Infinity', Number.POSITIVE_INFINITY, 'price-not-finite'],
    ['zero', 0, 'price-not-positive'],
    ['negative', -1, 'price-not-positive'],
    ['at the ceiling', MAX_TRANSACTION_PRICE, 'price-above-ceiling'],
    ['above the ceiling', MAX_TRANSACTION_PRICE * 2, 'price-above-ceiling'],
  ] as const)('refuses a %s price', (_label, price, refusal) => {
    expect(standingOrderQuoteRefusal({ ...sound, price })).toBe(refusal);
  });

  it('refuses a quote that any of the three currencies disagrees with', () => {
    // A stored price is a bare number, converted later at the ASSET's currency,
    // so agreement is required across quote, order and asset — and an
    // unresolvable asset currency is not agreement.
    expect(standingOrderQuoteRefusal({ ...sound, quoteCurrency: 'USD' })).toBe('currency-mismatch');
    expect(standingOrderQuoteRefusal({ ...sound, assetCurrency: 'USD' })).toBe('currency-mismatch');
    expect(standingOrderQuoteRefusal({ ...sound, assetCurrency: null })).toBe('currency-mismatch');
    expect(
      standingOrderQuoteRefusal({
        ...sound,
        quoteCurrency: 'USD',
        orderCurrency: 'USD',
        assetCurrency: 'USD',
      }),
    ).toBeNull();
  });

  it('refuses every shared conformance vector with its declared reason', () => {
    expect(STANDING_ORDER_QUOTE_REFUSAL_VECTORS.length).toBeGreaterThan(0);
    for (const vector of STANDING_ORDER_QUOTE_REFUSAL_VECTORS) {
      expect(
        standingOrderQuoteRefusal({
          price: vector.price,
          quoteCurrency: vector.currency,
          orderCurrency: STANDING_ORDER_QUOTE_VECTOR_CURRENCY,
          assetCurrency: STANDING_ORDER_QUOTE_VECTOR_CURRENCY,
        }),
      ).toBe(vector.refusal);
    }
  });
});
