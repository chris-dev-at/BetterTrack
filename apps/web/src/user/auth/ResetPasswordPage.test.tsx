import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { MeResponse, TwoFactorChallengeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/userApi');
vi.mock('../../lib/portfolioApi');
vi.mock('../../lib/workboardApi', () => ({
  WORKBOARD_QUERY_KEY: ['workboard'],
  listWorkboard: vi.fn(),
  addToWorkboard: vi.fn(),
  removeFromWorkboard: vi.fn(),
  reorderWorkboard: vi.fn(),
}));

import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/userApi';
import { listWorkboard } from '../../lib/workboardApi';
import { UserApp } from '../UserApp';

const user: MeResponse = {
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

const challenge: TwoFactorChallengeResponse = {
  twoFactorRequired: true,
  pendingToken: 'reset-pending-1',
  channels: ['totp', 'recovery'],
};

function renderApp() {
  return render(
    <MemoryRouter initialEntries={['/reset/tok-123']}>
      <Routes>
        <Route path="/*" element={<UserApp />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.mocked(api.getMe).mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'nope'));
  vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
});

async function submitNewPassword() {
  const u = userEvent.setup();
  renderApp();
  await screen.findByText('Choose a new password');
  await u.type(screen.getByLabelText('New password'), 'fresh-reset-password-1');
  await u.click(screen.getByRole('button', { name: 'Set new password' }));
  return u;
}

test('a 2FA account must clear the second-factor step after resetting the password', async () => {
  // The reset withholds the session and returns a challenge — a mailbox alone
  // must not defeat the second factor (§6.1).
  vi.mocked(api.completePasswordReset).mockResolvedValue(challenge);
  vi.mocked(api.verifyTwoFactor).mockResolvedValue(user);

  const u = await submitNewPassword();

  // The 2FA step is shown, not the app.
  expect(await screen.findByText('Two-factor authentication')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();

  await u.type(screen.getByLabelText('Verification code'), '123456');
  await u.click(screen.getByRole('button', { name: 'Verify' }));

  // A verified factor promotes the pending challenge into the app.
  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(api.verifyTwoFactor).toHaveBeenCalledWith({
    pendingToken: 'reset-pending-1',
    code: '123456',
  });
});

test('a no-2FA account is signed straight in after resetting the password', async () => {
  vi.mocked(api.completePasswordReset).mockResolvedValue(user);

  await submitNewPassword();

  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(screen.queryByText('Two-factor authentication')).not.toBeInTheDocument();
  expect(api.completePasswordReset).toHaveBeenCalledWith({
    token: 'tok-123',
    newPassword: 'fresh-reset-password-1',
  });
});
