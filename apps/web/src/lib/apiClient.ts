import { apiErrorSchema } from '@bettertrack/contracts';

import { apiBaseUrl } from './runtimeConfig';

/**
 * Base URL for the JSON API. Resolved from the injected runtime config
 * (window.__BT__.apiOrigin): an absolute cross-origin URL in subdomains/ports
 * deployments, or relative `/api/v1` in dev (Vite proxy) and single-origin
 * setups. Read once at module load — config.js runs before the bundle.
 */
const API_BASE = apiBaseUrl();

/**
 * Build a browser URL for a server-owned asset path. Reject absolute and
 * protocol-relative input so an API payload can never turn this helper into a
 * third-party request primitive.
 */
export function apiAssetUrl(path: string): string | null {
  if (!path.startsWith('/') || path.startsWith('//') || !/^\/[A-Za-z0-9/_-]+$/.test(path)) {
    return null;
  }
  return `${API_BASE}${path}`;
}

/** The CSRF belt-and-suspenders header the API requires on every mutation (§10). */
const CSRF_HEADER = 'X-Requested-With';
const CSRF_VALUE = 'BetterTrack';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Typed error mirroring the API's `{ error: { code, message, details? } }`
 * envelope (PROJECTPLAN.md §8). Callers branch on `status`/`code` rather than
 * parsing strings.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    /** Seconds until the rate limit resets, parsed from Retry-After (429 only). */
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** 404 to non-admins is intentional (§6.12) — treat it as "not authorized". */
  get isNotAuthorized(): boolean {
    return this.status === 401 || this.status === 404;
  }
}

/**
 * Signals whose 429 response is owned by the calling surface rather than the
 * app-wide "too fast" toast. The signal keeps this opt-out request-scoped: a
 * concurrent request that is not part of that operation still follows the
 * global policy.
 */
const LOCALLY_HANDLED_RATE_LIMIT_SIGNALS = new WeakSet<AbortSignal>();

export function markRateLimitHandledLocally(signal: AbortSignal): AbortSignal {
  LOCALLY_HANDLED_RATE_LIMIT_SIGNALS.add(signal);
  return signal;
}

/** The read half of {@link markRateLimitHandledLocally}. */
export function isRateLimitHandledLocally(signal: AbortSignal | null | undefined): boolean {
  return signal != null && LOCALLY_HANDLED_RATE_LIMIT_SIGNALS.has(signal);
}

export type ApiFailureClassification = 'outage' | 'confirmed-domain-outcome' | 'unknown';

const CONFIRMED_DOMAIN_STATUSES = new Set([401, 403, 404]);

/**
 * Classify a client failure without making each surface reinterpret HTTP
 * statuses independently. Network failures and server errors are retryable
 * outages; authentication/authorization/not-found responses and explicitly
 * named domain codes are confirmed outcomes. Everything else stays unknown so
 * callers can fail safely instead of presenting a guessed terminal state.
 */
export function classifyApiError(
  error: unknown,
  knownDomainCodes: readonly string[] = [],
): ApiFailureClassification {
  if (!(error instanceof ApiError)) return 'unknown';
  if (error.status === 0 || error.status >= 500) return 'outage';
  if (CONFIRMED_DOMAIN_STATUSES.has(error.status) || knownDomainCodes.includes(error.code)) {
    return 'confirmed-domain-outcome';
  }
  return 'unknown';
}

export function isApiOutage(error: unknown): error is ApiError {
  return classifyApiError(error) === 'outage';
}

export function isConfirmedApiOutcome(
  error: unknown,
  knownDomainCodes: readonly string[] = [],
): error is ApiError {
  return classifyApiError(error, knownDomainCodes) === 'confirmed-domain-outcome';
}

/** Only a confirmed 401 proves that a previously usable session is gone. */
export function isConfirmedUnauthorized(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status === 401 &&
    classifyApiError(error) === 'confirmed-domain-outcome'
  );
}

interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
  /**
   * Let the request outlive the page (fetch's `keepalive`). Only for the last
   * write of a closing tab — the Home board's `pagehide` flush — where an
   * ordinary fetch would be cancelled mid-flight. Browsers cap keepalive bodies
   * at 64 KB in total, so it must never be used for bulk writes.
   */
  keepalive?: boolean;
  /**
   * Skip the global auth-response policy (below) for this call. The auth
   * endpoints themselves opt out: a `401` on `/auth/login` or
   * `/auth/change-password` (wrong password) is an in-form error the caller
   * shows — it must never trigger a session-expiry redirect or eject a user
   * from the forced-change screen.
   */
  suppressAuthRedirect?: boolean;
}

/**
 * The single place for app-wide auth/redirect/toast policy (PROJECTPLAN.md §7.1, §7.4).
 * A mounted auth layer registers handlers; the request chokepoint invokes them
 * when a response demands a session transition or a user-visible notification:
 *   - `401` → session is gone → bounce to login (preserving intended path).
 *   - `403 PASSWORD_CHANGE_REQUIRED` → trap into the forced-change screen (§6.1).
 *   - `429 RATE_LIMITED` → surface a non-blocking toast so the user knows to slow down.
 * Only one policy is active at a time. The admin world registers none, so its
 * own 401/404 handling (its AuthContext) is unaffected.
 */
export interface AuthResponsePolicy {
  onUnauthorized?: () => void;
  onPasswordChangeRequired?: () => void;
  onRateLimited?: (retryAfterSeconds?: number) => void;
}

let activePolicy: AuthResponsePolicy | null = null;

/** Install the active policy; returns a disposer that clears it (only if still current). */
export function setAuthResponsePolicy(policy: AuthResponsePolicy): () => void {
  activePolicy = policy;
  return () => {
    if (activePolicy === policy) activePolicy = null;
  };
}

function notifyAuthPolicy(error: ApiError): void {
  if (!activePolicy) return;
  if (error.status === 401) {
    activePolicy.onUnauthorized?.();
  } else if (error.status === 403 && error.code === 'PASSWORD_CHANGE_REQUIRED') {
    activePolicy.onPasswordChangeRequired?.();
  } else if (error.status === 429) {
    activePolicy.onRateLimited?.(error.retryAfterSeconds);
  }
}

/**
 * Read the wait a 429 asks for, from BOTH places the API publishes it:
 *
 *  1. the `Retry-After` header — delta-seconds or, per RFC 9110, an HTTP-date;
 *  2. the error envelope's `details.retryAfter` (seconds), which is the only
 *     copy guaranteed to survive a cross-origin read.
 *
 * The header is the primary source, but the SPA and the API sit on different
 * origins in both deployment modes (§4.6), so it is only visible when the API
 * lists it in `Access-Control-Expose-Headers` (it does — see the API's
 * `cors.ts`). The body fallback means a client that talks to an older API — or
 * a proxy that strips the header — still backs off for the right duration
 * instead of silently collapsing to a fixed one-second floor.
 */
function parseRetryAfter(header: string | null, payload: unknown): number | undefined {
  const fromHeader = parseRetryAfterHeader(header);
  if (fromHeader !== undefined) return fromHeader;
  return retryAfterFromBody(payload);
}

function parseRetryAfterHeader(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  }
  // HTTP-date form: convert to a delta against the local clock. Clock skew can
  // only make this too small or too large by seconds, which the jittered
  // backoff below absorbs.
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  const seconds = Math.ceil((at - Date.now()) / 1000);
  return seconds > 0 ? seconds : undefined;
}

function retryAfterFromBody(payload: unknown): number | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const details = (error as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) return undefined;
  const retryAfter = (details as { retryAfter?: unknown }).retryAfter;
  return typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0
    ? retryAfter
    : undefined;
}

/** Ceiling on any automatic wait, so a long cooldown never freezes a surface. */
const MAX_BACKOFF_MS = 60_000;

/**
 * Milliseconds to wait before re-attempting a failed request, with FULL JITTER.
 *
 * Jitter is not cosmetic here: every tab, every widget and every polling hook
 * fails at the same instant when a limiter trips, so an unjittered backoff
 * re-synchronises them into one thundering herd that arrives the moment the
 * cooldown expires — which is exactly how a first-rung 20 s pause climbs to the
 * 10 min rung (§10's escalation ladder). Randomising across the window spreads
 * the recovery instead.
 */
export function backoffDelayMs(attempt: number, error: unknown): number {
  const retryAfterMs =
    error instanceof ApiError && error.retryAfterSeconds
      ? error.retryAfterSeconds * 1_000
      : undefined;
  const base = retryAfterMs ?? Math.min(1_000 * 2 ** attempt, MAX_BACKOFF_MS);
  const ceiling = Math.min(base, MAX_BACKOFF_MS);
  // Full jitter over [ceiling/2, ceiling] — never earlier than half the wait the
  // server asked for, never later than the wait itself plus scheduling slop.
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

/**
 * TanStack `retry` predicate with a SEPARATE, much smaller allowance for 429.
 *
 * The default `rateLimitRetries: 0` means a rate-limited read is not retried at
 * all. The server has already said it is turning requests away for
 * `retryAfterSeconds`; a retry on the library's fixed 1 s timer is guaranteed to
 * land inside that cooldown, so it cannot succeed — it only doubles the load on
 * a limiter that is already refusing, and the doubled traffic is then what
 * climbs the next rung of §10's escalation ladder when the cooldown lifts. On a
 * page that mounts dozens of queries, that doubling is the difference between a
 * 20 s pause and a 10 min one.
 *
 * A surface that MUST eventually succeed — the app gate, the session bootstrap —
 * may buy exactly one rate-limit attempt, which {@link backoffDelayMs} schedules
 * at the server's own Retry-After with jitter rather than on the 1 s timer.
 */
export function apiRetryPolicy(maxRetries: number, rateLimitRetries = 0) {
  return (failureCount: number, error: unknown): boolean => {
    if (error instanceof ApiError && error.status === 429) {
      return failureCount < rateLimitRetries;
    }
    return failureCount < maxRetries;
  };
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (!query) return `${API_BASE}${path}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${API_BASE}${path}?${qs}` : `${API_BASE}${path}`;
}

/**
 * Single fetch chokepoint: attaches credentials + the CSRF header on mutations,
 * and normalizes failures into {@link ApiError}. Never throws a bare network
 * error string — callers always get a typed error.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  // A FormData body (the CSV import upload, §13.4 V4-P8) travels as multipart —
  // fetch sets the boundary-bearing Content-Type itself, so don't override it.
  const isFormData = options.body instanceof FormData;
  if (options.body !== undefined && !isFormData) headers['Content-Type'] = 'application/json';
  if (!SAFE_METHODS.has(method)) headers[CSRF_HEADER] = CSRF_VALUE;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      credentials: 'include',
      body:
        options.body === undefined
          ? undefined
          : isFormData
            ? (options.body as FormData)
            : JSON.stringify(options.body),
      signal: options.signal,
      keepalive: options.keepalive,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, 'NETWORK_ERROR', 'Unable to reach the server. Check your connection.');
  }

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const retryAfterSeconds =
      response.status === 429
        ? parseRetryAfter(response.headers.get('Retry-After'), payload)
        : undefined;
    const parsed = apiErrorSchema.safeParse(payload);
    const error = parsed.success
      ? new ApiError(
          response.status,
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.details,
          retryAfterSeconds,
        )
      : new ApiError(response.status, 'UNKNOWN', 'Request failed.', undefined, retryAfterSeconds);
    const rateLimitHandledLocally =
      error.status === 429 && isRateLimitHandledLocally(options.signal);
    if (!options.suppressAuthRedirect && !rateLimitHandledLocally) notifyAuthPolicy(error);
    throw error;
  }

  return payload as T;
}
