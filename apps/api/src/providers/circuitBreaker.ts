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
import { providerCallsTotal } from '../metrics';

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
  /**
   * Failures matching this predicate are breaker-NEUTRAL: an authoritative
   * answer from a *healthy* upstream (a 404 for an unknown symbol) says nothing
   * about that provider's health, so it must not count toward the consecutive-
   * failure threshold and must not knock a half-open probe back to open — the
   * probe outcome is decided by transient failures alone (§13.5 V5-P1c).
   * Evaluated AFTER {@link tripImmediately}, so a 429 keeps tripping the breaker
   * immediately even if both predicates would match it.
   */
  ignoreFailure?: (err: unknown) => boolean;
  /**
   * Called each time the breaker transitions TO open — a definitive provider
   * failure. Wired to the admin Problems capture (§13.5 V5-P2 arc (d)). Must
   * never throw; the breaker ignores its return.
   */
  onOpen?: (err: unknown, meta: { providerId?: string }) => void;
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

/** Longest error note the breaker will retain, so a huge message cannot be pinned. */
const LAST_ERROR_MAX_LENGTH = 300;

/**
 * A one-line note about a failure: its error class, or its message when the
 * class is the generic `Error`. Mirrors `healthService`'s `errorDetail`, which
 * is the disclosure level the admin health component already publishes.
 */
function describeError(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const note = err.name && err.name !== 'Error' ? err.name : err.message;
  if (!note) return null;
  return note.length > LAST_ERROR_MAX_LENGTH
    ? `${note.slice(0, LAST_ERROR_MAX_LENGTH - 1)}…`
    : note;
}

/**
 * Read-only introspection of one breaker, for the admin operations cockpit
 * (#1406 W4). Everything here is state the breaker already keeps privately;
 * reading it never creates, trips or resets anything.
 */
export interface CircuitBreakerSnapshot {
  state: CircuitState;
  /** Consecutive failures since the last success — progress toward tripping. */
  consecutiveFailures: number;
  /** The threshold `consecutiveFailures` is counted against. */
  failureThreshold: number;
  /** Epoch ms the breaker last tripped open; null if it never has. */
  openedAtMs: number | null;
  /** Epoch ms a half-open probe becomes admissible; null unless open. */
  retryAtMs: number | null;
  /**
   * Error class of the failure that last tripped this breaker (falling back to
   * its message when the class is anonymous) — deliberately the same shape
   * `healthService.errorDetail` already publishes, never the whole error.
   */
  lastError: string | null;
  /** Epoch ms of that failure. */
  lastErrorAtMs: number | null;
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly openMs: number;
  private readonly now: () => number;
  private readonly tripImmediately?: (err: unknown) => boolean;
  private readonly ignoreFailure?: (err: unknown) => boolean;
  private readonly onOpen?: (err: unknown, meta: { providerId?: string }) => void;

  private state: CircuitState = 'closed';
  private failures = 0;
  private openedAt = 0;
  /** True while a half-open probe is in flight, to admit exactly one. */
  private probing = false;
  /**
   * The tripping failure, retained ONLY as its error class (or message) plus a
   * timestamp. The error object itself is never held: keeping it would pin an
   * arbitrary object — possibly carrying a request body — alive for the life of
   * the process, on a field an admin surface reads.
   */
  private lastError: string | null = null;
  private lastErrorAt = 0;

  constructor(
    private readonly providerId?: string,
    options: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.openMs = options.openMs ?? DEFAULT_OPEN_MS;
    this.now = options.now ?? Date.now;
    this.tripImmediately = options.tripImmediately;
    this.ignoreFailure = options.ignoreFailure;
    this.onOpen = options.onOpen;
  }

  /** Current state, after applying any elapsed-cooldown transition. */
  getState(): CircuitState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.openMs) {
      return 'half-open';
    }
    return this.state;
  }

  /**
   * Everything the admin cockpit is allowed to know about this breaker (#1406
   * W4). Pure read: it calls {@link getState}, which applies the elapsed-cooldown
   * transition without mutating, and touches nothing else.
   */
  snapshot(): CircuitBreakerSnapshot {
    const state = this.getState();
    return {
      state,
      consecutiveFailures: this.failures,
      failureThreshold: this.failureThreshold,
      openedAtMs: this.openedAt === 0 ? null : this.openedAt,
      // Only meaningful while the cooldown is still running: once it elapses the
      // breaker reads half-open and the next call IS the probe.
      retryAtMs: state === 'open' ? this.openedAt + this.openMs : null,
      lastError: this.lastError,
      lastErrorAtMs: this.lastErrorAt === 0 ? null : this.lastErrorAt,
    };
  }

  /**
   * Run `fn` through the breaker. Throws {@link CircuitOpenError} immediately
   * when the breaker is open (or a half-open probe is already in flight),
   * without calling `fn`.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Provider-call metric label (§13.5 V5-P2): the provider id, or `unknown`
    // for an unlabelled breaker. A short-circuited call is its own outcome, so
    // dashboards can tell "upstream errored" from "we never called upstream".
    const provider = this.providerId ?? 'unknown';

    if (this.state === 'open') {
      if (this.now() - this.openedAt < this.openMs) {
        providerCallsTotal.inc({ provider, outcome: 'circuit_open' });
        throw new CircuitOpenError(this.providerId);
      }
      // Cooldown elapsed → transition to half-open and let this call probe.
      this.state = 'half-open';
      this.probing = false;
    }

    if (this.state === 'half-open') {
      if (this.probing) {
        providerCallsTotal.inc({ provider, outcome: 'circuit_open' });
        throw new CircuitOpenError(this.providerId);
      }
      this.probing = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      providerCallsTotal.inc({ provider, outcome: 'success' });
      return result;
    } catch (err) {
      this.onFailure(err);
      providerCallsTotal.inc({ provider, outcome: 'error' });
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
      this.trip(err);
      return;
    }
    // A definitive answer from a healthy upstream (unknown symbol / 404) is not
    // a provider failure: leave the state and the consecutive-failure count
    // exactly as they were. Releasing `probing` above means a half-open breaker
    // stays half-open and simply lets the next call be the real probe.
    if (this.ignoreFailure?.(err)) return;
    if (this.state === 'half-open') {
      // Probe failed → straight back to open with a fresh cooldown.
      this.trip(err);
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.trip(err);
    }
  }

  private trip(err?: unknown): void {
    this.state = 'open';
    this.openedAt = this.now();
    this.lastError = describeError(err);
    this.lastErrorAt = this.openedAt;
    // A tripped breaker is a definitive provider failure → capture it (§13.5).
    this.onOpen?.(err, { providerId: this.providerId });
  }

  /** Force the breaker back to its initial closed state (tests/admin). */
  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.openedAt = 0;
    this.probing = false;
    this.lastError = null;
    this.lastErrorAt = 0;
  }
}
