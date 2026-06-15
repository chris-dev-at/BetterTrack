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
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      throw new ApiError(response.status, code, message, details);
    }
    throw new ApiError(response.status, 'UNKNOWN', 'Request failed.');
  }

  return payload as T;
}
