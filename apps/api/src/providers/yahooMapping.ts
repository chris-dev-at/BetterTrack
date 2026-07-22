import type {
  AssetType,
  CurrencyCode,
  DividendEvent,
  DividendEvents,
  EarningsEvent,
  EarningsEvents,
  MarketState,
  NewsHeadline,
  SplitEvent,
  SplitEvents,
} from '@bettertrack/contracts';

import type {
  YahooChartEventsResult,
  YahooNewsResult,
  YahooQuoteSummaryResult,
} from './yahooClient';

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
 * Map Yahoo's `marketState` string to the contract's four-state enum (§13.5
 * V5-P1 live badge). Yahoo emits `PRE`/`PREPRE`, `REGULAR`, `POST`/`POSTPOST`
 * and `CLOSED`; crypto/24-7 symbols report `REGULAR`, so they map to `open`
 * with no special-casing. An unknown/absent value maps to `null` so the client
 * renders no badge rather than a wrong one — we never invent a state.
 */
export function mapMarketState(raw: string | null | undefined): MarketState | null {
  switch ((raw ?? '').toUpperCase()) {
    case 'REGULAR':
      return 'open';
    case 'PRE':
    case 'PREPRE':
      return 'pre';
    case 'POST':
    case 'POSTPOST':
      return 'post';
    case 'CLOSED':
      return 'closed';
    default:
      return null;
  }
}

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

/**
 * ISO-4217 "precious metal" codes: Yahoo prices these against a real currency
 * (`XAUEUR=X`, `XAUUSD=X`) using the same `=X` shape and `CURRENCY` quoteType
 * as an actual FX pair, but they represent a commodity spot price, not an
 * exchange rate — the BetterTrack taxonomy (§5.5) types them as `commodity`.
 */
const METAL_CURRENCY_PREFIXES = ['XAU', 'XAG', 'XPT', 'XPD'];

/** True for a Yahoo `=X` ref naming a metal spot price rather than a currency pair. */
function isMetalCurrencyRef(symbol: string | null | undefined): boolean {
  const sym = (symbol ?? '').trim().toUpperCase();
  return sym.endsWith('=X') && METAL_CURRENCY_PREFIXES.some((p) => sym.startsWith(p));
}

/**
 * Map a Yahoo `quoteType` onto the BetterTrack asset taxonomy (§5.5). `symbol`
 * disambiguates the `CURRENCY` quoteType, which Yahoo also uses for metal spot
 * refs like `XAUEUR=X` (a commodity, not an FX pair) — see
 * {@link isMetalCurrencyRef}.
 */
export function mapAssetType(
  quoteType: string | null | undefined,
  symbol?: string | null,
): AssetType {
  switch ((quoteType ?? '').toUpperCase()) {
    case 'EQUITY':
      return 'stock';
    case 'ETF':
    case 'MUTUALFUND':
      return 'etf';
    case 'INDEX':
      return 'index';
    case 'CURRENCY':
      return isMetalCurrencyRef(symbol) ? 'commodity' : 'fx';
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

// ── Market-intelligence mapping (§13.5 V5-P5) ────────────────────────────────

/**
 * Best-effort currency normalisation for the *intel* path. Unlike
 * {@link normalizeCurrency} (which throws to fail loud on the money path), an
 * asset page's dividend/earnings block is informational, so a missing or
 * unmappable currency yields `null` (amounts stay unscaled) rather than blowing
 * up the whole page.
 */
export function safeNormalizeCurrency(raw: string | null | undefined): NormalizedCurrency | null {
  try {
    return normalizeCurrency(raw);
  } catch {
    return null;
  }
}

/** Coerce a Yahoo date-ish value (Date | epoch-ms | ISO string) to ISO-8601, or null. */
function toIsoOrNull(value: Date | number | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Ascending sort key over a nullable ISO date (nulls sort first, stable). */
function byIsoDate(a: { date?: string | null }, b: { date?: string | null }): number {
  return (a.date ?? '').localeCompare(b.date ?? '');
}

/**
 * Map Yahoo's `chart(events:'div')` history + `quoteSummary` calendar/detail into
 * the {@link DividendEvents} contract. Per-share amounts are scaled out of any
 * minor unit (London pence → GBP) exactly like prices, so a GBp payout is never
 * off by 100×. The chart's own currency wins for the amounts; `summaryDetail`
 * is a fallback and supplies the forward yield + trailing amount (arc e).
 */
export function mapDividendEvents(
  chart: YahooChartEventsResult,
  summary: YahooQuoteSummaryResult,
): DividendEvents {
  const norm = safeNormalizeCurrency(chart.meta?.currency ?? summary.summaryDetail?.currency);
  const currency = norm?.code ?? null;
  const scale = norm?.priceScale ?? 1;

  const history: DividendEvent[] = (chart.dividends ?? [])
    .map((d) => ({
      exDate: toIsoOrNull(d.date),
      payDate: null,
      amount: typeof d.amount === 'number' ? d.amount * scale : null,
      currency,
    }))
    .sort((a, b) => (a.exDate ?? '').localeCompare(b.exDate ?? ''));

  const cal = summary.calendarEvents ?? {};
  const upcomingEx = toIsoOrNull(cal.exDividendDate);
  const upcomingPay = toIsoOrNull(cal.dividendDate);
  const upcoming: DividendEvent[] =
    upcomingEx || upcomingPay
      ? [{ exDate: upcomingEx, payDate: upcomingPay, amount: null, currency }]
      : [];

  const detail = summary.summaryDetail ?? {};
  const forwardYield = typeof detail.dividendYield === 'number' ? detail.dividendYield : null;
  const trailingRaw =
    typeof detail.trailingAnnualDividendRate === 'number'
      ? detail.trailingAnnualDividendRate
      : typeof detail.dividendRate === 'number'
        ? detail.dividendRate
        : null;
  const trailingAmount = trailingRaw != null ? trailingRaw * scale : null;

  return { currency, history, upcoming, forwardYield, trailingAmount };
}

/**
 * Map Yahoo's `quoteSummary` calendar + earnings history into the
 * {@link EarningsEvents} contract: the earliest upcoming date (flagged
 * estimated) as `next`, and reported quarters as `recent` (ascending by date).
 */
export function mapEarningsEvents(summary: YahooQuoteSummaryResult): EarningsEvents {
  const cal = summary.calendarEvents?.earnings ?? {};
  const nextDate = (cal.earningsDate ?? [])
    .map(toIsoOrNull)
    .filter((d): d is string => d !== null)
    .sort()[0];
  // An upcoming date is an estimate unless Yahoo explicitly confirms it.
  const estimated = cal.isEarningsDateEstimate ?? true;
  const next: EarningsEvent | null = nextDate
    ? {
        date: nextDate,
        epsEstimate: typeof cal.earningsAverage === 'number' ? cal.earningsAverage : null,
        epsActual: null,
        estimated,
      }
    : null;

  const recent: EarningsEvent[] = (summary.earningsHistory?.history ?? [])
    .map((h) => ({
      date: toIsoOrNull(h.quarter),
      epsEstimate: typeof h.epsEstimate === 'number' ? h.epsEstimate : null,
      epsActual: typeof h.epsActual === 'number' ? h.epsActual : null,
      // History rows are reported actuals, not estimates.
      estimated: false,
    }))
    .sort(byIsoDate);

  return { next, recent };
}

/**
 * Map Yahoo's `search(...).news` into {@link NewsHeadline}s. Drops rows missing a
 * title or a usable http(s) link (the contract requires a URL), and keys each
 * headline by the provider uuid, falling back to the link.
 */
export function mapNewsHeadlines(result: YahooNewsResult): NewsHeadline[] {
  const out: NewsHeadline[] = [];
  for (const n of result.news ?? []) {
    const title = (n.title ?? '').trim();
    const url = (n.link ?? '').trim();
    const id = (n.uuid ?? url).trim();
    if (title === '' || url === '' || id === '') continue;
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({
      id,
      title,
      publisher: (n.publisher ?? '').trim() || null,
      url,
      publishedAt: toIsoOrNull(n.providerPublishTime),
    });
  }
  return out;
}

/**
 * Map Yahoo's `chart(events:'split')` history into the {@link SplitEvents}
 * contract (ascending by date). Rows with a non-positive numerator/denominator
 * are dropped; `ratio` falls back to `n:d` when Yahoo omits its display string.
 * Yahoo exposes only *past* splits, so `upcoming` is always empty here.
 */
export function mapSplitEvents(chart: YahooChartEventsResult): SplitEvents {
  const history: SplitEvent[] = (chart.splits ?? [])
    .map((s): SplitEvent | null => {
      const numerator = typeof s.numerator === 'number' ? s.numerator : null;
      const denominator = typeof s.denominator === 'number' ? s.denominator : null;
      if (numerator === null || denominator === null || numerator <= 0 || denominator <= 0) {
        return null;
      }
      const ratio = (s.splitRatio ?? `${numerator}:${denominator}`).toString();
      return { date: toIsoOrNull(s.date), numerator, denominator, ratio };
    })
    .filter((s): s is SplitEvent => s !== null)
    .sort(byIsoDate);
  return { history, upcoming: [] };
}
