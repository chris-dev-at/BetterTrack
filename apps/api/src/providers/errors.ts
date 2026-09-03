/**
 * Error classification for the caching keystone (PROJECTPLAN.md §5.3). The
 * cache and circuit breaker treat upstream failures differently by kind:
 *
 *  - **not-found** (unknown symbol, 404) → negative-cached for 15 min so
 *    repeated misses don't hammer the provider;
 *  - **rate limit** (429) → opens the circuit breaker immediately and stretches
 *    TTLs (stale keeps being served, no upstream attempts) instead of erroring;
 *  - everything else (timeouts, 5xx, network) → transient, never cached.
 */

/**
 * The asset does not exist upstream (unknown symbol / 404) — a definitive
 * answer, not a transient failure, so it is negative-cacheable per §5.3.
 * `fromNegativeCache` is true when re-thrown from a cached negative entry
 * without an upstream call.
 */
export class AssetNotFoundError extends Error {
  constructor(
    message: string,
    public readonly fromNegativeCache = false,
  ) {
    super(message);
    this.name = 'AssetNotFoundError';
  }
}

type YahooEnvelopeStatus = 404 | 429;

const YAHOO_ENVELOPE_ERROR_NAMES: Record<YahooEnvelopeStatus, string> = {
  404: 'NotFoundError',
  429: 'TooManyRequestsError',
};

const YAHOO_ENVELOPE_ERROR_MESSAGES: Record<YahooEnvelopeStatus, ReadonlySet<string>> = {
  404: new Set(['No data found, symbol may be delisted']),
  429: new Set(['Too Many Requests']),
};

// Every entry must remain ^…$-anchored — see the rationale in the doc block below.
const YAHOO_ENVELOPE_ERROR_PATTERNS: Partial<Record<YahooEnvelopeStatus, readonly RegExp[]>> = {
  404: [/^Quote not found for ticker symbol: .+$/],
};

/**
 * `yahoo-finance2` checks Yahoo's JSON error envelope before `response.ok`.
 * That path derives a class name from the envelope's string `code`, but v4
 * falls back to a plain `Error` for names it does not export and never copies
 * the numeric HTTP status onto the error. Keep these fallbacks deliberately
 * narrow: the derived Yahoo name (or plain fallback) must be paired with one
 * of Yahoo's known status descriptions. `yahoo-finance2` throws the envelope's
 * `description` as the message, never its `code`, so bare `'Not Found'` is
 * deliberately absent as unattested. Every `YAHOO_ENVELOPE_ERROR_PATTERNS`
 * entry must remain start- and end-anchored (`^…$`) because a match feeds the
 * negative cache.
 */
function isYahooEnvelopeStatusError(err: unknown, status: YahooEnvelopeStatus): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name !== 'Error' && err.name !== YAHOO_ENVELOPE_ERROR_NAMES[status]) return false;
  return (
    YAHOO_ENVELOPE_ERROR_MESSAGES[status].has(err.message) ||
    YAHOO_ENVELOPE_ERROR_PATTERNS[status]?.some((pattern) => pattern.test(err.message)) === true
  );
}

/**
 * True for errors that mean "this asset does not exist upstream": our own
 * {@link AssetNotFoundError}, a `yahoo-finance2` HTTPError with numeric
 * `code === 404`, or its JSON-envelope equivalent. Deliberately never matches
 * `ApiError` (its `code` is a string) — local providers' not-founds (e.g. a
 * manual asset the user is about to create) must not be negative-cached.
 */
export function isNotFoundError(err: unknown): boolean {
  if (err instanceof AssetNotFoundError) return true;
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === 404 || isYahooEnvelopeStatusError(err, 404);
}

/** True for a Yahoo numeric HTTPError or JSON-envelope rate-limit response. */
export function isRateLimitError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === 429 || isYahooEnvelopeStatusError(err, 429);
}

/**
 * A market-intelligence capability (§13.5 V5-P5) was requested from a provider
 * that does not implement it. Distinct from a not-found or a transient upstream
 * error: the provider is healthy, it just does not advertise this capability, so
 * the read service degrades to the "unconfigured" shape rather than retrying.
 * Callers normally consult `providerCapabilities` first, so this is a guard.
 */
export class CapabilityUnavailableError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly capability: string,
  ) {
    super(`Provider "${providerId}" does not implement the "${capability}" capability`);
    this.name = 'CapabilityUnavailableError';
  }
}

/**
 * The valuation path asked for a history series on a specific price basis and
 * the provider cannot produce it (§16 2026-09-03) — it declares `adjusted` and
 * implements no `getUnadjustedHistory`, or declares no basis at all (unknown is
 * never "equal", the same rule the failover chain applies).
 *
 * Deliberately NOT a not-found: the asset exists and the provider is healthy, so
 * negative-caching it would blank the asset for a whole TTL window. It is a
 * refusal — the caller degrades (portfolio history falls back to its stored
 * rows) instead of multiplying stored quantities by a series on the wrong basis.
 */
export class HistoryBasisUnavailableError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly basis: string,
  ) {
    super(`Provider "${providerId}" cannot serve history on the "${basis}" basis`);
    this.name = 'HistoryBasisUnavailableError';
  }
}
