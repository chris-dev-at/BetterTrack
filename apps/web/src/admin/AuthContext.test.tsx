import { render, screen, waitFor } from '@testing-library/react';
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

/**
 * Wait for the probe to reach `status`.
 *
 * The `status` span is in the DOM from the very first render, so a
 * `findByTestId` here resolves instantly against the initial `loading` value:
 * it waits for the *element*, never for the transition, leaving the assertion
 * that follows it racing the bootstrap promise. Polling the text content is
 * what actually waits for that promise to settle, so a loaded runner no longer
 * decides the outcome. Still bounded, so a genuine regression still fails.
 */
async function expectStatus(status: string) {
  await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent(status));
}

beforeEach(() => {
  // `resetAllMocks`, not `clearAllMocks`: only a reset drains queued
  // `mockRejectedValueOnce`/`mockResolvedValueOnce` values. A test that fails
  // before consuming its queue would otherwise hand the leftovers to the next
  // test, turning one failure into a cascade of unrelated ones.
  vi.resetAllMocks();
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

    await expectStatus('session-unavailable');
    expect(screen.getByTestId('status')).not.toHaveTextContent('anonymous');

    await user.click(screen.getByRole('button', { name: 'Retry session' }));

    await expectStatus('authenticated');
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
  await expectStatus('authenticated');

  await user.click(screen.getByRole('button', { name: 'Retry session' }));

  await expectStatus('session-unavailable');
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

  await expectStatus('anonymous');
  expect(screen.getByTestId('user')).toHaveTextContent('none');
});
