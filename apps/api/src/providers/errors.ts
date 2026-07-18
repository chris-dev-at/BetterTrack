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

/**
 * True for errors that mean "this asset does not exist upstream": our own
 * {@link AssetNotFoundError} or a `yahoo-finance2` HTTPError with numeric
 * `code === 404`. Deliberately never matches `ApiError` (its `code` is a
 * string) — local providers' not-founds (e.g. a manual asset the user is about
 * to create) must not be negative-cached.
 */
export function isNotFoundError(err: unknown): boolean {
  if (err instanceof AssetNotFoundError) return true;
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === 404;
}

/** True for an upstream rate-limit response (`yahoo-finance2` HTTPError, code 429). */
export function isRateLimitError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === 429;
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
