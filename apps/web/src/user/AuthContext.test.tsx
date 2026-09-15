import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { MeResponse } from '@bettertrack/contracts';

vi.mock('../lib/userApi');

import { ApiError } from '../lib/apiClient';
import { FEATURE_FLAGS_QUERY_KEY } from '../lib/featureFlags';
import * as api from '../lib/userApi';
import { AuthProvider, useAuth } from './AuthContext';
import {
  hasBeenAskedToRemember,
  markAskedToRemember,
  readRememberedAccount,
  writeRememberedAccount,
} from './auth/rememberedAccount';
import { VAULT_LOCK_REQUEST_EVENT, vaultLockSignalStorageKey } from './vault/lockSignal';
import { createVaultTransferRuntime } from './vault/qr/runtime';

const member: MeResponse = {
  id: 'user-1',
  email: 'jane@bettertrack.test',
  username: 'jane',
  role: 'user',
  status: 'active',
  mustChangePassword: false,
  pinEnabled: false,
  pinLockIdleMinutes: null,
  baseCurrency: 'EUR',
  locale: 'en',
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function AuthProbe() {
  const { status, user, retrySession, logout, login } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.username ?? 'none'}</span>
      <span data-testid="icon">{user?.profileIcon ?? 'none'}</span>
      <button type="button" onClick={retrySession}>
        Retry session
      </button>
      <button
        type="button"
        onClick={() => void login({ identifier: 'jane', password: 'correct horse' })}
      >
        Sign in
      </button>
      <button type="button" onClick={() => void logout()}>
        Sign out
      </button>
    </div>
  );
}

function renderProvider() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

async function expectStatus(status: string) {
  await waitFor(() => {
    expect(screen.getByTestId('status')).toHaveTextContent(status);
  });
}

afterEach(() => {
  vi.useRealTimers();
});

test.each([0, 500])(
  'a status %i bootstrap outage stays session-unavailable until a successful retry',
  async (status) => {
    vi.mocked(api.getMe)
      .mockRejectedValueOnce(
        new ApiError(status, status === 0 ? 'NETWORK_ERROR' : 'UNKNOWN', 'unavailable'),
      )
      .mockResolvedValueOnce(member);
    const user = userEvent.setup();

    renderProvider();

    await expectStatus('session-unavailable');
    expect(screen.getByTestId('status')).not.toHaveTextContent('anonymous');

    await user.click(screen.getByRole('button', { name: 'Retry session' }));

    await expectStatus('authenticated');
    expect(screen.getByTestId('user')).toHaveTextContent('jane');
  },
);

test('an outage during a recheck preserves the already resolved user', async () => {
  vi.mocked(api.getMe)
    .mockResolvedValueOnce(member)
    .mockRejectedValueOnce(new ApiError(500, 'UNKNOWN', 'unavailable'));
  const user = userEvent.setup();

  renderProvider();
  await expectStatus('authenticated');

  await user.click(screen.getByRole('button', { name: 'Retry session' }));

  await expectStatus('session-unavailable');
  expect(screen.getByTestId('user')).toHaveTextContent('jane');
});

test('a confirmed 401 keeps the existing anonymous transition', async () => {
  vi.mocked(api.getMe).mockRejectedValue(
    new ApiError(401, 'UNAUTHENTICATED', 'Authentication required.'),
  );

  renderProvider();

  await expectStatus('anonymous');
  expect(screen.getByTestId('user')).toHaveTextContent('none');
});

test('the existing PIN idle deadline also revokes the unlocked vault immediately', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-07-30T10:00:00.000Z'));
  const pinMember = { ...member, pinEnabled: true, pinLockIdleMinutes: 1 };
  localStorage.setItem(
    'bettertrack.pinActivity',
    JSON.stringify({ u: pinMember.id, t: Date.now() }),
  );
  vi.mocked(api.getMe).mockResolvedValue(pinMember);
  const lockRequested = vi.fn();
  globalThis.addEventListener(VAULT_LOCK_REQUEST_EVENT, lockRequested);

  try {
    renderProvider();
    await expectStatus('authenticated');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_001);
    });

    expect(screen.getByTestId('status')).toHaveTextContent('pin-required');
    expect(lockRequested).toHaveBeenCalledOnce();
  } finally {
    globalThis.removeEventListener(VAULT_LOCK_REQUEST_EVENT, lockRequested);
  }
});

test('normal-mode logout broadcasts the account lock to another tab transfer runtime', async () => {
  vi.mocked(api.getMe).mockResolvedValue(member);
  vi.mocked(api.logout).mockResolvedValue();
  const runtime = createVaultTransferRuntime({
    bindLockSignal: true,
    requestJson: vi.fn(),
  });
  runtime.setAccountId(member.id);
  const sessionEnded = vi.fn();
  runtime.keystore.subscribeToSessionEnd(sessionEnded);

  try {
    renderProvider();
    await expectStatus('authenticated');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));

    await expectStatus('anonymous');
    expect(sessionEnded).toHaveBeenCalledTimes(1);
    const key = vaultLockSignalStorageKey(member.id);
    const value = localStorage.getItem(key);
    expect(value).not.toBeNull();

    globalThis.dispatchEvent(new StorageEvent('storage', { key, newValue: value }));
    expect(sessionEnded).toHaveBeenCalledTimes(2);
  } finally {
    runtime.dispose();
  }
});

test('a rate-limited bootstrap waits out Retry-After and then gives up into the retryable gate', async () => {
  // The session bootstrap is the ONE request every signed-in visit makes before
  // anything else, so its 429 path is the most dangerous retry loop in the app:
  // it used to be an uncapped recursive timer with a 1 s floor, which polled
  // `/auth/me` once a second forever behind the splash whenever `Retry-After`
  // was unreadable (§10, §16 2026-09-02).
  vi.useFakeTimers();
  // Pin the jitter so each advance below crosses exactly ONE scheduled retry.
  // The randomised spread itself is covered in `lib/apiClient.test.ts`; what
  // matters here is that the wait is derived from the server's 20 s ask
  // (0.5 jitter ⇒ 15 s) and not from the old 1 s floor.
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const RETRY_AFTER_SEC = 20;
  const JITTERED_WAIT_MS = 15_000;
  vi.mocked(api.getMe).mockRejectedValue(
    new ApiError(429, 'RATE_LIMITED', 'Too many requests.', undefined, RETRY_AFTER_SEC),
  );

  renderProvider();

  // The first attempt fires on mount and is refused. The splash holds — a 429
  // is not a signed-out outcome and must never fall through to `/login`.
  await act(async () => {});
  expect(api.getMe).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('status')).not.toHaveTextContent('anonymous');

  // Nothing is retried before the server's own interval — and nowhere near the
  // 1 s timer a plain retry would have used.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(JITTERED_WAIT_MS - 1);
  });
  expect(api.getMe).toHaveBeenCalledTimes(1);

  // Three bounded retries, each waiting out its own Retry-After.
  for (const attempt of [2, 3, 4]) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(attempt === 2 ? 1 : JITTERED_WAIT_MS);
    });
    expect(api.getMe).toHaveBeenCalledTimes(attempt);
  }

  // The fourth refusal exhausts the cap: the splash hands over to the retryable
  // gate, which asks the USER to retry — a human-paced request, not a machine
  // one — instead of hammering a limiter that is already refusing.
  expect(screen.getByTestId('status')).toHaveTextContent('session-unavailable');

  // …and no further attempt is ever scheduled, however long the page is left open.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10 * 60_000);
  });
  expect(api.getMe).toHaveBeenCalledTimes(4);
});

test('a rate-limited bootstrap still recovers on its own when the cooldown lifts', async () => {
  // The cap must not cost the ordinary recovery: a single 429 inside the
  // allowance resolves without the user touching anything.
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.mocked(api.getMe)
    .mockRejectedValueOnce(new ApiError(429, 'RATE_LIMITED', 'Too many requests.', undefined, 20))
    .mockResolvedValueOnce(member);

  renderProvider();

  await act(async () => {});
  expect(api.getMe).toHaveBeenCalledTimes(1);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });

  expect(api.getMe).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
  expect(screen.getByTestId('user')).toHaveTextContent('jane');
});

// ─── The remembered-account record stays current (§13.5 V5-P0 (c), #399 §B) ────
// It is written ONCE, at the remember-me opt-in, so without a refresh a user who
// picks a curated icon afterwards keeps seeing the lettered tile in the OAuth
// chooser on every cold visit — forever.

// The record's own contract types `userId` as a uuid, so these tests sign in as
// a uuid-keyed twin of `member`.
const REMEMBERED_ID = '8d7cf3d6-e8b8-4fa4-98a4-8712cddc05bf';
const OTHER_ID = '2a2f9b4e-2f4d-4d4b-9a6a-2f5f4f0a1c77';
const remembered: MeResponse = { ...member, id: REMEMBERED_ID };

test('logging in again refreshes the remembered record from the fresh MeResponse', async () => {
  // Remembered before the user ever picked an icon, on a device that has already
  // seen the one-shot remember-me prompt.
  writeRememberedAccount({ userId: REMEMBERED_ID, username: 'jane', profileIcon: null });
  markAskedToRemember(REMEMBERED_ID);
  vi.mocked(api.getMe).mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'nope'));
  vi.mocked(api.login).mockResolvedValue({
    ...remembered,
    username: 'jane.doe',
    profileIcon: 'panda',
  });

  renderProvider();
  await expectStatus('anonymous');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }));
  await expectStatus('authenticated');

  // Exactly the three allowed fields, carrying the CURRENT username + icon.
  expect(readRememberedAccount()).toEqual({
    userId: REMEMBERED_ID,
    username: 'jane.doe',
    profileIcon: 'panda',
  });
  // …and the refresh never re-opens the one-shot prompt for this device.
  expect(hasBeenAskedToRemember(REMEMBERED_ID)).toBe(true);
  expect(api.rememberDevice).not.toHaveBeenCalled();
});

test('a login never creates a remembered record this device does not already hold', async () => {
  // Nothing remembered (e.g. the user declined the prompt): the login must not
  // quietly start remembering them.
  vi.mocked(api.getMe).mockResolvedValue({ ...remembered, profileIcon: 'panda' });

  renderProvider();
  await expectStatus('authenticated');

  expect(readRememberedAccount()).toBeNull();
  expect(hasBeenAskedToRemember(REMEMBERED_ID)).toBe(false);
});

test('a login as a different user leaves the remembered record alone', async () => {
  writeRememberedAccount({ userId: OTHER_ID, username: 'bob', profileIcon: 'fox' });
  vi.mocked(api.getMe).mockResolvedValue({ ...remembered, profileIcon: 'panda' });

  renderProvider();
  await expectStatus('authenticated');

  expect(readRememberedAccount()).toEqual({
    userId: OTHER_ID,
    username: 'bob',
    profileIcon: 'fox',
  });
});

/**
 * The feature-flag bootstrap is principal-dependent since #1910 — a flag can be
 * rolled out to a percentage of accounts or to a named list — so the anonymous
 * map the shell fetched before login is not this account's map. `applyUser` is
 * the single door into a session user, and dropping the cached bootstrap there
 * is what makes the refetch cover login, 2FA verify, registration, quick-auth
 * and OAuth adoption instead of whichever path someone remembered to patch.
 */
test('adopting a session user invalidates the feature-flag bootstrap', async () => {
  const user = userEvent.setup();
  vi.mocked(api.getMe).mockRejectedValue(new ApiError(401, 'unauthorized', 'nope'));
  vi.mocked(api.login).mockResolvedValue(member);

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    </QueryClientProvider>,
  );

  await expectStatus('anonymous');
  // The anonymous shell has not adopted anyone, so nothing has been dropped.
  expect(
    invalidate.mock.calls.filter(([args]) =>
      Array.isArray((args as { queryKey?: unknown })?.queryKey)
        ? (args as { queryKey: unknown[] }).queryKey[0] === 'feature-flags'
        : false,
    ),
  ).toHaveLength(0);

  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await expectStatus('authenticated');

  await waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({ queryKey: FEATURE_FLAGS_QUERY_KEY }),
  );
});
