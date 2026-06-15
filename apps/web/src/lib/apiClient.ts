import { apiErrorSchema } from '@bettertrack/contracts';

/** Base path for the JSON API (proxied to the API service in dev, same-origin in prod). */
const API_BASE = '/api/v1';

/** The CSRF belt-and-suspenders header the API requires on every mutation (§10). */
const CSRF_HEADER = 'X-Requested-With';
const CSRF_VALUE = 'BetterTrack';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

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
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** 404 to non-admins is intentional (§6.12) — treat it as "not authorized". */
  get isNotAuthorized(): boolean {
    return this.status === 401 || this.status === 404;
  }
}

interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
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
 * The single place for app-wide auth/redirect policy (PROJECTPLAN.md §7.1, §7.4).
 * A mounted auth layer registers handlers; the request chokepoint invokes them
 * when a response demands a session transition:
 *   - `401` → session is gone → bounce to login (preserving intended path).
 *   - `403 PASSWORD_CHANGE_REQUIRED` → trap into the forced-change screen (§6.1).
 * Only one policy is active at a time. The admin world registers none, so its
 * own 401/404 handling (its AuthContext) is unaffected.
 */
export interface AuthResponsePolicy {
  onUnauthorized?: () => void;
  onPasswordChangeRequired?: () => void;
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
  }
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
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!SAFE_METHODS.has(method)) headers[CSRF_HEADER] = CSRF_VALUE;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      credentials: 'include',
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, 'NETWORK_ERROR', 'Unable to reach the server. Check your connection.');
  }

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    const error = parsed.success
      ? new ApiError(
          response.status,
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.details,
        )
      : new ApiError(response.status, 'UNKNOWN', 'Request failed.');
    if (!options.suppressAuthRedirect) notifyAuthPolicy(error);
    throw error;
  }

  return payload as T;
}
