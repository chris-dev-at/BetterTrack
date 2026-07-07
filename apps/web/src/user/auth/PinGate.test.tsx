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
  locale: 'en',
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

test('a wrong PIN shakes the card, clears the boxes, refocuses the first (#288, #304)', async () => {
  vi.mocked(api.getMe).mockResolvedValue(pinUser);
  vi.mocked(api.verifyPin).mockRejectedValue(new ApiError(401, 'INVALID_PIN', 'Incorrect PIN.'));

  renderAt('/portfolio');
  await screen.findByText('Enter your PIN');

  const form = screen.getByLabelText('PIN').closest('form') as HTMLFormElement;
  expect(form).not.toHaveClass('pin-shake');

  typeGatePin('0000');
  await flush();

  expect(await screen.findByText(/incorrect pin/i)).toBeInTheDocument();
  // Wrong PIN → the card shakes (cleared when the animation ends).
  expect(form).toHaveClass('pin-shake');
  // Boxes cleared, first box focused, ready for another attempt.
  const first = screen.getByLabelText('PIN');
  expect(first).toHaveValue('');
  expect(document.activeElement).toBe(first);
});

test('the lock screen is a deliberate, branded card (Part B polish, #304)', async () => {
  vi.mocked(api.getMe).mockResolvedValue(pinUser);

  renderAt('/portfolio');
  await screen.findByText('Enter your PIN');

  // Wordmark present, "Enter your PIN" as the heading, and the four boxes.
  expect(screen.getByText('Better')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Enter your PIN' })).toBeInTheDocument();
  expect(screen.getAllByRole('textbox')).toHaveLength(4);
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

test('a reload during active use does not re-prompt (idle, not per-open) (#304)', async () => {
  vi.mocked(api.getMe).mockResolvedValue(pinUser);
  vi.mocked(api.verifyPin).mockResolvedValue(pinUser);

  const { unmount } = renderAt('/portfolio');

  await screen.findByText('Enter your PIN');
  typeGatePin('4242');
  await flush();
  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();

  // Reload right after unlocking: `lastActivityAt` is fresh (well inside the
  // default 10-minute window), so the app opens straight through — no gate.
  unmount();
  renderAt('/portfolio');
  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(screen.queryByText('Enter your PIN')).not.toBeInTheDocument();
});

test('continuous activity never locks; the gate engages only after N idle minutes (#304)', async () => {
  vi.useFakeTimers();
  const windowUser = { ...pinUser, pinLockIdleMinutes: 1 };
  vi.mocked(api.getMe).mockResolvedValue(windowUser);
  vi.mocked(api.verifyPin).mockResolvedValue(windowUser);

  renderAt('/portfolio');
  await flush();
  expect(screen.getByText('Enter your PIN')).toBeInTheDocument();

  typeGatePin('4242');
  await flush();
  expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument();

  // Active use: a pointer move every 30s for 3 minutes — 3× the 1-minute window.
  // The deadline keeps resetting, so the app never locks.
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      window.dispatchEvent(new Event('pointermove'));
    });
  }
  expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(screen.queryByText('Enter your PIN')).not.toBeInTheDocument();

  // Activity stops: just under a minute is still fine…
  await act(async () => {
    vi.advanceTimersByTime(59_000);
  });
  expect(screen.queryByText('Enter your PIN')).not.toBeInTheDocument();
  // …and crossing one idle minute engages the gate in place.
  await act(async () => {
    vi.advanceTimersByTime(2_000);
  });
  expect(screen.getByText('Enter your PIN')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();
});

test('a reload after the idle window has lapsed shows the gate before any data (#304)', async () => {
  vi.useFakeTimers();
  const windowUser = { ...pinUser, pinLockIdleMinutes: 1 };
  vi.mocked(api.getMe).mockResolvedValue(windowUser);
  vi.mocked(api.verifyPin).mockResolvedValue(windowUser);

  const { unmount } = renderAt('/portfolio');
  await flush();
  typeGatePin('4242');
  await flush();
  expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument();

  // Idle out, then reopen: `now − lastActivityAt` exceeds the window, so the gate
  // is up immediately — before the shell renders.
  await act(async () => {
    vi.advanceTimersByTime(61_000);
  });
  unmount();
  renderAt('/portfolio');
  await flush();
  expect(screen.getByText('Enter your PIN')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();
});

test('activity in another tab (a storage event) keeps this tab unlocked (#304)', async () => {
  vi.useFakeTimers();
  const windowUser = { ...pinUser, pinLockIdleMinutes: 1 };
  vi.mocked(api.getMe).mockResolvedValue(windowUser);
  vi.mocked(api.verifyPin).mockResolvedValue(windowUser);

  renderAt('/portfolio');
  await flush();
  typeGatePin('4242');
  await flush();
  expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument();

  // No local activity — but another tab of the same account keeps recording it,
  // broadcasting a storage event every 40s past the 1-minute window. This tab
  // must treat that as activity and never lock.
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      vi.advanceTimersByTime(40_000);
      localStorage.setItem(
        'bettertrack.pinActivity',
        JSON.stringify({ u: 'user-1', t: Date.now() }),
      );
      window.dispatchEvent(new StorageEvent('storage', { key: 'bettertrack.pinActivity' }));
    });
  }
  expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(screen.queryByText('Enter your PIN')).not.toBeInTheDocument();
});

test('lock timing uses no network — only the PIN verify call hits the API (#304)', async () => {
  vi.useFakeTimers();
  const windowUser = { ...pinUser, pinLockIdleMinutes: 1 };
  vi.mocked(api.getMe).mockResolvedValue(windowUser);
  vi.mocked(api.verifyPin).mockResolvedValue(windowUser);

  renderAt('/portfolio');
  await flush();
  typeGatePin('4242');
  await flush();
  expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument();

  // From here the lock is driven purely by the client idle timer: no further
  // `getMe`/refetch participates in it.
  vi.mocked(api.getMe).mockClear();
  await act(async () => {
    vi.advanceTimersByTime(61_000);
  });
  expect(screen.getByText('Enter your PIN')).toBeInTheDocument();
  expect(api.getMe).not.toHaveBeenCalled();
});

test('with the PIN disabled the app never asks for a PIN', async () => {
  vi.mocked(api.getMe).mockResolvedValue({ ...pinUser, pinEnabled: false });

  renderAt('/portfolio');

  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(screen.queryByText('Enter your PIN')).not.toBeInTheDocument();
});
