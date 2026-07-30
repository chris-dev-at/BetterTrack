import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import type { AdminTwoFactorStatusResponse, MeResponse } from '@bettertrack/contracts';

vi.mock('../lib/adminApi');

import * as api from '../lib/adminApi';
import { ApiError } from '../lib/apiClient';
import { AuthProvider, useAuth } from './AuthContext';

const admin: MeResponse = {
  id: 'admin-1',
  email: 'admin@bettertrack.test',
  username: 'rootadmin',
  role: 'admin',
  status: 'active',
  mustChangePassword: false,
  pinEnabled: false,
  pinLockIdleMinutes: null,
  baseCurrency: 'EUR',
  locale: 'en',
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const enrolledTwoFactor: AdminTwoFactorStatusResponse = {
  setupRequired: false,
  totpEnabled: true,
  totpPending: false,
  emailEnabled: false,
  twoFactorEmail: null,
  recoveryCodesRemaining: 8,
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getTwoFactorStatus).mockResolvedValue(enrolledTwoFactor);
});

test.each([0, 500])(
  'a status %i bootstrap outage stays session-unavailable until a successful retry',
  async (status) => {
    vi.mocked(api.getMe)
      .mockRejectedValueOnce(
        new ApiError(status, status === 0 ? 'NETWORK_ERROR' : 'UNKNOWN', 'unavailable'),
      )
      .mockResolvedValueOnce(admin);
    const user = userEvent.setup();

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    expect(await screen.findByTestId('status')).toHaveTextContent('session-unavailable');
    expect(screen.getByTestId('status')).not.toHaveTextContent('anonymous');

    await user.click(screen.getByRole('button', { name: 'Retry session' }));

    expect(await screen.findByTestId('status')).toHaveTextContent('authenticated');
    expect(screen.getByTestId('user')).toHaveTextContent('rootadmin');
  },
);

test('an outage during a recheck preserves the already resolved admin', async () => {
  vi.mocked(api.getMe)
    .mockResolvedValueOnce(admin)
    .mockRejectedValueOnce(new ApiError(500, 'UNKNOWN', 'unavailable'));
  const user = userEvent.setup();

  render(
    <AuthProvider>
      <AuthProbe />
    </AuthProvider>,
  );
  expect(await screen.findByTestId('status')).toHaveTextContent('authenticated');

  await user.click(screen.getByRole('button', { name: 'Retry session' }));

  expect(await screen.findByTestId('status')).toHaveTextContent('session-unavailable');
  expect(screen.getByTestId('user')).toHaveTextContent('rootadmin');
});

test('a confirmed 401 keeps the existing anonymous transition', async () => {
  vi.mocked(api.getMe).mockRejectedValue(
    new ApiError(401, 'UNAUTHENTICATED', 'Authentication required.'),
  );

  render(
    <AuthProvider>
      <AuthProbe />
    </AuthProvider>,
  );

  expect(await screen.findByTestId('status')).toHaveTextContent('anonymous');
  expect(screen.getByTestId('user')).toHaveTextContent('none');
});
