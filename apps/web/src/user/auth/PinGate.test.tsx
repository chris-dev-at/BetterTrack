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
  // A fresh open must not inherit a prior unlock window.
  sessionStorage.clear();
  localStorage.clear();
  vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

/** Fill the four boxes with `pin`; the fourth digit auto-submits (no button). */
function typeGatePin(pin: string) {
  const labels = ['PIN', 'PIN digit 2', 'PIN digit 3', 'PIN digit 4'];
  labels.forEach((label, i) => {
    fireEvent.change(screen.getByLabelText(label), { target: { value: pin[i] } });
  });
}

/** Drain queued microtasks so async auth transitions settle under fake timers. */
const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });

test('a PIN-enabled account opening the app is trapped at the PIN gate', async () => {
  vi.mocked(api.getMe).mockResolvedValue(pinUser);

  renderAt('/portfolio');

  // The gate is up; the app shell is unreachable.
  expect(await screen.findByText('Enter your PIN')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();
});

test('the gate renders exactly four boxes and auto-submits on the fourth digit (#288)', async () => {
  vi.mocked(api.getMe).mockResolvedValue(pinUser);
  vi.mocked(api.verifyPin).mockResolvedValue(pinUser);

  renderAt('/portfolio');
  await screen.findByText('Enter your PIN');

  // Exactly four boxes, and no separate Unlock button to press.
  expect(screen.getAllByRole('textbox')).toHaveLength(4);
  expect(screen.queryByRole('button', { name: 'Unlock' })).not.toBeInTheDocument();

  typeGatePin('4242');
  await flush();

  // The submitted value is the real digits — never a mask glyph (#288).
  expect(api.verifyPin).toHaveBeenCalledWith({ pin: '4242' });
  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
});

test('a wrong PIN clears the boxes, refocuses the first, and shows the error (#288)', async () => {
  vi.mocked(api.getMe).mockResolvedValue(pinUser);
  vi.mocked(api.verifyPin).mockRejectedValue(new ApiError(401, 'INVALID_PIN', 'Incorrect PIN.'));

  renderAt('/portfolio');
  await screen.findByText('Enter your PIN');

  typeGatePin('0000');
  await flush();

  expect(await screen.findByText(/incorrect pin/i)).toBeInTheDocument();
  // Boxes cleared, first box focused, ready for another attempt.
  const first = screen.getByLabelText('PIN');
  expect(first).toHaveValue('');
  expect(document.activeElement).toBe(first);
});

test('the fallback after too many wrong PINs returns to the full login screen', async () => {
  vi.mocked(api.getMe).mockResolvedValue(pinUser);
  vi.mocked(api.verifyPin).mockRejectedValue(
    new ApiError(401, 'PIN_FALLBACK_LOGIN', 'Too many incorrect PIN attempts.'),
  );

  renderAt('/portfolio');
  await screen.findByText('Enter your PIN');

  typeGatePin('0000');
  await flush();

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

test('a reload inside the unlock window does not re-prompt (TTL, not per-open) (#288)', async () => {
  vi.mocked(api.getMe).mockResolvedValue(pinUser);
  vi.mocked(api.verifyPin).mockResolvedValue(pinUser);

  const { unmount } = renderAt('/portfolio');

  await screen.findByText('Enter your PIN');
  typeGatePin('4242');
  await flush();
  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();

  // Reload within the (default 10-minute) window: the persisted expiry is still
  // in the future, so the app opens straight through — no gate.
  unmount();
  renderAt('/portfolio');
  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(screen.queryByText('Enter your PIN')).not.toBeInTheDocument();
});

test('when the window expires the gate engages in place, and a reload also locks (#288)', async () => {
  vi.useFakeTimers();
  const windowUser = { ...pinUser, pinLockIdleMinutes: 1 };
  vi.mocked(api.getMe).mockResolvedValue(windowUser);
  vi.mocked(api.verifyPin).mockResolvedValue(windowUser);

  const { unmount } = renderAt('/portfolio');
  await flush();
  expect(screen.getByText('Enter your PIN')).toBeInTheDocument();

  typeGatePin('4242');
  await flush();
  expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument();

  // The window is absolute since unlock — after one minute the overlay engages
  // even with the app sitting open and zero activity.
  await act(async () => {
    vi.advanceTimersByTime(61_000);
  });
  expect(screen.getByText('Enter your PIN')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();

  // A reload past expiry likewise shows the gate before any data.
  unmount();
  renderAt('/portfolio');
  await flush();
  expect(screen.getByText('Enter your PIN')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();
});

test('with the PIN disabled the app never asks for a PIN', async () => {
  vi.mocked(api.getMe).mockResolvedValue({ ...pinUser, pinEnabled: false });

  renderAt('/portfolio');

  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(screen.queryByText('Enter your PIN')).not.toBeInTheDocument();
});
