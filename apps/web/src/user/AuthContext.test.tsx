import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import type { MeResponse } from '@bettertrack/contracts';

vi.mock('../lib/userApi');

import { ApiError } from '../lib/apiClient';
import * as api from '../lib/userApi';
import { AuthProvider, useAuth } from './AuthContext';

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
  const { status, user, retrySession } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.username ?? 'none'}</span>
      <button type="button" onClick={retrySession}>
        Retry session
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
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
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

    expect(await screen.findByTestId('status')).toHaveTextContent('session-unavailable');
    expect(screen.getByTestId('status')).not.toHaveTextContent('anonymous');

    await user.click(screen.getByRole('button', { name: 'Retry session' }));

    expect(await screen.findByTestId('status')).toHaveTextContent('authenticated');
    expect(screen.getByTestId('user')).toHaveTextContent('jane');
  },
);

test('an outage during a recheck preserves the already resolved user', async () => {
  vi.mocked(api.getMe)
    .mockResolvedValueOnce(member)
    .mockRejectedValueOnce(new ApiError(500, 'UNKNOWN', 'unavailable'));
  const user = userEvent.setup();

  renderProvider();
  expect(await screen.findByTestId('status')).toHaveTextContent('authenticated');

  await user.click(screen.getByRole('button', { name: 'Retry session' }));

  expect(await screen.findByTestId('status')).toHaveTextContent('session-unavailable');
  expect(screen.getByTestId('user')).toHaveTextContent('jane');
});

test('a confirmed 401 keeps the existing anonymous transition', async () => {
  vi.mocked(api.getMe).mockRejectedValue(
    new ApiError(401, 'UNAUTHENTICATED', 'Authentication required.'),
  );

  renderProvider();

  expect(await screen.findByTestId('status')).toHaveTextContent('anonymous');
  expect(screen.getByTestId('user')).toHaveTextContent('none');
});
