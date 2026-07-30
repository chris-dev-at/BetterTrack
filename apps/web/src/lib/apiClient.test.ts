import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  ApiError,
  apiRequest,
  classifyApiError,
  isApiOutage,
  isConfirmedApiOutcome,
  isConfirmedUnauthorized,
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

test('a 429 invokes onRateLimited with undefined when no Retry-After header', async () => {
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
