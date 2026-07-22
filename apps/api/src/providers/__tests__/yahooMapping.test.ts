import { describe, expect, it } from 'vitest';

import {
  currencyForSearchResult,
  mapAssetType,
  mapMarketState,
  normalizeCurrency,
} from '../yahooMapping';

describe('normalizeCurrency (§5.4)', () => {
  it('passes through real ISO codes, upper-casing, scale 1', () => {
    expect(normalizeCurrency('USD')).toEqual({ code: 'USD', priceScale: 1 });
    expect(normalizeCurrency('eur')).toEqual({ code: 'EUR', priceScale: 1 });
    expect(normalizeCurrency('  CHF ')).toEqual({ code: 'CHF', priceScale: 1 });
  });

  it('maps minor units to their major parent with a 0.01 price scale', () => {
    expect(normalizeCurrency('GBp')).toEqual({ code: 'GBP', priceScale: 0.01 });
    expect(normalizeCurrency('GBX')).toEqual({ code: 'GBP', priceScale: 0.01 });
    expect(normalizeCurrency('ZAc')).toEqual({ code: 'ZAR', priceScale: 0.01 });
    expect(normalizeCurrency('ILA')).toEqual({ code: 'ILS', priceScale: 0.01 });
  });

  it('keeps GBP (pounds) distinct from GBp (pence)', () => {
    expect(normalizeCurrency('GBP')).toEqual({ code: 'GBP', priceScale: 1 });
  });

  it('throws on a missing or unmappable currency (fail loud on the money path)', () => {
    expect(() => normalizeCurrency('')).toThrow();
    expect(() => normalizeCurrency(null)).toThrow();
    expect(() => normalizeCurrency('US')).toThrow();
    expect(() => normalizeCurrency('DOLLARS')).toThrow();
  });
});

describe('mapAssetType (§5.5)', () => {
  it.each([
    ['EQUITY', 'stock'],
    ['ETF', 'etf'],
    ['MUTUALFUND', 'etf'],
    ['INDEX', 'index'],
    ['CURRENCY', 'fx'],
    ['CRYPTOCURRENCY', 'crypto'],
    ['FUTURE', 'commodity'],
    ['OPTION', 'stock'],
    ['something-new', 'stock'],
    [undefined, 'stock'],
  ] as const)('maps %s → %s', (input, expected) => {
    expect(mapAssetType(input)).toBe(expected);
  });

  it('types an actual currency pair as fx (§5.5)', () => {
    expect(mapAssetType('CURRENCY', 'EURUSD=X')).toBe('fx');
  });

  it('types a metal spot ref as commodity even though Yahoo reports quoteType CURRENCY (V3-P10c)', () => {
    expect(mapAssetType('CURRENCY', 'XAUEUR=X')).toBe('commodity');
    expect(mapAssetType('CURRENCY', 'XAUUSD=X')).toBe('commodity');
    expect(mapAssetType('CURRENCY', 'XAGEUR=X')).toBe('commodity');
  });

  it('defaults an unrecognized CURRENCY ref (no symbol given) to fx', () => {
    expect(mapAssetType('CURRENCY')).toBe('fx');
    expect(mapAssetType('CURRENCY', null)).toBe('fx');
  });
});

describe('mapMarketState (§13.5 V5-P1)', () => {
  it('maps Yahoo session strings to the four-state enum, crypto/REGULAR ⇒ open', () => {
    expect(mapMarketState('REGULAR')).toBe('open');
    expect(mapMarketState('PRE')).toBe('pre');
    expect(mapMarketState('PREPRE')).toBe('pre');
    expect(mapMarketState('POST')).toBe('post');
    expect(mapMarketState('POSTPOST')).toBe('post');
    expect(mapMarketState('CLOSED')).toBe('closed');
  });

  it('returns null for an unknown or absent state — never a wrong badge', () => {
    expect(mapMarketState(undefined)).toBeNull();
    expect(mapMarketState(null)).toBeNull();
    expect(mapMarketState('')).toBeNull();
    expect(mapMarketState('WAT')).toBeNull();
  });
});

describe('currencyForSearchResult (§6.2)', () => {
  it('derives euro currencies from European venue suffixes', () => {
    expect(currencyForSearchResult('BAYN.DE', 'GER')).toBe('EUR');
    expect(currencyForSearchResult('AIR.PA', 'PAR')).toBe('EUR');
    expect(currencyForSearchResult('ASML.AS', 'AMS')).toBe('EUR');
    expect(currencyForSearchResult('ENI.MI', 'MIL')).toBe('EUR');
  });

  it('maps London to GBP (the major code; pence scaling is applied later)', () => {
    expect(currencyForSearchResult('BP.L', 'LSE')).toBe('GBP');
  });

  it('handles other global venues', () => {
    expect(currencyForSearchResult('NESN.SW', 'EBS')).toBe('CHF');
    expect(currencyForSearchResult('7203.T', 'JPX')).toBe('JPY');
    expect(currencyForSearchResult('SHOP.TO', 'TOR')).toBe('CAD');
    expect(currencyForSearchResult('BHP.AX', 'ASX')).toBe('AUD');
  });

  it('reads the quote currency of FX pairs and crypto', () => {
    expect(currencyForSearchResult('EURUSD=X', 'CCY')).toBe('USD');
    expect(currencyForSearchResult('GBPJPY=X', 'CCY')).toBe('JPY');
    expect(currencyForSearchResult('BTC-EUR', 'CCC')).toBe('EUR');
    expect(currencyForSearchResult('ETH-USD', 'CCC')).toBe('USD');
  });

  it('falls back to the exchange code, then USD, for suffix-less US symbols', () => {
    expect(currencyForSearchResult('AAPL', 'NMS')).toBe('USD');
    expect(currencyForSearchResult('BRK-B', 'NYQ')).toBe('USD'); // dash is a class, not a pair
    expect(currencyForSearchResult('WEIRD', 'UNKNOWN-EXCHANGE')).toBe('USD');
    expect(currencyForSearchResult('NOEXCH', null)).toBe('USD');
  });
});
