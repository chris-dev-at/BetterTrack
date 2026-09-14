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
  const derived = (code: string) => ({ code, guessed: false });

  it('derives euro currencies from European venue suffixes', () => {
    expect(currencyForSearchResult('BAYN.DE', 'GER')).toEqual(derived('EUR'));
    expect(currencyForSearchResult('AIR.PA', 'PAR')).toEqual(derived('EUR'));
    expect(currencyForSearchResult('ASML.AS', 'AMS')).toEqual(derived('EUR'));
    expect(currencyForSearchResult('ENI.MI', 'MIL')).toEqual(derived('EUR'));
  });

  it('maps London to GBP (the major code; pence scaling is applied later)', () => {
    expect(currencyForSearchResult('BP.L', 'LSE')).toEqual(derived('GBP'));
  });

  it('handles other global venues', () => {
    expect(currencyForSearchResult('NESN.SW', 'EBS')).toEqual(derived('CHF'));
    expect(currencyForSearchResult('7203.T', 'JPX')).toEqual(derived('JPY'));
    expect(currencyForSearchResult('SHOP.TO', 'TOR')).toEqual(derived('CAD'));
    expect(currencyForSearchResult('BHP.AX', 'ASX')).toEqual(derived('AUD'));
  });

  it('reads the quote currency of FX pairs and crypto', () => {
    expect(currencyForSearchResult('EURUSD=X', 'CCY')).toEqual(derived('USD'));
    expect(currencyForSearchResult('GBPJPY=X', 'CCY')).toEqual(derived('JPY'));
    expect(currencyForSearchResult('BTC-EUR', 'CCC')).toEqual(derived('EUR'));
    expect(currencyForSearchResult('ETH-USD', 'CCC')).toEqual(derived('USD'));
  });

  it('falls back to the exchange code for suffix-less US symbols, unguessed', () => {
    expect(currencyForSearchResult('AAPL', 'NMS')).toEqual(derived('USD'));
    // A dash that is a share class, not a pair — the exchange decides.
    expect(currencyForSearchResult('BRK-B', 'NYQ')).toEqual(derived('USD'));
  });

  it('flags the bare USD default as a guess (#1875)', () => {
    // `^IBEX` is the shape that costs money: no `=X`, no `-`, no dot suffix,
    // and `MCE` is not in the exchange table — a EUR index would otherwise be
    // stored USD forever. The code is still USD (the badge needs one), but the
    // catalog may not treat it as a reading.
    expect(currencyForSearchResult('^IBEX', 'MCE')).toEqual({ code: 'USD', guessed: true });
    expect(currencyForSearchResult('^SSMI', 'EBS')).toEqual({ code: 'USD', guessed: true });
    expect(currencyForSearchResult('WEIRD', 'UNKNOWN-EXCHANGE')).toEqual({
      code: 'USD',
      guessed: true,
    });
    expect(currencyForSearchResult('NOEXCH', null)).toEqual({ code: 'USD', guessed: true });
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

  it('publishes a fraction-convention yield the payload’s own arithmetic confirms', () => {
    // $0.98/yr on a $222.73 close is 0.44 %, and the reported 0.0044 reads as
    // exactly that when taken as a fraction. Confirmed ⇒ published.
    expect(
      map({
        currency: 'USD',
        dividendYield: 0.0044,
        dividendRate: 0.98,
        previousClose: 222.73,
      }).forwardYield,
    ).toBe(0.0044);
  });

  it('publishes a percent-convention yield as the fraction it means (2.5 % is no longer dropped)', () => {
    // THE INVERSION, half one (#1790). $2.50/yr on a $100 close is 2.5 %, so the
    // reported `2.5` is percent and means 0.025. The old range filter dropped it
    // for exceeding DIVIDEND_FORWARD_YIELD_MAX — deleting a correct answer and
    // hiding the whole block for every normal payer on such a provider build.
    expect(
      map({
        currency: 'USD',
        dividendYield: 2.5,
        dividendRate: 2.5,
        previousClose: 100,
      }).forwardYield,
    ).toBeCloseTo(0.025, 10);
  });

  it('never renders a 0.44 % payer as 44 % on a percent-reporting build', () => {
    // THE INVERSION, half two (#1790): `0.44` sits INSIDE [0, 1], so the old
    // range filter passed it through as a fraction and the asset page rendered
    // "44.00 %". The payload's own arithmetic ($0.98 on $222.73 ⇒ 0.44 %) says
    // it is percent, so it means 0.0044.
    const result = map({
      currency: 'USD',
      dividendYield: 0.44,
      dividendRate: 0.98,
      previousClose: 222.73,
    });
    expect(result.forwardYield).toBeCloseTo(0.0044, 10);
    expect(result.forwardYield).not.toBe(0.44);
  });

  it('cross-checks inside one module, so a minor-unit quote needs no scaling', () => {
    // Both operands come from `summaryDetail`, so the pence denomination cancels
    // in the ratio: 98p on a 2500p close is 3.92 %, confirming the percent
    // reading of `3.92`. No assumption that chart and summary agree on currency.
    expect(
      mapDividendEvents(
        { meta: { currency: 'GBp' }, dividends: [], splits: [] },
        {
          summaryDetail: {
            currency: 'GBp',
            dividendYield: 3.92,
            dividendRate: 98,
            previousClose: 2500,
          },
        },
      ).forwardYield,
    ).toBeCloseTo(0.0392, 10);
  });

  it('publishes nothing when no cross-check is available — an absent figure, never a guess', () => {
    // No per-share rate, or no price: the unit is undetermined. `0.0044` is a
    // plausible fraction AND a plausible percent, and nothing in the payload
    // says which — so it is not published.
    expect(map({ currency: 'USD', dividendYield: 0.0044 }).forwardYield).toBeNull();
    expect(
      map({ currency: 'USD', dividendYield: 0.0044, dividendRate: 0.98 }).forwardYield,
    ).toBeNull();
    expect(
      map({ currency: 'USD', dividendYield: 0.0044, previousClose: 222.73 }).forwardYield,
    ).toBeNull();
  });

  it('drops a figure neither reading can explain', () => {
    // 50 is neither 5000 % nor 0.5 % on a payload that implies 0.44 %.
    expect(
      map({ currency: 'USD', dividendYield: 50, dividendRate: 0.98, previousClose: 222.73 })
        .forwardYield,
    ).toBeNull();
    // …and a confirmed reading still has to fit the contract's range.
    expect(
      map({ currency: 'USD', dividendYield: 150, dividendRate: 150, previousClose: 100 })
        .forwardYield,
    ).toBeNull();
    expect(map({ currency: 'USD', dividendYield: -0.01 }).forwardYield).toBeNull();
    expect(map({ currency: 'USD', dividendYield: Number.NaN }).forwardYield).toBeNull();
  });

  it('publishes a zero yield without a cross-check — 0 is the same in either unit', () => {
    expect(map({ currency: 'USD', dividendYield: 0 }).forwardYield).toBe(0);
  });

  it('falls back to the trailing rate for the cross-check, and survives a special dividend', () => {
    // Only `trailingAnnualDividendRate` is populated, and it is inflated by a
    // special: $19.64 TTM on a $250 close implies 7.9 % where the true forward
    // yield is 1.9 %. The two candidate readings are still 100× apart, so the
    // cross-check picks the right one anyway — that is the whole point of the
    // tolerance being far below 100.
    expect(
      map({
        currency: 'USD',
        dividendYield: 1.86,
        trailingAnnualDividendRate: 19.64,
        previousClose: 250,
      }).forwardYield,
    ).toBeCloseTo(0.0186, 10);
  });

  it('keeps the contract bound as the last gate', () => {
    expect(DIVIDEND_FORWARD_YIELD_MAX).toBe(1);
    expect(
      map({ currency: 'USD', dividendYield: 1, dividendRate: 100, previousClose: 100 })
        .forwardYield,
    ).toBe(DIVIDEND_FORWARD_YIELD_MAX);
  });
});
