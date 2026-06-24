import type { AssetType, CurrencyCode } from '@bettertrack/contracts';

/**
 * Pure shape-mapping helpers between `yahoo-finance2` and the BetterTrack
 * market-data contracts (PROJECTPLAN.md §5.1, §5.2, §5.4). Kept side-effect
 * free and network-free so they can be unit-tested in isolation; the provider
 * (`yahooProvider.ts`) wires them to the live client.
 */

/**
 * The result of normalising a raw Yahoo currency code (§5.4 — every stored
 * amount is in a real ISO-4217 currency). Some venues quote in a *minor unit*
 * (London in pence as `GBp`, Johannesburg in cents as `ZAc`); Yahoo reports the
 * minor-unit code and prices in that minor unit. We map the code to its major
 * ISO-4217 parent and carry the `priceScale` that converts a minor-unit price
 * into the major unit, so a quote is never silently off by 100×.
 */
export interface NormalizedCurrency {
  /** Canonical ISO-4217 code (always upper-case, three letters). */
  code: CurrencyCode;
  /** Multiply a Yahoo-reported price by this to get the price in `code`. */
  priceScale: number;
}

/**
 * Minor-unit currency codes Yahoo emits, mapped to their major parent and the
 * scale that turns a minor-unit price into the major unit. The lookup is
 * *case-sensitive* on purpose: `GBp` (pence) and `GBP` (pounds) differ only by
 * case and mean a 100× different price.
 */
const MINOR_UNIT_CURRENCIES: Record<string, NormalizedCurrency> = {
  GBp: { code: 'GBP', priceScale: 0.01 }, // London pence
  GBX: { code: 'GBP', priceScale: 0.01 }, // pence (alternate code)
  ZAc: { code: 'ZAR', priceScale: 0.01 }, // Johannesburg cents
  ZAX: { code: 'ZAR', priceScale: 0.01 },
  ILA: { code: 'ILS', priceScale: 0.01 }, // Tel Aviv agorot
};

/**
 * Normalise a raw Yahoo currency code into a real ISO-4217 code plus a price
 * scale (§5.4). Throws on a code that cannot be made into three upper-case
 * letters — better to fail loud on the money path than to fabricate a currency.
 */
export function normalizeCurrency(raw: string | null | undefined): NormalizedCurrency {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('Yahoo returned no currency for an asset');
  }
  const trimmed = raw.trim();

  const minor = MINOR_UNIT_CURRENCIES[trimmed];
  if (minor) return minor;

  const upper = trimmed.toUpperCase();
  if (!/^[A-Z]{3}$/.test(upper)) {
    throw new Error(`Yahoo returned an unmappable currency code: "${raw}"`);
  }
  return { code: upper, priceScale: 1 };
}

/** Map a Yahoo `quoteType` onto the BetterTrack asset taxonomy (§5.5). */
export function mapAssetType(quoteType: string | null | undefined): AssetType {
  switch ((quoteType ?? '').toUpperCase()) {
    case 'EQUITY':
      return 'stock';
    case 'ETF':
    case 'MUTUALFUND':
      return 'etf';
    case 'INDEX':
      return 'index';
    case 'CURRENCY':
      return 'fx';
    case 'CRYPTOCURRENCY':
      return 'crypto';
    case 'FUTURE':
      return 'commodity';
    default:
      // Options, money-market, ECN quotes and anything new: treat as a plain
      // instrument rather than dropping the result.
      return 'stock';
  }
}

/**
 * Yahoo symbol-suffix → currency. Yahoo encodes the listing venue as a suffix
 * after the final dot (`BAYN.DE`, `BP.L`); the venue fixes the trading
 * currency. Covers the European exchanges §5.2 calls out plus the major global
 * venues. London (`.L`) trades in pence but the *currency* is GBP — the pence
 * scaling lives in {@link normalizeCurrency}, used once the asset is selected.
 */
const SUFFIX_CURRENCY: Record<string, CurrencyCode> = {
  // Eurozone
  DE: 'EUR', // XETRA
  F: 'EUR', // Frankfurt
  BE: 'EUR', // Berlin
  BM: 'EUR', // Bremen
  DU: 'EUR', // Dusseldorf
  HM: 'EUR', // Hamburg
  HA: 'EUR', // Hanover
  MU: 'EUR', // Munich
  SG: 'EUR', // Stuttgart
  VI: 'EUR', // Vienna
  PA: 'EUR', // Euronext Paris
  AS: 'EUR', // Euronext Amsterdam
  BR: 'EUR', // Euronext Brussels
  LS: 'EUR', // Euronext Lisbon
  MC: 'EUR', // Madrid
  MI: 'EUR', // Milan
  IR: 'EUR', // Euronext Dublin
  HE: 'EUR', // Helsinki
  AT: 'EUR', // Athens
  // Other Europe
  L: 'GBP', // London
  IL: 'GBP', // London (intl order book)
  SW: 'CHF', // SIX Swiss
  ST: 'SEK', // Stockholm
  OL: 'NOK', // Oslo
  CO: 'DKK', // Copenhagen
  IC: 'ISK', // Iceland
  PR: 'CZK', // Prague
  WA: 'PLN', // Warsaw
  // Americas
  TO: 'CAD', // Toronto
  V: 'CAD', // TSX Venture
  NE: 'CAD', // NEO
  SA: 'BRL', // Sao Paulo
  MX: 'MXN', // Mexico
  BA: 'ARS', // Buenos Aires
  // Asia-Pacific
  T: 'JPY', // Tokyo
  HK: 'HKD', // Hong Kong
  SS: 'CNY', // Shanghai
  SZ: 'CNY', // Shenzhen
  KS: 'KRW', // Korea (KOSPI)
  KQ: 'KRW', // Korea (KOSDAQ)
  TW: 'TWD', // Taiwan
  BO: 'INR', // Bombay
  NS: 'INR', // India NSE
  SI: 'SGD', // Singapore
  AX: 'AUD', // ASX
  NZ: 'NZD', // New Zealand
  BK: 'THB', // Thailand
  JK: 'IDR', // Jakarta
  KL: 'MYR', // Kuala Lumpur
  // Middle East / Africa
  TA: 'ILS', // Tel Aviv
  JO: 'ZAR', // Johannesburg
  SR: 'SAR', // Saudi (Tadawul)
};

/**
 * Yahoo exchange code → currency, as a fallback when the symbol carries no
 * suffix (chiefly US listings, which Yahoo returns with no suffix). Only the
 * common venues; anything unknown falls through to the USD default.
 */
const EXCHANGE_CURRENCY: Record<string, CurrencyCode> = {
  NMS: 'USD', // NASDAQ
  NGM: 'USD',
  NCM: 'USD',
  NYQ: 'USD', // NYSE
  PCX: 'USD', // NYSE Arca
  ASE: 'USD', // NYSE American
  BATS: 'USD',
  PNK: 'USD', // OTC
  GER: 'EUR', // XETRA
  FRA: 'EUR',
  LSE: 'GBP',
  TOR: 'CAD',
  HKG: 'HKD',
};

/**
 * Best-effort currency for a search hit (§6.2 — results show a currency badge).
 * Yahoo's `search()` does not return a currency, so we derive it from the
 * symbol shape: FX pairs (`EURUSD=X`) and crypto (`BTC-EUR`) name their quote
 * currency directly; otherwise the venue suffix / exchange code fixes it. The
 * authoritative currency is re-fetched via {@link normalizeCurrency} from
 * `getMeta`/`getQuote` once the asset is actually selected, so an imperfect
 * guess here only affects the picker badge, never a stored amount.
 */
export function currencyForSearchResult(
  symbol: string,
  exchange: string | null | undefined,
): CurrencyCode {
  const sym = (symbol ?? '').trim();

  // FX pair, e.g. `EURUSD=X` (USD per EUR) → quote currency is the trailing 3.
  if (sym.endsWith('=X')) {
    const pair = sym.slice(0, -2).toUpperCase();
    if (pair.length === 6 && /^[A-Z]{6}$/.test(pair)) return pair.slice(3) as CurrencyCode;
    // Short form like `EUR=X` is quoted against USD.
    if (/^[A-Z]{3}$/.test(pair)) return 'USD';
  }

  // Crypto / pair form `BTC-USD`, `ETH-EUR`.
  const dashIdx = sym.lastIndexOf('-');
  if (dashIdx > 0) {
    const quote = sym.slice(dashIdx + 1).toUpperCase();
    if (/^[A-Z]{3}$/.test(quote)) return quote as CurrencyCode;
  }

  // Venue suffix after the final dot.
  const dotIdx = sym.lastIndexOf('.');
  if (dotIdx >= 0) {
    const suffix = sym.slice(dotIdx + 1).toUpperCase();
    const bySuffix = SUFFIX_CURRENCY[suffix];
    if (bySuffix) return bySuffix;
  }

  // Exchange-code fallback (US listings have no suffix).
  const byExchange = exchange ? EXCHANGE_CURRENCY[exchange.toUpperCase()] : undefined;
  if (byExchange) return byExchange;

  // Default: Yahoo's primary market is the US.
  return 'USD';
}
