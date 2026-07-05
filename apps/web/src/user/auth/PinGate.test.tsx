import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { MeResponse } from '@bettertrack/contracts';

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

const pinUser: MeResponse = {
  id: 'user-1',
  email: 'jane@bettertrack.test',
  username: 'jane',
  role: 'user',
  status: 'active',
  mustChangePassword: false,
  pinEnabled: true,
  pinLockIdleMinutes: null,
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
  // The unlock flag is in-memory per app mount; a fresh render is a fresh open.
  sessionStorage.clear();
  vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
});

afterEach(() => {
  vi.useRealTimers();
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

test('re-opening the app (reload) re-locks even after a correct PIN (#248 §2)', async () => {
  vi.mocked(api.getMe).mockResolvedValue(pinUser);
  vi.mocked(api.verifyPin).mockResolvedValue(pinUser);

  const user = userEvent.setup();
  const { unmount } = renderAt('/portfolio');

  await screen.findByText('Enter your PIN');
  await user.type(screen.getByLabelText('PIN'), '4242');
  await user.click(screen.getByRole('button', { name: 'Unlock' }));
  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();

  // Reload: the unlock state is in-memory only, so a fresh mount must show the
  // gate again before any data renders — the bug was that it silently skipped it.
  unmount();
  renderAt('/portfolio');
  expect(await screen.findByText('Enter your PIN')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();
});

test('with the PIN disabled the app never asks for a PIN', async () => {
  vi.mocked(api.getMe).mockResolvedValue({ ...pinUser, pinEnabled: false });

  renderAt('/portfolio');

  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(screen.queryByText('Enter your PIN')).not.toBeInTheDocument();
});

test('AFK auto-lock re-shows the PIN after the idle timeout', async () => {
  vi.useFakeTimers();
  const idleUser = { ...pinUser, pinLockIdleMinutes: 1 };
  vi.mocked(api.getMe).mockResolvedValue(idleUser);
  vi.mocked(api.verifyPin).mockResolvedValue(idleUser);

  // Fake timers don't mix with userEvent's inter-key delay, so drive the gate
  // synchronously with fireEvent and drain microtasks between steps.
  const flush = () =>
    act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });

  renderAt('/portfolio');

  await flush();
  expect(screen.getByText('Enter your PIN')).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('PIN'), { target: { value: '4242' } });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
  await flush();
  expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument();

  // One idle minute passes with zero activity → the lock returns.
  await act(async () => {
    vi.advanceTimersByTime(61_000);
  });
  expect(screen.getByText('Enter your PIN')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();
});
