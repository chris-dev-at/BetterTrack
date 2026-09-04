import { describe, expect, it } from 'vitest';

import { DIVIDEND_FORWARD_YIELD_MAX } from '@bettertrack/contracts';

import type { YahooChartEventsResult, YahooQuoteSummaryResult } from '../yahooClient';
import {
  currencyForSearchResult,
  mapAssetType,
  mapDividendEvents,
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

describe('mapDividendEvents — annual-amount basis + yield convention (#1741)', () => {
  const CHART: YahooChartEventsResult = { meta: { currency: 'USD' }, dividends: [], splits: [] };

  /** Just the summary half; the chart half carries no amount fields. */
  function map(detail: YahooQuoteSummaryResult['summaryDetail']) {
    return mapDividendEvents(CHART, { summaryDetail: detail });
  }

  it('labels a realized trailing-12-month rate as `trailing-12m`', () => {
    const result = map({ currency: 'USD', trailingAnnualDividendRate: 3.2 });
    expect(result.trailingAmount).toBeCloseTo(3.2, 6);
    expect(result.trailingAmountBasis).toBe('trailing-12m');
  });

  it('labels a forward-annualized regular rate as `forward-annualized`', () => {
    // Yahoo populated only `dividendRate` — the last REGULAR payout annualized,
    // which excludes special dividends. Before #1741 this arrived under the very
    // same field name as the trailing sum, so the caller could not tell.
    const result = map({ currency: 'USD', dividendRate: 2.4 });
    expect(result.trailingAmount).toBeCloseTo(2.4, 6);
    expect(result.trailingAmountBasis).toBe('forward-annualized');
  });

  it('prefers the realized trailing sum when Yahoo supplies both, and says so', () => {
    // A special dividend makes the two diverge by a large factor; the payload
    // now names which of them the number is.
    const result = map({
      currency: 'USD',
      trailingAnnualDividendRate: 9.6,
      dividendRate: 2.4,
    });
    expect(result.trailingAmount).toBeCloseTo(9.6, 6);
    expect(result.trailingAmountBasis).toBe('trailing-12m');
  });

  it('leaves both null when Yahoo supplies neither (basis null exactly when amount is)', () => {
    const result = map({ currency: 'USD' });
    expect(result.trailingAmount).toBeNull();
    expect(result.trailingAmountBasis).toBeNull();
  });

  it('scales a pence-quoted amount without losing its basis', () => {
    const result = mapDividendEvents(
      { meta: { currency: 'GBp' }, dividends: [], splits: [] },
      { summaryDetail: { currency: 'GBp', dividendRate: 98 } },
    );
    expect(result.trailingAmount).toBeCloseTo(0.98, 6);
    expect(result.trailingAmountBasis).toBe('forward-annualized');
  });

  it('passes an in-range forward yield through as the documented fraction', () => {
    expect(map({ currency: 'USD', dividendYield: 0.0044 }).forwardYield).toBe(0.0044);
    expect(map({ currency: 'USD', dividendYield: 0 }).forwardYield).toBe(0);
    expect(map({ currency: 'USD', dividendYield: DIVIDEND_FORWARD_YIELD_MAX }).forwardYield).toBe(
      DIVIDEND_FORWARD_YIELD_MAX,
    );
  });

  it('drops a yield outside the fraction convention instead of rendering it 100× wrong', () => {
    // `1.55` is Yahoo's percent convention leaking through: forwarded as a
    // fraction the asset page would read "155 %".
    expect(map({ currency: 'USD', dividendYield: 1.55 }).forwardYield).toBeNull();
    expect(map({ currency: 'USD', dividendYield: -0.01 }).forwardYield).toBeNull();
    expect(map({ currency: 'USD', dividendYield: Number.NaN }).forwardYield).toBeNull();
  });
});
