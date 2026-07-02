import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { MeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/userApi');
vi.mock('../../lib/portfolioApi');
vi.mock('../../lib/workboardApi', () => ({
  listWorkboard: vi.fn(),
  addToWorkboard: vi.fn(),
  removeFromWorkboard: vi.fn(),
  reorderWorkboard: vi.fn(),
}));

import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/userApi';
import { listWorkboard } from '../../lib/workboardApi';
import { UserApp } from '../UserApp';

const pinUser: MeResponse = {
  id: 'user-1',
  email: 'jane@bettertrack.test',
  username: 'jane',
  role: 'user',
  status: 'active',
  mustChangePassword: false,
  pinEnabled: true,
  baseCurrency: 'EUR',
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/*" element={<UserApp />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // The gate flag lives in sessionStorage; each test opens a fresh "browser session".
  sessionStorage.clear();
  vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
});

test('a PIN-enabled account opening the app is trapped at the PIN gate', async () => {
  vi.mocked(api.getMe).mockResolvedValue(pinUser);

  renderAt('/portfolio');

  // The gate is up; the app shell is unreachable.
  expect(await screen.findByText('Enter your PIN')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();
});

test('a correct PIN releases the trap into the app', async () => {
  vi.mocked(api.getMe).mockResolvedValue(pinUser);
  vi.mocked(api.verifyPin).mockResolvedValue(pinUser);

  const user = userEvent.setup();
  renderAt('/portfolio');

  await screen.findByText('Enter your PIN');
  await user.type(screen.getByLabelText('PIN'), '4242');
  await user.click(screen.getByRole('button', { name: 'Unlock' }));

  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(api.verifyPin).toHaveBeenCalledWith({ pin: '4242' });
});

test('five wrong PINs fall back to the full login screen', async () => {
  vi.mocked(api.getMe).mockResolvedValue(pinUser);
  vi.mocked(api.verifyPin).mockRejectedValue(
    new ApiError(401, 'PIN_FALLBACK_LOGIN', 'Too many incorrect PIN attempts.'),
  );

  const user = userEvent.setup();
  renderAt('/portfolio');

  await screen.findByText('Enter your PIN');
  await user.type(screen.getByLabelText('PIN'), '0000');
  await user.click(screen.getByRole('button', { name: 'Unlock' }));

  // The session was dropped server-side → the guard routes to login.
  expect(await screen.findByText('Sign in to your account')).toBeInTheDocument();
});

test('signing out from the gate returns to login', async () => {
  vi.mocked(api.getMe).mockResolvedValue(pinUser);
  vi.mocked(api.logout).mockResolvedValue();

  const user = userEvent.setup();
  renderAt('/portfolio');

  await screen.findByText('Enter your PIN');
  await user.click(screen.getByRole('button', { name: 'Sign out' }));

  expect(await screen.findByText('Sign in to your account')).toBeInTheDocument();
  expect(api.logout).toHaveBeenCalledOnce();
});
