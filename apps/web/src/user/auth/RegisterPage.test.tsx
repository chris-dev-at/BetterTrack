import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { MeResponse, RegistrationMode } from '@bettertrack/contracts';

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

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/*" element={<UserApp />} />
      </Routes>
    </MemoryRouter>,
  );
}

function setMode(mode: RegistrationMode) {
  vi.mocked(api.getRegistrationInfo).mockResolvedValue({ mode });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.mocked(api.getMe).mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'nope'));
  vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
});

test('closed mode shows a closed notice and no registration form', async () => {
  setMode('closed');
  renderAt('/register');

  expect(await screen.findByText(/registration is currently closed/i)).toBeInTheDocument();
  expect(screen.queryByLabelText(/^Password/i)).not.toBeInTheDocument();
});

test('open mode registers and signs the account straight in', async () => {
  setMode('open');
  vi.mocked(api.register).mockResolvedValue(user);
  const u = userEvent.setup();
  renderAt('/register');

  await u.type(await screen.findByLabelText('Email'), 'jane@bettertrack.test');
  await u.type(screen.getByLabelText('Username'), 'jane');
  await u.type(screen.getByLabelText('Password'), 'jane-strong-pass-1');
  await u.click(screen.getByRole('button', { name: 'Create account' }));

  await waitFor(() =>
    expect(api.register).toHaveBeenCalledWith({
      email: 'jane@bettertrack.test',
      username: 'jane',
      password: 'jane-strong-pass-1',
      locale: 'en',
    }),
  );
  // The app opens once the session lands.
  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
});

test('invite-token mode prefills the token from the URL and sends it', async () => {
  setMode('invite_token');
  vi.mocked(api.register).mockResolvedValue(user);
  const u = userEvent.setup();
  renderAt('/register?token=RAW-TOKEN');

  const tokenField = await screen.findByLabelText(/Access token/i);
  expect(tokenField).toHaveValue('RAW-TOKEN');

  await u.type(screen.getByLabelText('Email'), 'inv@test.dev');
  await u.type(screen.getByLabelText('Username'), 'inv_user');
  await u.type(screen.getByLabelText('Password'), 'inv-strong-pass-1');
  await u.click(screen.getByRole('button', { name: 'Create account' }));

  await waitFor(() =>
    expect(api.register).toHaveBeenCalledWith(
      expect.objectContaining({ inviteToken: 'RAW-TOKEN', username: 'inv_user' }),
    ),
  );
});

test('approval mode confirms the request is pending and mints no session', async () => {
  setMode('approval');
  vi.mocked(api.register).mockResolvedValue({ pending: true });
  const u = userEvent.setup();
  renderAt('/register');

  await u.type(await screen.findByLabelText('Email'), 'q@test.dev');
  await u.type(screen.getByLabelText('Username'), 'q_user');
  await u.type(screen.getByLabelText('Password'), 'q-strong-pass-1');
  await u.click(screen.getByRole('button', { name: 'Request account' }));

  expect(await screen.findByText(/pending administrator approval/i)).toBeInTheDocument();
  // Still anonymous — the app never opened.
  expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();
});

test('a taken email surfaces a friendly error', async () => {
  setMode('open');
  vi.mocked(api.register).mockRejectedValue(
    new ApiError(409, 'EMAIL_TAKEN', 'An account already exists for this email.'),
  );
  const u = userEvent.setup();
  renderAt('/register');

  await u.type(await screen.findByLabelText('Email'), 'dupe@test.dev');
  await u.type(screen.getByLabelText('Username'), 'dupe_user');
  await u.type(screen.getByLabelText('Password'), 'dupe-strong-pass-1');
  await u.click(screen.getByRole('button', { name: 'Create account' }));

  expect(await screen.findByText(/an account already exists for this email/i)).toBeInTheDocument();
});
