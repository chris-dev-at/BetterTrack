import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { MeResponse } from '@bettertrack/contracts';

vi.mock('../lib/userApi');

import { ApiError } from '../lib/apiClient';
import * as api from '../lib/userApi';
import { AuthProvider, useAuth } from './AuthContext';
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
  const { status, user, retrySession, logout } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.username ?? 'none'}</span>
      <button type="button" onClick={retrySession}>
        Retry session
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
