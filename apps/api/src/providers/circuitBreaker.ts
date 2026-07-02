/**
 * Per-provider circuit breaker (PROJECTPLAN.md §5.1). After
 * `failureThreshold` consecutive failures the breaker *opens*: subsequent calls
 * fail fast with {@link CircuitOpenError} instead of hammering a sick upstream.
 * After `openMs` the breaker goes *half-open* and lets a single probe through;
 * its result decides whether to close (recovered) or re-open (still down).
 *
 * The market-data service catches `CircuitOpenError` and serves the last cached
 * value as `stale` (stale-while-revalidate), so an open breaker degrades to
 * stale data rather than an error wherever a cached value exists.
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the breaker open. */
  failureThreshold?: number;
  /** Cooldown before a half-open probe is allowed, in ms. */
  openMs?: number;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Failures matching this predicate trip the breaker open immediately,
   * regardless of the consecutive-failure count. Used for upstream 429s
   * (PROJECTPLAN.md §5.3: "429 from upstream opens the circuit breaker").
   */
  tripImmediately?: (err: unknown) => boolean;
}

export class CircuitOpenError extends Error {
  constructor(public readonly providerId?: string) {
    super(
      providerId ? `Circuit breaker open for provider "${providerId}"` : 'Circuit breaker is open',
    );
    this.name = 'CircuitOpenError';
  }
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_OPEN_MS = 30_000;

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly openMs: number;
  private readonly now: () => number;
  private readonly tripImmediately?: (err: unknown) => boolean;

  private state: CircuitState = 'closed';
  private failures = 0;
  private openedAt = 0;
  /** True while a half-open probe is in flight, to admit exactly one. */
  private probing = false;

  constructor(
    private readonly providerId?: string,
    options: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.openMs = options.openMs ?? DEFAULT_OPEN_MS;
    this.now = options.now ?? Date.now;
    this.tripImmediately = options.tripImmediately;
  }

  /** Current state, after applying any elapsed-cooldown transition. */
  getState(): CircuitState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.openMs) {
      return 'half-open';
    }
    return this.state;
  }

  /**
   * Run `fn` through the breaker. Throws {@link CircuitOpenError} immediately
   * when the breaker is open (or a half-open probe is already in flight),
   * without calling `fn`.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (this.now() - this.openedAt < this.openMs) {
        throw new CircuitOpenError(this.providerId);
      }
      // Cooldown elapsed → transition to half-open and let this call probe.
      this.state = 'half-open';
      this.probing = false;
    }

    if (this.state === 'half-open') {
      if (this.probing) throw new CircuitOpenError(this.providerId);
      this.probing = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(err);
      throw err;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.probing = false;
    this.state = 'closed';
  }

  private onFailure(err: unknown): void {
    this.probing = false;
    // An upstream rate limit is a definitive "back off now" — trip without
    // waiting for the consecutive-failure threshold (§5.3).
    if (this.tripImmediately?.(err)) {
      this.trip();
      return;
    }
    if (this.state === 'half-open') {
      // Probe failed → straight back to open with a fresh cooldown.
      this.trip();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.trip();
    }
  }

  private trip(): void {
    this.state = 'open';
    this.openedAt = this.now();
  }

  /** Force the breaker back to its initial closed state (tests/admin). */
  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.openedAt = 0;
    this.probing = false;
  }
}
