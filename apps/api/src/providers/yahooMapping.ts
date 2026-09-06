import { DIVIDEND_FORWARD_YIELD_MAX } from '@bettertrack/contracts';
import type {
  AssetFundamentals,
  AssetType,
  CurrencyCode,
  DividendAmountBasis,
  DividendEvent,
  DividendEvents,
  EarningsEvent,
  EarningsEvents,
  FundamentalsPeriod,
  FundamentalsRatios,
  MarketState,
  NewsHeadline,
  SplitEvent,
  SplitEvents,
} from '@bettertrack/contracts';

import type {
  YahooBalanceSheetRow,
  YahooCashflowStatementRow,
  YahooChartEventsResult,
  YahooIncomeStatementRow,
  YahooNewsResult,
  YahooQuoteSummaryResult,
  YahooSummaryDetail,
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
 * What {@link currencyForSearchResult} could work out about a hit's currency.
 *
 * `guessed` is the load-bearing half (#1875). A search projection's currency is
 * either DERIVED from something the symbol actually states — an FX pair naming
 * its quote currency, a crypto pair, a venue suffix, a known exchange code — or
 * it is the bare US default, which is not a reading of anything. The two must
 * be distinguishable downstream, because `assets.currency` is money: the
 * catalog stores it, `portfolioService` converts a PERSISTED cash movement
 * through it, and nothing in the read path can later tell a derivation from a
 * default. A defaulted code is a placeholder for the badge; only the catalog's
 * authoritative `getMeta` resolution may turn it into a stored denomination
 * (`services/search/catalogEnrichment.ts`).
 */
export interface SearchResultCurrency {
  /** The code to show, and — when `guessed` is false — to store. */
  code: CurrencyCode;
  /** True when no rule matched and `code` is the bare US default, not a reading. */
  guessed: boolean;
}

/**
 * Best-effort currency for a search hit (§6.2 — results show a currency badge).
 * Yahoo's `search()` does not return a currency, so we derive it from the
 * symbol shape: FX pairs (`EURUSD=X`) and crypto (`BTC-EUR`) name their quote
 * currency directly; otherwise the venue suffix / exchange code fixes it.
 *
 * When none of those rules matches there is nothing to derive from — Yahoo's
 * primary market is the US, so the code answers `USD` and flags it `guessed`.
 * `^IBEX` is the shape that matters: no `=X`, no `-`, no dot suffix, and `MCE`
 * is not in {@link EXCHANGE_CURRENCY}, so a EUR index defaults to USD. The flag
 * is what stops that placeholder being stored as a fact.
 */
export function currencyForSearchResult(
  symbol: string,
  exchange: string | null | undefined,
): SearchResultCurrency {
  const sym = (symbol ?? '').trim();
  const derived = (code: CurrencyCode): SearchResultCurrency => ({ code, guessed: false });

  // FX pair, e.g. `EURUSD=X` (USD per EUR) → quote currency is the trailing 3.
  if (sym.endsWith('=X')) {
    const pair = sym.slice(0, -2).toUpperCase();
    if (pair.length === 6 && /^[A-Z]{6}$/.test(pair)) return derived(pair.slice(3) as CurrencyCode);
    // Short form like `EUR=X` is quoted against USD.
    if (/^[A-Z]{3}$/.test(pair)) return derived('USD');
  }

  // Crypto / pair form `BTC-USD`, `ETH-EUR`.
  const dashIdx = sym.lastIndexOf('-');
  if (dashIdx > 0) {
    const quote = sym.slice(dashIdx + 1).toUpperCase();
    if (/^[A-Z]{3}$/.test(quote)) return derived(quote as CurrencyCode);
  }

  // Venue suffix after the final dot.
  const dotIdx = sym.lastIndexOf('.');
  if (dotIdx >= 0) {
    const suffix = sym.slice(dotIdx + 1).toUpperCase();
    const bySuffix = SUFFIX_CURRENCY[suffix];
    if (bySuffix) return derived(bySuffix);
  }

  // Exchange-code fallback (US listings have no suffix).
  const byExchange = exchange ? EXCHANGE_CURRENCY[exchange.toUpperCase()] : undefined;
  if (byExchange) return derived(byExchange);

  // Nothing to read it off: the US default, marked as the guess it is.
  return { code: 'USD', guessed: true };
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

/** Ascending over a nullable ISO fiscal period end (nulls sort first, stable). */
function byPeriodEnd(a: { periodEnd?: string | null }, b: { periodEnd?: string | null }): number {
  return (a.periodEnd ?? '').localeCompare(b.periodEnd ?? '');
}

/**
 * How far a candidate reading may sit from the cross-check and still count as
 * confirmed. The two readings of one reported number (fraction vs percent) are
 * exactly 100× apart, so any factor below 10 can confirm at most one of them;
 * 5 leaves room for the cross-check's own imprecision — a previous close that
 * moved, or a trailing rate inflated by a special dividend — without ever
 * admitting both.
 */
const YIELD_UNIT_TOLERANCE = 5;

/** The first finite, strictly positive number among the candidates, else null. */
function firstPositive(...values: Array<number | null | undefined>): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/**
 * Determine the unit of Yahoo's `dividendYield` and return it in the contract's
 * convention — a FRACTION (`0.015` ≈ 1.5 %) — or null when the unit cannot be
 * determined (#1790).
 *
 * Yahoo has shipped both conventions over the years, and the previous guard
 * (accept `[0, DIVIDEND_FORWARD_YIELD_MAX]`, drop the rest) cannot tell them
 * apart below 1.0 — worse, it INVERTS on a percent-reporting build: `0.44` (a
 * 0.44 % payer) passes and renders "44 %", while `2.5` (a normal 2.5 % payer)
 * exceeds the bound and disappears. A range says nothing about a unit.
 *
 * **The mechanism is a cross-check against the payload's own arithmetic.** The
 * same `summaryDetail` module carries an annual dividend per share and the last
 * close, so `perShare / price` is a reference yield in the contract's fraction
 * convention. Both operands come from that one module, so they share a
 * denomination (and any minor-unit scale cancels in the ratio) — no assumption
 * that `chart.meta.currency` and `summaryDetail.currency` agree. The reported
 * number is then read both ways — as a fraction, and as percent (÷100) — and the
 * reading the reference confirms within {@link YIELD_UNIT_TOLERANCE} wins.
 *
 * Nothing is published on a guess: no per-share rate, no price, a reference that
 * confirms neither reading, or a confirmed reading outside the contract's range
 * all yield null. An absent block, never a wrong number. The one figure that
 * needs no evidence is 0 — the same number in either unit.
 */
function determineForwardYield(detail: YahooSummaryDetail): number | null {
  const raw = detail.dividendYield;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
  if (raw === 0) return 0;

  // Prefer the forward-annualized regular rate: it is what a FORWARD yield is
  // built from, and it is not inflated by a special the way the trailing sum is.
  const perShare = firstPositive(detail.dividendRate, detail.trailingAnnualDividendRate);
  const price = firstPositive(detail.previousClose, detail.regularMarketPreviousClose);
  if (perShare === null || price === null) return null;
  const reference = perShare / price;
  if (!Number.isFinite(reference) || reference <= 0) return null;

  const confirmed = ([raw, raw / 100] as const)
    .filter((candidate) => candidate > 0 && candidate <= DIVIDEND_FORWARD_YIELD_MAX)
    .map((candidate) => ({ candidate, ratio: candidate / reference }))
    .filter(({ ratio }) => ratio >= 1 / YIELD_UNIT_TOLERANCE && ratio <= YIELD_UNIT_TOLERANCE)
    // Both readings can never pass the same tolerance (they are 100× apart and
    // the tolerance is below 10), but sort anyway so the result never depends on
    // that argument holding.
    .sort((a, b) => Math.abs(Math.log(a.ratio)) - Math.abs(Math.log(b.ratio)));

  return confirmed[0]?.candidate ?? null;
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

  const forwardYield = determineForwardYield(detail);

  // DECISION (#1741): the two annual-per-share figures Yahoo can supply are
  // DIFFERENT bases — `trailingAnnualDividendRate` is a realized TTM sum (it
  // includes special dividends), `dividendRate` is the forward-annualized
  // regular rate (it does not) — and right after a special payout they differ by
  // a large factor. Rather than pick one and lose the other, the number now
  // travels WITH its basis, so a projection can state what it used. The
  // preference order is unchanged (realized TTM when Yahoo has it, the
  // forward-annualized rate otherwise): this publishes the basis, it does not
  // re-pick the number.
  const trailing: { raw: number; basis: DividendAmountBasis } | null =
    typeof detail.trailingAnnualDividendRate === 'number'
      ? { raw: detail.trailingAnnualDividendRate, basis: 'trailing-12m' }
      : typeof detail.dividendRate === 'number'
        ? { raw: detail.dividendRate, basis: 'forward-annualized' }
        : null;

  return {
    currency,
    history,
    upcoming,
    forwardYield,
    trailingAmount: trailing ? trailing.raw * scale : null,
    trailingAmountBasis: trailing?.basis ?? null,
  };
}

/**
 * Map Yahoo's `quoteSummary` calendar + earnings history into the
 * {@link EarningsEvents} contract: the earliest calendar date (flagged
 * estimated) as `next`, and reported quarters as `recent` (ascending).
 *
 * The two halves speak about different dates, and since #1790 the contract keeps
 * them apart. `calendarEvents.earnings.earningsDate` is an ANNOUNCEMENT date, so
 * it maps to `date` (`periodEnd` null) — and it is not filtered here for being
 * in the past: this mapper is pure and has no clock, and the read paths that
 * label it "next" own that guard (`marketIntelService.earningsCalendar`,
 * `earningsReminder`, the asset page). `earningsHistory.history[].quarter` is a
 * fiscal PERIOD END, so it maps to `periodEnd` with a null `date` — the
 * announcement date of a past report is simply not in this payload, and
 * inventing one by reusing the period end is what made a June-quarter report
 * render as if it had been announced on 28 Jun.
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
        periodEnd: null,
        epsEstimate: typeof cal.earningsAverage === 'number' ? cal.earningsAverage : null,
        epsActual: null,
        estimated,
      }
    : null;

  const recent: EarningsEvent[] = (summary.earningsHistory?.history ?? [])
    .map((h) => ({
      date: null,
      periodEnd: toIsoOrNull(h.quarter),
      epsEstimate: typeof h.epsEstimate === 'number' ? h.epsEstimate : null,
      epsActual: typeof h.epsActual === 'number' ? h.epsActual : null,
      // History rows are reported actuals, not estimates.
      estimated: false,
    }))
    .sort(byPeriodEnd);

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

// ── Fundamentals mapping (arc f / INTEL1, board #76) ─────────────────────────

/** A finite number, or null for anything Yahoo omitted / reported as non-finite. */
function numOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Calendar year of an ISO date, or null. */
function fiscalYearOf(iso: string | null): number | null {
  if (!iso) return null;
  const year = new Date(iso).getUTCFullYear();
  return Number.isNaN(year) ? null : year;
}

/** `"Q1".."Q4"` from the calendar quarter of the period-end date (`"Q"` if undated). */
function quarterLabel(iso: string | null): string {
  if (!iso) return 'Q';
  const month = new Date(iso).getUTCMonth();
  return Number.isNaN(month) ? 'Q' : `Q${Math.floor(month / 3) + 1}`;
}

/** A fresh, all-null period row anchored on one period-end date. */
function blankPeriod(iso: string | null, kind: 'FY' | 'Q'): FundamentalsPeriod {
  return {
    fiscalPeriod: kind === 'FY' ? 'FY' : quarterLabel(iso),
    fiscalYear: fiscalYearOf(iso),
    endDate: iso,
    // Yahoo's statement modules carry no announce date or per-period EPS; both
    // stay null (trailing/forward EPS are surfaced in `ratios`, where authoritative).
    reportDate: null,
    revenue: null,
    netIncome: null,
    eps: null,
    grossProfit: null,
    operatingIncome: null,
    totalAssets: null,
    totalLiabilities: null,
    totalEquity: null,
    operatingCashFlow: null,
    freeCashFlow: null,
  };
}

/**
 * Merge Yahoo's three statement histories (income / balance / cashflow) for one
 * granularity into {@link FundamentalsPeriod} rows, joined on the shared
 * period-end date and returned most-recent-first. Undated rows never collide
 * across statements (they fall back to a per-statement synthetic key) and sort
 * last. `freeCashFlow = operatingCashFlow + capitalExpenditures` (Yahoo reports
 * capex as a negative outflow), falling back to operating cash flow alone.
 */
function mergeStatementPeriods(
  income: YahooIncomeStatementRow[] | undefined,
  balance: YahooBalanceSheetRow[] | undefined,
  cashflow: YahooCashflowStatementRow[] | undefined,
  kind: 'FY' | 'Q',
): FundamentalsPeriod[] {
  const byKey = new Map<string, FundamentalsPeriod>();
  const ensure = (iso: string | null, fallbackKey: string): FundamentalsPeriod => {
    const key = iso ?? fallbackKey;
    let row = byKey.get(key);
    if (!row) {
      row = blankPeriod(iso, kind);
      byKey.set(key, row);
    }
    return row;
  };

  (income ?? []).forEach((r, idx) => {
    const iso = toIsoOrNull(r.endDate);
    const row = ensure(iso, `i#${idx}`);
    row.revenue = numOrNull(r.totalRevenue);
    row.grossProfit = numOrNull(r.grossProfit);
    row.operatingIncome = numOrNull(r.operatingIncome);
    row.netIncome = numOrNull(r.netIncome);
  });
  (balance ?? []).forEach((r, idx) => {
    const iso = toIsoOrNull(r.endDate);
    const row = ensure(iso, `b#${idx}`);
    row.totalAssets = numOrNull(r.totalAssets);
    row.totalLiabilities = numOrNull(r.totalLiab);
    row.totalEquity = numOrNull(r.totalStockholderEquity);
  });
  (cashflow ?? []).forEach((r, idx) => {
    const iso = toIsoOrNull(r.endDate);
    const row = ensure(iso, `c#${idx}`);
    const operating = numOrNull(r.totalCashFromOperatingActivities);
    const capex = numOrNull(r.capitalExpenditures);
    row.operatingCashFlow = operating;
    row.freeCashFlow = operating !== null && capex !== null ? operating + capex : operating;
  });

  return [...byKey.values()].sort((a, b) => (b.endDate ?? '').localeCompare(a.endDate ?? ''));
}

/**
 * Map Yahoo's `quoteSummary` fundamentals modules into the {@link AssetFundamentals}
 * contract: both period granularities (most-recent-first) plus the snapshot
 * ratios and the company's reporting currency. Pure and network-free; the
 * provider requests the modules and the market-data keystone caches the result.
 * The reporting currency prefers `financialData.financialCurrency` and falls back
 * to `summaryDetail.currency`; an unmappable code yields null (informational
 * figures stay as-is) rather than throwing on this non-money-path.
 */
export function mapFundamentals(summary: YahooQuoteSummaryResult): AssetFundamentals {
  const currency =
    safeNormalizeCurrency(
      summary.financialData?.financialCurrency ?? summary.summaryDetail?.currency,
    )?.code ?? null;

  const annual = mergeStatementPeriods(
    summary.incomeStatementHistory?.incomeStatementHistory,
    summary.balanceSheetHistory?.balanceSheetStatements,
    summary.cashflowStatementHistory?.cashflowStatements,
    'FY',
  );
  const quarterly = mergeStatementPeriods(
    summary.incomeStatementHistoryQuarterly?.incomeStatementHistory,
    summary.balanceSheetHistoryQuarterly?.balanceSheetStatements,
    summary.cashflowStatementHistoryQuarterly?.cashflowStatements,
    'Q',
  );

  const detail = summary.summaryDetail ?? {};
  const stats = summary.defaultKeyStatistics ?? {};
  const fin = summary.financialData ?? {};
  const ratios: FundamentalsRatios = {
    marketCap: numOrNull(detail.marketCap),
    trailingPe: numOrNull(detail.trailingPE),
    forwardPe: numOrNull(detail.forwardPE),
    priceToBook: numOrNull(stats.priceToBook),
    profitMargin: numOrNull(fin.profitMargins),
    returnOnEquity: numOrNull(fin.returnOnEquity),
    debtToEquity: numOrNull(fin.debtToEquity),
    trailingEps: numOrNull(stats.trailingEps),
    forwardEps: numOrNull(stats.forwardEps),
  };

  return { currency, annual, quarterly, ratios };
}
