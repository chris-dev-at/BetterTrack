import { currencyCodeSchema } from '@bettertrack/contracts';

/**
 * Currency conversion (PROJECTPLAN.md §5.4).
 *
 * Every asset is stored in its native currency; conversion happens at
 * read/computation time in exactly one place — here. Base currency is EUR in v1
 * but is a *parameter* throughout (never a literal), so per-user base currency
 * later is a settings field plus passthrough, not a refactor.
 *
 * This is the keystone skeleton: it owns the conversion *logic* (identity
 * shortcut, direction, current-vs-historical routing, base parameterisation)
 * and depends on a pluggable {@link FxRateSource} for the actual rates. The
 * source — current spot from cached quotes, historical daily rates from the
 * `price_history` FX pairs (§5.3) — is wired in a later issue (Yahoo provider +
 * backfill jobs are out of scope here).
 *
 * Conversions return full-precision numbers; display rounding (money 2 dp, etc.)
 * lives in the display layer (§5.4), never here — rounding mid-computation is
 * where money math goes wrong.
 */

/** Default base currency (§5.4). A parameter everywhere, defaulted here only. */
export const DEFAULT_BASE_CURRENCY = 'EUR';

/**
 * Thrown by an {@link FxRateSource} when a rate genuinely cannot be produced —
 * provider outage past the stale window, or no quote on/near the requested
 * date. Typed (unlike a caller-bug `Error`) so money paths can degrade
 * deliberately: the portfolio series drops the asset, the backtest preview
 * maps it to a 422 — never a 500.
 */
export class FxRateUnavailableError extends Error {
  readonly from: string;
  readonly to: string;
  /** ISO `YYYY-MM-DD` for historical lookups; null for spot. */
  readonly date: string | null;

  constructor(from: string, to: string, date: string | null, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'FxRateUnavailableError';
    this.from = from;
    this.to = to;
    this.date = date;
  }
}

/**
 * Supplies FX rates as "units of `to` per 1 unit of `from`". Implementations
 * decide how to source and cross rates; the currency service only asks.
 */
export interface FxRateSource {
  /** Current spot rate, `to` per 1 `from`. */
  getSpotRate(from: string, to: string): Promise<number>;
  /** Historical daily rate on `date` (ISO `YYYY-MM-DD`), `to` per 1 `from`. */
  getHistoricalRate(from: string, to: string, date: string): Promise<number>;
}

export interface ConvertOptions {
  /** ISO `YYYY-MM-DD`; omit for the current spot rate. */
  date?: string;
}

export interface ToBaseOptions extends ConvertOptions {
  /** Override the service's base currency for this call. */
  base?: string;
}

export interface CurrencyService {
  /** The base currency this service converts into by default. */
  readonly baseCurrency: string;
  /** Units of `to` per 1 unit of `from`; current when no date, historical otherwise. */
  getRate(from: string, to: string, opts?: ConvertOptions): Promise<number>;
  /** Convert `amount` from one currency to another. */
  convert(amount: number, from: string, to: string, opts?: ConvertOptions): Promise<number>;
  /** Convert `amount` from `currency` into the base currency. */
  toBase(amount: number, currency: string, opts?: ToBaseOptions): Promise<number>;
}

export interface CreateCurrencyServiceDeps {
  source: FxRateSource;
  /** Base currency; defaults to EUR (§5.4). */
  baseCurrency?: string;
}

/** Normalise + validate an ISO-4217 code, failing loud on garbage (money path). */
function normalizeCurrency(raw: string): string {
  const parsed = currencyCodeSchema.safeParse(raw.toUpperCase());
  if (!parsed.success) {
    throw new Error(`Invalid currency code: ${JSON.stringify(raw)}`);
  }
  return parsed.data;
}

function assertConvertible(amount: number, rate: number): void {
  if (!Number.isFinite(amount)) {
    throw new Error(`Amount must be a finite number, got ${amount}`);
  }
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`FX rate must be a finite positive number, got ${rate}`);
  }
}

export function createCurrencyService(deps: CreateCurrencyServiceDeps): CurrencyService {
  const baseCurrency = normalizeCurrency(deps.baseCurrency ?? DEFAULT_BASE_CURRENCY);
  const { source } = deps;

  const service: CurrencyService = {
    baseCurrency,

    async getRate(from, to, opts) {
      const fromCode = normalizeCurrency(from);
      const toCode = normalizeCurrency(to);
      if (fromCode === toCode) return 1;
      const rate = opts?.date
        ? await source.getHistoricalRate(fromCode, toCode, opts.date)
        : await source.getSpotRate(fromCode, toCode);
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(
          `FX rate source returned an invalid rate ${rate} for ${fromCode}->${toCode}`,
        );
      }
      return rate;
    },

    async convert(amount, from, to, opts) {
      const rate = await service.getRate(from, to, opts);
      assertConvertible(amount, rate);
      return amount * rate;
    },

    toBase(amount, currency, opts) {
      const base = opts?.base ?? baseCurrency;
      return service.convert(amount, currency, base, { date: opts?.date });
    },
  };

  return service;
}
