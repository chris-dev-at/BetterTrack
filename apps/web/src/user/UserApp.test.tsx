import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { MeResponse } from '@bettertrack/contracts';

vi.mock('../lib/userApi');
import { ApiError } from '../lib/apiClient';
import * as api from '../lib/userApi';
import { UserApp } from './UserApp';

const member: MeResponse = {
  id: 'user-1',
  email: 'jane@bettertrack.test',
  username: 'jane',
  role: 'user',
  status: 'active',
  mustChangePassword: false,
  baseCurrency: 'EUR',
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** Mount the user app under a `/*` parent, exactly as App.tsx does. */
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/*" element={<UserApp />} />
      </Routes>
    </MemoryRouter>,
  );
}

const anonymous = () =>
  vi.mocked(api.getMe).mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'Not signed in.'));

beforeEach(() => {
  vi.clearAllMocks();
});

test('an unauthenticated visit to a user route redirects to /login', async () => {
  anonymous();

  renderAt('/workboard');

  expect(await screen.findByText('Sign in to your account')).toBeInTheDocument();
  expect(screen.queryByText('Watchlist, alerts and your conglomerates.')).not.toBeInTheDocument();
});

test('after signing in, the user returns to the originally requested route', async () => {
  anonymous();
  vi.mocked(api.login).mockResolvedValue(member);

  const user = userEvent.setup();
  renderAt('/workboard');

  await screen.findByText('Sign in to your account');
  await user.type(screen.getByLabelText('Email or username'), 'jane');
  await user.type(screen.getByLabelText('Password'), 'correct horse');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));

  // Landed on the intended route, not the dashboard home.
  expect(await screen.findByText('Watchlist, alerts and your conglomerates.')).toBeInTheDocument();
  expect(api.login).toHaveBeenCalledWith({ identifier: 'jane', password: 'correct horse' });
});

test('bad credentials show a single generic, non-enumerating error', async () => {
  anonymous();
  vi.mocked(api.login).mockRejectedValue(
    new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email/username or password.'),
  );

  const user = userEvent.setup();
  renderAt('/login');

  await screen.findByText('Sign in to your account');
  await user.type(screen.getByLabelText('Email or username'), 'jane');
  await user.type(screen.getByLabelText('Password'), 'wrong-password');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));

  expect(await screen.findByText('Incorrect email/username or password.')).toBeInTheDocument();
  // Still on the login screen; no redirect, no app content.
  expect(screen.getByText('Sign in to your account')).toBeInTheDocument();
});

test('a must-change session is trapped, then released by a successful change', async () => {
  // A fresh load of a forced-change account: /auth/me responds 403.
  vi.mocked(api.getMe).mockRejectedValue(
    new ApiError(403, 'PASSWORD_CHANGE_REQUIRED', 'Password change required.'),
  );
  vi.mocked(api.changePassword).mockResolvedValue(member);

  const user = userEvent.setup();
  renderAt('/');

  // Trapped: the change screen is up and the dashboard is unreachable.
  expect(await screen.findByText('Choose a new password')).toBeInTheDocument();
  expect(screen.queryByText('Your calm overview lands here.')).not.toBeInTheDocument();

  await user.type(screen.getByLabelText('Current password'), 'temp-password-123');
  await user.type(screen.getByLabelText('New password'), 'a-brand-new-secret');
  await user.type(screen.getByLabelText('Confirm new password'), 'a-brand-new-secret');
  await user.click(screen.getByRole('button', { name: 'Update password' }));

  // Released into the app.
  expect(await screen.findByText('Your calm overview lands here.')).toBeInTheDocument();
  expect(api.changePassword).toHaveBeenCalledWith({
    currentPassword: 'temp-password-123',
    newPassword: 'a-brand-new-secret',
  });
});

test('sign-out works from the forced-change screen', async () => {
  vi.mocked(api.getMe).mockRejectedValue(
    new ApiError(403, 'PASSWORD_CHANGE_REQUIRED', 'Password change required.'),
  );
  vi.mocked(api.logout).mockResolvedValue();

  const user = userEvent.setup();
  renderAt('/');

  await screen.findByText('Choose a new password');
  await user.click(screen.getByRole('button', { name: 'Sign out' }));

  // Now anonymous at `/` → the guard sends us to login.
  expect(await screen.findByText('Sign in to your account')).toBeInTheDocument();
  expect(api.logout).toHaveBeenCalledOnce();
});

test('invite accept: a valid token shows the fixed email and creates the account', async () => {
  anonymous();
  vi.mocked(api.validateInvite).mockResolvedValue({
    valid: true,
    email: 'newbie@bettertrack.test',
  });
  vi.mocked(api.acceptInvite).mockResolvedValue({
    ...member,
    id: 'user-2',
    email: 'newbie@bettertrack.test',
    username: 'newbie',
  });

  const user = userEvent.setup();
  renderAt('/invite/tok-abc123');

  // Fixed email is shown and locked.
  const email = await screen.findByDisplayValue('newbie@bettertrack.test');
  expect(email).toBeDisabled();

  await user.type(screen.getByLabelText('Username'), 'newbie');
  await user.type(screen.getByLabelText('Password'), 'a-brand-new-secret');
  await user.click(screen.getByRole('button', { name: 'Create account' }));

  expect(await screen.findByText('Your calm overview lands here.')).toBeInTheDocument();
  expect(api.acceptInvite).toHaveBeenCalledWith({
    token: 'tok-abc123',
    username: 'newbie',
    password: 'a-brand-new-secret',
  });
});

test('invite accept: an invalid token is rejected with a clear message and no form', async () => {
  anonymous();
  vi.mocked(api.validateInvite).mockResolvedValue({ valid: false, email: null });

  renderAt('/invite/expired-token');

  expect(
    await screen.findByText(/invalid, expired, or has already been used/i),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();
});
