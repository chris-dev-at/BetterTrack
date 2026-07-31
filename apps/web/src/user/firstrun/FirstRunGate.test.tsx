import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { MeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/userApi');
vi.mock('../../lib/twoFactorApi');
vi.mock('../../lib/settingsApi');
vi.mock('../../lib/socialApi');
vi.mock('../../lib/portfolioApi');
vi.mock('../../lib/workboardApi', () => ({
  WORKBOARD_QUERY_KEY: ['workboard'],
  listWorkboard: vi.fn(),
  addToWorkboard: vi.fn(),
  removeFromWorkboard: vi.fn(),
  reorderWorkboard: vi.fn(),
}));

import { ApiError } from '../../lib/apiClient';
import * as settingsApi from '../../lib/settingsApi';
import * as socialApi from '../../lib/socialApi';
import * as twoFactorApi from '../../lib/twoFactorApi';
import * as api from '../../lib/userApi';
import { listWorkboard } from '../../lib/workboardApi';
import { UserApp, queryClient } from '../UserApp';

const BASE: MeResponse = {
  id: '8d7cf3d6-e8b8-4fa4-98a4-8712cddc05bf',
  email: 'jane@bettertrack.test',
  username: 'jane',
  role: 'user',
  status: 'active',
  mustChangePassword: false,
  pinEnabled: false,
  pinLockIdleMinutes: null,
  baseCurrency: 'EUR',
  locale: 'en',
  lastLoginAt: '2026-07-01T09:00:00.000Z',
  firstRunCompletedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** An account that has never been through setup — what every mode produces. */
const NEVER_SET_UP = BASE;
/** An established account. */
const SET_UP: MeResponse = { ...BASE, firstRunCompletedAt: '2026-02-02T10:00:00.000Z' };

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/*" element={<UserApp />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Mirrors the live path into the DOM so a test can assert where routing settled. */
function LocationProbe() {
  return <div data-testid="path">{useLocation().pathname}</div>;
}

function renderAtWithPath(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      <Routes>
        <Route path="/*" element={<UserApp />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  queryClient.clear();

  vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
  vi.mocked(api.getParanoidMediaState).mockResolvedValue({
    privacyMode: 'normal',
    mediaState: null,
  });
  vi.mocked(api.getGoogleLinkStatus).mockResolvedValue({
    enabled: false,
    linked: false,
    email: null,
    linkedAt: null,
    canUnlink: false,
  });
  vi.mocked(twoFactorApi.getTwoFactorStatus).mockResolvedValue({
    totpEnabled: false,
    totpPending: false,
    emailEnabled: false,
    recoveryCodesRemaining: 0,
  });
  vi.mocked(settingsApi.getAccountSettings).mockResolvedValue({
    defaultPortfolioVisibility: 'private',
    locale: 'en',
    baseCurrency: 'EUR',
    discreetMode: false,
  });
  vi.mocked(settingsApi.getTaxSettings).mockResolvedValue({ mode: 'none', country: null });
  vi.mocked(socialApi.getProfileSettings).mockResolvedValue({
    username: 'jane',
    isPublic: false,
    bio: null,
    publicItemCount: 0,
    profileIcon: null,
  });
  vi.mocked(api.completeFirstRun).mockResolvedValue(SET_UP);
});

// ── The signal, not the signup path ──────────────────────────────────────────

test('an account that has never been set up is diverted to setup from Home', async () => {
  vi.mocked(api.getMe).mockResolvedValue(NEVER_SET_UP);
  renderAt('/');

  expect(await screen.findByRole('heading', { name: 'Is this you?' })).toBeInTheDocument();
});

test('it diverts from a deep link too, not just Home', async () => {
  vi.mocked(api.getMe).mockResolvedValue(NEVER_SET_UP);
  renderAt('/settings/security');

  expect(await screen.findByRole('heading', { name: 'Is this you?' })).toBeInTheDocument();
});

test('an established account is never diverted', async () => {
  vi.mocked(api.getMe).mockResolvedValue(SET_UP);
  renderAt('/');

  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Is this you?' })).not.toBeInTheDocument();
});

test('a server that does not report the field at all never diverts', async () => {
  // Pre-0074 API (or an older fixture): `undefined` means "unknown", and
  // guessing "not completed" would march every existing user through setup.
  const legacy = { ...BASE };
  delete (legacy as { firstRunCompletedAt?: unknown }).firstRunCompletedAt;
  vi.mocked(api.getMe).mockResolvedValue(legacy);
  renderAt('/');

  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Is this you?' })).not.toBeInTheDocument();
});

test('a local "done" record suppresses the divert even while the server still says null', async () => {
  // The state after a completion whose request failed: this device must not be
  // bounced back into the wizard on every reload.
  localStorage.setItem(
    'bt.firstrun.v1',
    JSON.stringify({ account: NEVER_SET_UP.id, done: true, steps: {} }),
  );
  vi.mocked(api.getMe).mockResolvedValue(NEVER_SET_UP);
  renderAt('/');

  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Is this you?' })).not.toBeInTheDocument();
});

// ── Exemptions and the gates above routing ───────────────────────────────────

test('the OAuth authorize flow is never hijacked', async () => {
  vi.mocked(api.getMe).mockResolvedValue(NEVER_SET_UP);
  renderAtWithPath(
    '/oauth/authorize?client_id=app&redirect_uri=https%3A%2F%2Fx.example&scope=portfolio%3Aread',
  );

  // Routing stays put: a third party is waiting on the other end of this flow,
  // so setup must not steal it — only delay itself.
  await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/oauth/authorize'));
  expect(screen.queryByRole('heading', { name: 'Is this you?' })).not.toBeInTheDocument();
});

test('the forced-password-change trap wins — it sits above routing', async () => {
  vi.mocked(api.getMe).mockResolvedValue({ ...NEVER_SET_UP, mustChangePassword: true });
  renderAt('/');

  // An admin-created account is exactly this shape: temp password AND no setup.
  expect(await screen.findByText('Choose a new password')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Is this you?' })).not.toBeInTheDocument();
});

test('the PIN gate wins — it also sits above routing', async () => {
  vi.mocked(api.getMe).mockResolvedValue({ ...NEVER_SET_UP, pinEnabled: true });
  renderAt('/');

  expect(await screen.findByLabelText('PIN')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Is this you?' })).not.toBeInTheDocument();
});

// ── Leaving, and not looping ─────────────────────────────────────────────────

test('"Do this later" records completion server-side and does not bounce back', async () => {
  vi.mocked(api.getMe).mockResolvedValue(NEVER_SET_UP);
  const u = userEvent.setup();
  renderAt('/');
  await screen.findByRole('heading', { name: 'Is this you?' });

  await u.click(screen.getByRole('button', { name: 'Do this later' }));

  await waitFor(() => expect(api.completeFirstRun).toHaveBeenCalledTimes(1));
  // Landed the app, and the gate does not immediately divert again.
  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Is this you?' })).not.toBeInTheDocument();
});

test('a failed completion request still lets the user out — no trap', async () => {
  vi.mocked(api.getMe).mockResolvedValue(NEVER_SET_UP);
  vi.mocked(api.completeFirstRun).mockRejectedValue(new ApiError(500, 'BOOM', 'nope'));
  const u = userEvent.setup();
  renderAt('/');
  await screen.findByRole('heading', { name: 'Is this you?' });

  await u.click(screen.getByRole('button', { name: 'Do this later' }));

  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
});

test('/welcome stays reachable on demand for an established account', async () => {
  vi.mocked(api.getMe).mockResolvedValue(SET_UP);
  renderAt('/welcome');

  // Re-runnable: being set up already does not lock the wizard away.
  expect(await screen.findByRole('heading', { name: 'Is this you?' })).toBeInTheDocument();
});

test("another account's done record does NOT suppress this account's setup", async () => {
  // Regression: the record used to be device-wide, so one "Do this later" made
  // every later account on that browser skip the wizard entirely.
  localStorage.setItem(
    'bt.firstrun.v1',
    JSON.stringify({ account: 'a-different-user', done: true, steps: {} }),
  );
  vi.mocked(api.getMe).mockResolvedValue(NEVER_SET_UP);
  renderAt('/');

  expect(await screen.findByRole('heading', { name: 'Is this you?' })).toBeInTheDocument();
});
