import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { ApiError, apiRequest, setAuthResponsePolicy } from './apiClient';

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
  } as unknown as Response;
}

const onUnauthorized = vi.fn();
const onPasswordChangeRequired = vi.fn();
let dispose: () => void;

beforeEach(() => {
  onUnauthorized.mockReset();
  onPasswordChangeRequired.mockReset();
  dispose = setAuthResponsePolicy({ onUnauthorized, onPasswordChangeRequired });
});

afterEach(() => {
  dispose();
  vi.unstubAllGlobals();
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
