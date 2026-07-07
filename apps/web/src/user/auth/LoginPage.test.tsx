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
  pendingToken: 'pending-token-1',
  channels: ['totp', 'email', 'recovery'],
};

function renderApp() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/*" element={<UserApp />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  // Anonymous to start: the bootstrap /auth/me rejects, so the app shows /login.
  vi.mocked(api.getMe).mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'nope'));
  vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
});

async function submitPassword() {
  const u = userEvent.setup();
  renderApp();
  await screen.findByText('Sign in to your account');
  await u.type(screen.getByLabelText('Email or username'), 'jane');
  await u.type(screen.getByLabelText('Password'), 'jane-strong-password-1');
  await u.click(screen.getByRole('button', { name: 'Sign in' }));
  return u;
}

test('a 2FA account is shown the challenge step after the password, then lands in the app', async () => {
  vi.mocked(api.login).mockResolvedValue(challenge);
  vi.mocked(api.verifyTwoFactor).mockResolvedValue(user);

  const u = await submitPassword();

  // The challenge step is up — not the app yet.
  expect(await screen.findByText('Two-factor authentication')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();

  await u.type(screen.getByLabelText('Verification code'), '123456');
  await u.click(screen.getByRole('button', { name: 'Verify' }));

  // A verified factor completes login into the app.
  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(api.verifyTwoFactor).toHaveBeenCalledWith({
    pendingToken: 'pending-token-1',
    code: '123456',
  });
});

test('the challenge step can request an email code', async () => {
  vi.mocked(api.login).mockResolvedValue(challenge);
  vi.mocked(api.requestTwoFactorEmailCode).mockResolvedValue();

  const u = await submitPassword();
  await screen.findByText('Two-factor authentication');

  await u.click(screen.getByRole('button', { name: 'Email me a code' }));

  expect(api.requestTwoFactorEmailCode).toHaveBeenCalledWith({ pendingToken: 'pending-token-1' });
  expect(await screen.findByText(/sign-in code is on its way/i)).toBeInTheDocument();
});

test('the challenge step can switch to a recovery code', async () => {
  vi.mocked(api.login).mockResolvedValue(challenge);
  vi.mocked(api.verifyTwoFactor).mockResolvedValue(user);

  const u = await submitPassword();
  await screen.findByText('Two-factor authentication');

  await u.click(screen.getByRole('button', { name: 'Use a recovery code' }));
  await u.type(screen.getByLabelText('Recovery code'), 'abcd-efgh-ijkl-mnop');
  await u.click(screen.getByRole('button', { name: 'Verify' }));

  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(api.verifyTwoFactor).toHaveBeenCalledWith({
    pendingToken: 'pending-token-1',
    recoveryCode: 'abcd-efgh-ijkl-mnop',
  });
});

test('a wrong code shows an in-form error and stays on the challenge step', async () => {
  vi.mocked(api.login).mockResolvedValue(challenge);
  vi.mocked(api.verifyTwoFactor).mockRejectedValue(
    new ApiError(401, 'TWO_FACTOR_INVALID_CODE', 'nope'),
  );

  const u = await submitPassword();
  await screen.findByText('Two-factor authentication');

  await u.type(screen.getByLabelText('Verification code'), '000000');
  await u.click(screen.getByRole('button', { name: 'Verify' }));

  expect(await screen.findByText(/incorrect or has expired/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();
});

test('an account without 2FA logs straight into the app', async () => {
  vi.mocked(api.login).mockResolvedValue(user);

  await submitPassword();

  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(screen.queryByText('Two-factor authentication')).not.toBeInTheDocument();
});
