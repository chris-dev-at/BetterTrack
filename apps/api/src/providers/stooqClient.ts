/**
 * The narrow slice of Stooq's CSV endpoints the Stooq provider depends on
 * (PROJECTPLAN.md §13.5 V5-P1c). Stooq is keyless: quotes and daily history come
 * back as plain CSV over HTTPS, so the "client" is a tiny fetch + parse. Defining
 * our own boundary type (rather than leaning on the CSV shape everywhere) keeps
 * the provider unit-testable against recorded fixtures with a hand-written stub —
 * no live network in CI — and contains any endpoint change to this one file.
 *
 * Every numeric field is nullable because Stooq answers an unknown symbol with
 * `N/D` sentinels; the provider reads defensively and turns the result into the
 * strict §5.1 contract shapes.
 */

/** One parsed row of the Stooq light-quote CSV (`/q/l/`). */
export interface StooqQuoteRow {
  /** Echoed symbol (Stooq's own, e.g. `AAPL.US`). */
  symbol: string;
  /** Quote day `YYYY-MM-DD`, or null when Stooq returns `N/D`. */
  date: string | null;
  /** Quote time `HH:MM:SS` (UTC-ish), or null. */
  time: string | null;
  /** Last price, or null when Stooq returns `N/D` (unknown symbol). */
  close: number | null;
}

/** One parsed row of the Stooq daily-history CSV (`/q/d/l/`). */
export interface StooqHistoryRow {
  /** Trading day `YYYY-MM-DD`. */
  date: string;
  /** Daily close. */
  close: number;
}

export interface StooqHistoryParams {
  period1: Date;
  period2: Date;
}

export interface StooqClient {
  /** Light quote for one Stooq symbol; null when the response is empty. */
  quote(symbol: string): Promise<StooqQuoteRow | null>;
  /** Daily-close history for a window; empty when Stooq has no data. */
  history(symbol: string, params: StooqHistoryParams): Promise<StooqHistoryRow[]>;
}

export interface CreateStooqClientDeps {
  /** Injectable fetch (tests). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Base URL override (tests / self-host mirrors). Defaults to Stooq. */
  baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://stooq.com';

/** A finite number, or null for `N/D` / blank / non-numeric cells. */
function parseNumber(cell: string | undefined): number | null {
  if (cell === undefined) return null;
  const trimmed = cell.trim();
  if (trimmed === '' || trimmed.toUpperCase() === 'N/D') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** A non-empty, non-`N/D` string cell, else null. */
function parseText(cell: string | undefined): string | null {
  if (cell === undefined) return null;
  const trimmed = cell.trim();
  if (trimmed === '' || trimmed.toUpperCase() === 'N/D') return null;
  return trimmed;
}

/** Split a CSV body into rows of cells; skips blank lines. */
function parseCsvRows(body: string): string[][] {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => line.split(','));
}

/** `Date` → Stooq's `YYYYMMDD` window bound (UTC). */
function toStooqDay(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Build the real Stooq client. HTTP errors (non-2xx) throw so the market-data
 * service's timeout → retry-once → circuit breaker treats them as transient,
 * exactly like the Yahoo client; a 200 with `N/D` is a definitive "unknown
 * symbol" the provider maps to a not-found (negative-cacheable, §5.3).
 */
export function createStooqClient(deps: CreateStooqClientDeps = {}): StooqClient {
  const doFetch = deps.fetch ?? fetch;
  const baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;

  async function getText(path: string): Promise<string> {
    const res = await doFetch(`${baseUrl}${path}`);
    if (!res.ok) {
      throw Object.assign(new Error(`Stooq HTTP ${res.status}`), { code: res.status });
    }
    return res.text();
  }

  return {
    async quote(symbol) {
      const body = await getText(`/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcv&h&e=csv`);
      const rows = parseCsvRows(body);
      // Row 0 is the header (`Symbol,Date,Time,...`); the data row follows.
      const data = rows.length >= 2 ? rows[1] : undefined;
      if (!data) return null;
      return {
        symbol: parseText(data[0]) ?? symbol,
        date: parseText(data[1]),
        time: parseText(data[2]),
        close: parseNumber(data[6]),
      };
    },

    async history(symbol, params) {
      const d1 = toStooqDay(params.period1);
      const d2 = toStooqDay(params.period2);
      const body = await getText(`/q/d/l/?s=${encodeURIComponent(symbol)}&d1=${d1}&d2=${d2}&i=d`);
      const rows = parseCsvRows(body);
      // A `No data` body (or bare header) yields nothing usable.
      if (rows.length < 2) return [];
      const out: StooqHistoryRow[] = [];
      for (const row of rows.slice(1)) {
        const date = parseText(row[0]);
        const close = parseNumber(row[4]);
        if (date && close !== null) out.push({ date, close });
      }
      return out;
    },
  };
}
