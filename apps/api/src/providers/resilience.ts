/**
 * Low-level call resilience for upstream provider requests (PROJECTPLAN.md
 * §5.1): a 5 s timeout and retry-once. The circuit breaker (see
 * `circuitBreaker.ts`) wraps the result of these so a flapping upstream trips
 * fast instead of hammering on every request.
 */

/** Default upstream timeout (§5.1). */
export const DEFAULT_TIMEOUT_MS = 5_000;

/** Raised when an upstream call exceeds its timeout budget. */
export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Reject if `fn` has not settled within `ms`. The underlying promise is not
 * cancellable (JS has no cancellation), so the abandoned work may still
 * complete in the background — we simply stop waiting on it. The timer is
 * always cleared so a fast result never leaks a pending handle.
 */
export function withTimeout<T>(fn: () => Promise<T>, ms: number = DEFAULT_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new TimeoutError(ms));
    }, ms);

    fn().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err as Error);
      },
    );
  });
}

/**
 * Run `fn`; on failure run it at most once more (§5.1, "retry-once"). The second
 * failure propagates. `shouldRetry` (default: always) short-circuits the retry
 * for definitive failures — a rate limit or a not-found cannot change on a
 * second attempt, so retrying only doubles the upstream cost. Both attempts
 * share the same timeout budget when composed via {@link withTimeout}.
 */
export async function retryOnce<T>(
  fn: () => Promise<T>,
  shouldRetry: (err: unknown) => boolean = () => true,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!shouldRetry(err)) throw err;
    return await fn();
  }
}
