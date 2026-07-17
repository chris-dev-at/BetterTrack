import type { AssetType, CurrencyCode } from '@bettertrack/contracts';

/**
 * Pure symbol/currency mapping for the Stooq failover provider (PROJECTPLAN.md
 * §13.5 V5-P1c). Stooq is the planner-picked keyless secondary for stocks/ETFs/
 * indices; it is reached only when the primary (Yahoo) is unhealthy, so its job
 * is to answer for the SAME instrument the user chose on Yahoo. That makes the
 * yahoo-ref → stooq-symbol mapping and the derived currency money-critical: a
 * wrong currency or a different instrument would corrupt a portfolio total.
 *
 * We therefore map only symbols whose Stooq listing + currency are unambiguous
 * and whose trading unit is the MAJOR currency unit (no London-pence-style 100×
 * trap): US listings (`.us`, USD), XETRA German listings (`.de`, EUR) and the
 * major US/DE indices. Everything else — other venues, crypto, FX, commodities —
 * returns null, so the failover chain leaves those assets Yahoo-only rather than
 * risk a wrong number. Adding a venue later is a one-line table entry (a
 * config-only extension, as the spec requires).
 *
 * Currency conventions match `yahooMapping.ts`: the same ISO-4217 code Yahoo
 * would report for the same listing (US → USD, XETRA → EUR), so a cache entry
 * primed by either source is interchangeable.
 */

export interface StooqRef {
  /** Stooq's own symbol (lower-cased), e.g. `aapl.us`, `bayn.de`, `^spx`. */
  symbol: string;
  /** ISO-4217 currency of the listing (matches yahooMapping conventions). */
  currency: CurrencyCode;
  /** Best-effort asset class (stock/etf are indistinguishable from the symbol). */
  type: AssetType;
}

/** Yahoo venue suffix → Stooq suffix + listing currency. Extend to add a venue. */
const SUFFIX_MAP: Record<string, { stooq: string; currency: CurrencyCode }> = {
  DE: { stooq: 'de', currency: 'EUR' }, // XETRA — quoted in EUR (major unit)
};

/** Major indices Yahoo ref → Stooq symbol + currency (Stooq uses its own codes). */
const INDEX_MAP: Record<string, { stooq: string; currency: CurrencyCode }> = {
  '^GSPC': { stooq: '^spx', currency: 'USD' }, // S&P 500
  '^DJI': { stooq: '^dji', currency: 'USD' }, // Dow Jones
  '^IXIC': { stooq: '^ndq', currency: 'USD' }, // Nasdaq Composite
  '^NDX': { stooq: '^ndx', currency: 'USD' }, // Nasdaq 100
  '^GDAXI': { stooq: '^dax', currency: 'EUR' }, // DAX
};

/** True for a yahoo ref shape Stooq must not try (crypto/fx/commodity). */
function isNonEquityShape(upper: string): boolean {
  // `=X` covers FX *and* metal pairs (`XAUUSD=X`); `=F` covers futures — all
  // non-equity, so no separate metal-prefix check is needed.
  if (upper.endsWith('=X') || upper.endsWith('=F')) return true;
  const dash = upper.lastIndexOf('-');
  // Crypto pair `BTC-USD` (3–5 letter quote); a class share `BRK-B` is not.
  if (dash > 0 && /^[A-Z]{3,5}$/.test(upper.slice(dash + 1))) return true;
  return false;
}

/**
 * Map a Yahoo `providerRef` to Stooq's symbol + currency, or null when Stooq
 * cannot safely serve it (unsupported venue, crypto, FX, commodity, malformed).
 */
export function mapToStooq(providerRef: string): StooqRef | null {
  const raw = providerRef.trim();
  if (raw === '') return null;
  const upper = raw.toUpperCase();

  if (isNonEquityShape(upper)) return null;

  // Index (`^GSPC`), via the curated code map.
  if (upper.startsWith('^')) {
    const idx = INDEX_MAP[upper];
    return idx ? { symbol: idx.stooq, currency: idx.currency, type: 'index' } : null;
  }

  const dot = upper.lastIndexOf('.');
  if (dot >= 0) {
    // Venue-suffixed listing (`BAYN.DE`): map the suffix or decline.
    const base = raw.slice(0, dot).toLowerCase();
    const suffix = upper.slice(dot + 1);
    const mapped = SUFFIX_MAP[suffix];
    if (!mapped || base === '') return null;
    return { symbol: `${base}.${mapped.stooq}`, currency: mapped.currency, type: 'stock' };
  }

  // No venue suffix ⇒ a US listing (Yahoo emits US symbols bare). Dashes in a
  // class-share symbol (`BRK-B`) are preserved; Stooq uses the same shape.
  if (!/^[A-Z0-9.-]+$/.test(upper)) return null;
  return { symbol: `${raw.toLowerCase()}.us`, currency: 'USD', type: 'stock' };
}

/** True when Stooq can safely serve this Yahoo ref (its failover capability gate). */
export function stooqCanServe(providerRef: string): boolean {
  return mapToStooq(providerRef) !== null;
}
