/**
 * Outbound request policy for the Yahoo provider (PROJECTPLAN.md §5.2): every
 * upstream call runs through a queue with **concurrency 4** and **exponential
 * backoff on 429/5xx**. This is distinct from, and sits *inside*, the
 * market-data service's timeout → retry-once → circuit-breaker → cache wrapper
 * (§5.1): the breaker protects the app from a sick upstream; this queue keeps us
 * a polite client of an unofficial, rate-limiting API.
 *
 * The sleep clock is injectable so tests drive backoff without real waits.
 */

/** Default §5.2 policy values. */
export const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8_000;

export interface RequestQueueOptions {
  /** Max simultaneous in-flight calls (§5.2). Default 4. */
  concurrency?: number;
  /** Backoff retries on a retryable (429/5xx) failure. Default 4. */
  maxRetries?: number;
  /** First backoff delay; doubles each retry. Default 500 ms. */
  baseDelayMs?: number;
  /** Upper bound on a single backoff delay. Default 8 s. */
  maxDelayMs?: number;
  /** Injectable sleep (tests). Default a real `setTimeout` promise. */
  sleep?: (ms: number) => Promise<void>;
  /** Classifies an error as worth backing off + retrying. Default: 429/5xx. */
  isRetryable?: (err: unknown) => boolean;
}

export interface RequestQueue {
  /** Run `fn` under the concurrency cap, with backoff on retryable failures. */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `yahoo-finance2` sets `error.code` to the HTTP status on its `HTTPError`
 * (verified against the installed v3 source). 429 (rate limit) and 5xx (server)
 * are transient and worth a backed-off retry; 4xx (bad symbol, etc.) are not.
 * Network/timeout errors carry no numeric `code` here — those are handled by the
 * service-level retry-once and circuit breaker, not this queue.
 */
export function isRetryableUpstreamError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== 'number') return false;
  return code === 429 || (code >= 500 && code < 600);
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
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? realSleep;
  const isRetryable = options.isRetryable ?? isRetryableUpstreamError;

  const semaphore = createSemaphore(Math.max(1, concurrency));

  async function withBackoff<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
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
