import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  ApiError,
  apiRequest,
  apiRetryPolicy,
  backoffDelayMs,
  classifyApiError,
  isApiOutage,
  isConfirmedApiOutcome,
  isConfirmedUnauthorized,
  markRateLimitHandledLocally,
  setAuthResponsePolicy,
} from './apiClient';

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Response;
}

const onUnauthorized = vi.fn();
const onPasswordChangeRequired = vi.fn();
const onRateLimited = vi.fn();
let dispose: () => void;

beforeEach(() => {
  onUnauthorized.mockReset();
  onPasswordChangeRequired.mockReset();
  onRateLimited.mockReset();
  dispose = setAuthResponsePolicy({ onUnauthorized, onPasswordChangeRequired, onRateLimited });
});

afterEach(() => {
  dispose();
  vi.unstubAllGlobals();
});

test.each([0, 500, 503])('classifies status %i as a retryable outage', (status) => {
  const error = new ApiError(status, status === 0 ? 'NETWORK_ERROR' : 'UNKNOWN', 'failed');

  expect(classifyApiError(error)).toBe('outage');
  expect(isApiOutage(error)).toBe(true);
  expect(isConfirmedApiOutcome(error)).toBe(false);
});

test.each([401, 403, 404])('classifies status %i as a confirmed domain outcome', (status) => {
  const error = new ApiError(status, 'UNKNOWN', 'failed');

  expect(classifyApiError(error)).toBe('confirmed-domain-outcome');
  expect(isConfirmedApiOutcome(error)).toBe(true);
  expect(isApiOutage(error)).toBe(false);
});

test('classifies an explicitly known non-terminal-status code as a confirmed outcome', () => {
  const error = new ApiError(400, 'INVALID_INVITE', 'invalid');

  expect(classifyApiError(error, ['INVALID_INVITE'])).toBe('confirmed-domain-outcome');
  expect(isConfirmedApiOutcome(error, ['INVALID_INVITE'])).toBe(true);
  expect(classifyApiError(error)).toBe('unknown');
});

test('leaves untyped and unrecognized failures unknown', () => {
  expect(classifyApiError(new Error('boom'))).toBe('unknown');
  expect(classifyApiError(new ApiError(400, 'UNKNOWN', 'failed'))).toBe('unknown');
});

test('only a 401 is confirmed unauthorized', () => {
  expect(isConfirmedUnauthorized(new ApiError(401, 'UNAUTHENTICATED', 'signed out'))).toBe(true);
  expect(isConfirmedUnauthorized(new ApiError(404, 'NOT_FOUND', 'missing'))).toBe(false);
  expect(isConfirmedUnauthorized(new ApiError(500, 'UNKNOWN', 'failed'))).toBe(false);
});

test('a 401 invokes the unauthorized handler and still throws ApiError', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      jsonResponse(401, {
        error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' },
      }),
    ),
  );

  await expect(apiRequest('/dashboard')).rejects.toBeInstanceOf(ApiError);
  expect(onUnauthorized).toHaveBeenCalledOnce();
  expect(onPasswordChangeRequired).not.toHaveBeenCalled();
});

test('a 403 PASSWORD_CHANGE_REQUIRED springs the forced-change trap', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      jsonResponse(403, {
        error: { code: 'PASSWORD_CHANGE_REQUIRED', message: 'Password change required.' },
      }),
    ),
  );

  await expect(apiRequest('/portfolio')).rejects.toBeInstanceOf(ApiError);
  expect(onPasswordChangeRequired).toHaveBeenCalledOnce();
  expect(onUnauthorized).not.toHaveBeenCalled();
});

test('a generic 403 does not fire the password-change trap', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(jsonResponse(403, { error: { code: 'FORBIDDEN', message: 'No.' } })),
  );

  await expect(apiRequest('/admin/users')).rejects.toBeInstanceOf(ApiError);
  expect(onUnauthorized).not.toHaveBeenCalled();
  expect(onPasswordChangeRequired).not.toHaveBeenCalled();
});

test('suppressAuthRedirect opts a call out of the policy (e.g. login/change-password)', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        jsonResponse(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Bad password.' } }),
      ),
  );

  await expect(
    apiRequest('/auth/change-password', { suppressAuthRedirect: true }),
  ).rejects.toBeInstanceOf(ApiError);
  expect(onUnauthorized).not.toHaveBeenCalled();
});

test('a successful response triggers neither handler', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { ok: true })));

  await expect(apiRequest('/dashboard')).resolves.toEqual({ ok: true });
  expect(onUnauthorized).not.toHaveBeenCalled();
  expect(onPasswordChangeRequired).not.toHaveBeenCalled();
});

test('a 429 invokes onRateLimited with undefined when the wait is nowhere to be found', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        jsonResponse(429, { error: { code: 'RATE_LIMITED', message: 'Too many requests.' } }),
      ),
  );

  await expect(apiRequest('/search')).rejects.toBeInstanceOf(ApiError);
  expect(onRateLimited).toHaveBeenCalledWith(undefined);
  expect(onUnauthorized).not.toHaveBeenCalled();
  expect(onPasswordChangeRequired).not.toHaveBeenCalled();
});

test('a 429 reads the wait from the body when the header is not visible', async () => {
  // The API publishes the wait twice: the `Retry-After` header and the error
  // envelope's `details.retryAfter`. The header only reaches `fetch` if the API
  // lists it in `Access-Control-Expose-Headers` (it does), but a proxy that
  // strips it — or an older API — must not collapse the client's backoff to a
  // fixed floor. The body copy is always readable.
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      jsonResponse(429, {
        error: { code: 'RATE_LIMITED', message: 'Too many requests.', details: { retryAfter: 42 } },
      }),
    ),
  );

  const err = await apiRequest('/search').catch((e: unknown) => e);
  expect((err as ApiError).retryAfterSeconds).toBe(42);
  expect(onRateLimited).toHaveBeenCalledWith(42);
});

test('a 429 accepts the HTTP-date form of Retry-After', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-02T10:00:00Z'));
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          429,
          { error: { code: 'RATE_LIMITED', message: 'Too many requests.' } },
          { 'retry-after': 'Wed, 02 Sep 2026 10:00:25 GMT' },
        ),
      ),
  );

  const err = await apiRequest('/search').catch((e: unknown) => e);
  expect((err as ApiError).retryAfterSeconds).toBe(25);
  vi.useRealTimers();
});

test('the header wins over the body when both are present', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      jsonResponse(
        429,
        {
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests.',
            details: { retryAfter: 99 },
          },
        },
        { 'retry-after': '7' },
      ),
    ),
  );

  const err = await apiRequest('/search').catch((e: unknown) => e);
  expect((err as ApiError).retryAfterSeconds).toBe(7);
});

test('a non-429 failure never reports a wait, even if the body carries one', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          503,
          { error: { code: 'UNAVAILABLE', message: 'Down.', details: { retryAfter: 60 } } },
          { 'retry-after': '60' },
        ),
      ),
  );

  const err = await apiRequest('/search').catch((e: unknown) => e);
  expect((err as ApiError).retryAfterSeconds).toBeUndefined();
  expect(onRateLimited).not.toHaveBeenCalled();
});

describe('retry policy for a rate-limited read (§10)', () => {
  const rateLimited = new ApiError(429, 'RATE_LIMITED', 'Too many requests.', undefined, 20);
  const serverError = new ApiError(503, 'UNAVAILABLE', 'Down.');

  test('never retries a 429 by default', () => {
    const shouldRetry = apiRetryPolicy(1);
    // A plain `retry: 1` fired a second request one second into a cooldown the
    // server had already announced — it could not succeed, and on a page that
    // mounts dozens of queries it doubled the load on a limiter that was
    // already refusing.
    expect(shouldRetry(0, rateLimited)).toBe(false);
    // Transient failures keep their allowance.
    expect(shouldRetry(0, serverError)).toBe(true);
    expect(shouldRetry(1, serverError)).toBe(false);
  });

  test('a surface may buy a bounded rate-limit allowance without widening the rest', () => {
    const shouldRetry = apiRetryPolicy(2, 1);
    expect(shouldRetry(0, rateLimited)).toBe(true);
    expect(shouldRetry(1, rateLimited)).toBe(false);
    expect(shouldRetry(1, serverError)).toBe(true);
    expect(shouldRetry(2, serverError)).toBe(false);
  });

  test('waits the interval the server asked for, jittered, never longer', () => {
    const samples = Array.from({ length: 200 }, () => backoffDelayMs(0, rateLimited));
    for (const delay of samples) {
      expect(delay).toBeGreaterThanOrEqual(10_000); // half of the 20 s ask
      expect(delay).toBeLessThanOrEqual(20_000);
    }
    // Jitter is the point: every tab and every mounted query fails at the same
    // instant, so an unjittered wait re-synchronises them into one herd that
    // arrives together the moment the cooldown lifts — which is what climbs the
    // escalation ladder.
    expect(new Set(samples).size).toBeGreaterThan(50);
  });

  test('falls back to exponential backoff when the server named no interval', () => {
    const first = backoffDelayMs(0, serverError);
    expect(first).toBeGreaterThanOrEqual(500);
    expect(first).toBeLessThanOrEqual(1_000);

    const later = backoffDelayMs(4, serverError);
    expect(later).toBeGreaterThanOrEqual(8_000);
    expect(later).toBeLessThanOrEqual(16_000);
  });

  test('caps the wait so a long cooldown never freezes a surface', () => {
    const hourLong = new ApiError(429, 'RATE_LIMITED', 'Too many requests.', undefined, 3_600);
    expect(backoffDelayMs(0, hourLong)).toBeLessThanOrEqual(60_000);
    expect(backoffDelayMs(20, serverError)).toBeLessThanOrEqual(60_000);
  });
});

test('a 429 passes parsed Retry-After seconds to onRateLimited', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          429,
          { error: { code: 'RATE_LIMITED', message: 'Too many requests.' } },
          { 'retry-after': '30' },
        ),
      ),
  );

  const err = await apiRequest('/search').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).retryAfterSeconds).toBe(30);
  expect(onRateLimited).toHaveBeenCalledWith(30);
});

test('a 429 with suppressAuthRedirect does not invoke onRateLimited', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        jsonResponse(429, { error: { code: 'RATE_LIMITED', message: 'Too many requests.' } }),
      ),
  );

  await expect(apiRequest('/auth/login', { suppressAuthRedirect: true })).rejects.toBeInstanceOf(
    ApiError,
  );
  expect(onRateLimited).not.toHaveBeenCalled();
});

test('a locally handled 429 stays typed without firing the global rate-limit notice', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          429,
          { error: { code: 'RATE_LIMITED', message: 'Too many requests.' } },
          { 'retry-after': '37' },
        ),
      ),
  );
  const signal = markRateLimitHandledLocally(new AbortController().signal);

  const error = await apiRequest('/account/paranoid/normal-revision', { signal }).catch(
    (cause: unknown) => cause,
  );

  expect(error).toMatchObject({ status: 429, code: 'RATE_LIMITED', retryAfterSeconds: 37 });
  expect(onRateLimited).not.toHaveBeenCalled();
});
