/**
 * Outbound request policy — the per-provider request budget (PROJECTPLAN.md
 * §5.2, §5.3): every upstream call runs through a queue with **bounded
 * concurrency** (default 4), a **minimum spacing** between call starts
 * (default 250 ms) and **exponential backoff on 5xx**. This is distinct
 * from, and sits *inside*, the market-data service's timeout → retry-once →
 * circuit-breaker → cache wrapper (§5.1): the breaker protects the app from a
 * sick upstream; this queue keeps us a polite client of an unofficial,
 * rate-limiting API.
 *
 * A 429 is deliberately **not** retried here: rate-limit policy belongs to the
 * circuit breaker (§5.3 — a 429 trips it immediately and stale data is served
 * while it cools down), and the breaker can only own that policy if the 429
 * escapes the queue promptly. Queue-level 429 backoff (~7.5 s of sleeps at the
 * defaults) would outlast the service's 5 s timeout, so the breaker would only
 * ever see TimeoutError while the abandoned retry chain kept calling the
 * already-rate-limiting upstream — the exact impoliteness §5.3 exists to
 * prevent.
 *
 * The sleep/clock are injectable so tests drive backoff and spacing without
 * real waits.
 */

/** Default §5.2/§5.3 policy values. */
export const DEFAULT_CONCURRENCY = 4;
/** Default minimum gap between upstream call starts (§5.3 "minimum spacing"). */
export const DEFAULT_MIN_SPACING_MS = 250;
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8_000;

export interface RequestQueueOptions {
  /** Max simultaneous in-flight calls (§5.2). Default 4. */
  concurrency?: number;
  /**
   * Minimum gap between successive upstream call *starts* across the whole
   * queue, applied to retries too (§5.3). Default 250 ms; 0 disables.
   */
  minSpacingMs?: number;
  /** Backoff retries on a retryable (5xx) failure. Default 4. */
  maxRetries?: number;
  /** First backoff delay; doubles each retry. Default 500 ms. */
  baseDelayMs?: number;
  /** Upper bound on a single backoff delay. Default 8 s. */
  maxDelayMs?: number;
  /** Injectable sleep (tests). Default a real `setTimeout` promise. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for spacing (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Classifies an error as worth backing off + retrying. Default: 5xx. */
  isRetryable?: (err: unknown) => boolean;
}

export interface RequestQueue {
  /** Run `fn` under the concurrency cap, with backoff on retryable failures. */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `yahoo-finance2` sets `error.code` to the HTTP status on its `HTTPError`
 * (verified against the installed v3 source). Only 5xx (server errors) are
 * transient and worth a backed-off retry here. 429 must propagate immediately
 * so the circuit breaker can trip on it (§5.3 — see the module docstring);
 * other 4xx (bad symbol, etc.) are definitive. Network/timeout errors carry no
 * numeric `code` here — those are handled by the service-level retry-once and
 * circuit breaker, not this queue.
 */
export function isRetryableUpstreamError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== 'number') return false;
  return code >= 500 && code < 600;
}

/**
 * A small async semaphore. `acquire` resolves once a slot is free; `release`
 * hands the freed slot directly to the next waiter (so `active` never exceeds
 * the cap) or frees it outright when no one is waiting.
 */
function createSemaphore(max: number) {
  let active = 0;
  const waiters: Array<() => void> = [];

  return {
    acquire(): Promise<void> {
      if (active < max) {
        active += 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    release(): void {
      const next = waiters.shift();
      if (next) {
        next(); // transfer the slot; `active` stays the same
      } else {
        active -= 1;
      }
    },
  };
}

export function createRequestQueue(options: RequestQueueOptions = {}): RequestQueue {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const minSpacingMs = options.minSpacingMs ?? DEFAULT_MIN_SPACING_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const isRetryable = options.isRetryable ?? isRetryableUpstreamError;

  const semaphore = createSemaphore(Math.max(1, concurrency));

  // Next epoch ms an upstream call may start. Reserved synchronously before any
  // await, so concurrent callers can never claim the same slot.
  let nextStartAt = 0;

  /** Minimum-spacing gate (§5.3): resolves when this call may begin. */
  async function reserveStart(): Promise<void> {
    if (minSpacingMs <= 0) return;
    const t = now();
    const scheduled = Math.max(t, nextStartAt);
    nextStartAt = scheduled + minSpacingMs;
    if (scheduled > t) await sleep(scheduled - t);
  }

  async function withBackoff<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await reserveStart();
        return await fn();
      } catch (err) {
        if (attempt >= maxRetries || !isRetryable(err)) throw err;
        const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
        await sleep(delay);
      }
    }
  }

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await semaphore.acquire();
      try {
        return await withBackoff(fn);
      } finally {
        semaphore.release();
      }
    },
  };
}
