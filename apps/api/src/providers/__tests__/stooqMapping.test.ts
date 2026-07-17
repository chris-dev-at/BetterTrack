import { describe, expect, it } from 'vitest';

import { mapToStooq, stooqCanServe } from '../stooqMapping';

/**
 * Stooq symbol/currency mapping (§13.5 V5-P1c). Money-critical: the failover
 * source must answer for the SAME instrument in the SAME currency the user chose
 * on Yahoo, or decline. These cases pin the normalized-symbol/currency contract
 * and the money-safe "decline when unsure" scope.
 */
describe('mapToStooq — supported listings', () => {
  it('maps a bare US symbol to `<sym>.us` in USD', () => {
    expect(mapToStooq('AAPL')).toEqual({ symbol: 'aapl.us', currency: 'USD', type: 'stock' });
  });

  it('preserves a class-share dash (BRK-B → brk-b.us), not treated as crypto', () => {
    expect(mapToStooq('BRK-B')).toEqual({ symbol: 'brk-b.us', currency: 'USD', type: 'stock' });
  });

  it('maps a XETRA `.DE` listing to `.de` in EUR', () => {
    expect(mapToStooq('BAYN.DE')).toEqual({ symbol: 'bayn.de', currency: 'EUR', type: 'stock' });
  });

  it('maps the major US/DE indices to Stooq codes with the right currency', () => {
    expect(mapToStooq('^GSPC')).toEqual({ symbol: '^spx', currency: 'USD', type: 'index' });
    expect(mapToStooq('^GDAXI')).toEqual({ symbol: '^dax', currency: 'EUR', type: 'index' });
  });
});

describe('mapToStooq — declined (Yahoo-only, money-safe)', () => {
  it.each([
    ['crypto', 'BTC-USD'],
    ['fx pair', 'EURUSD=X'],
    ['metal spot', 'XAUUSD=X'],
    ['future', 'GC=F'],
    ['unsupported venue (London)', 'BP.L'],
    ['unknown index', '^FTSE'],
    ['empty', '   '],
  ])('declines %s', (_label, ref) => {
    expect(mapToStooq(ref)).toBeNull();
    expect(stooqCanServe(ref)).toBe(false);
  });

  it('stooqCanServe is true exactly for mappable refs', () => {
    expect(stooqCanServe('AAPL')).toBe(true);
    expect(stooqCanServe('BAYN.DE')).toBe(true);
    expect(stooqCanServe('BTC-USD')).toBe(false);
  });
});
