import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { MeResponse } from '@bettertrack/contracts';

vi.mock('../lib/userApi');
vi.mock('../lib/workboardApi', () => ({
  WORKBOARD_QUERY_KEY: ['workboard'],
  WATCHLIST_SHARING_QUERY_KEY: ['workboard', 'sharing'],
  listWorkboard: vi.fn(),
  addToWorkboard: vi.fn(),
  removeFromWorkboard: vi.fn(),
  reorderWorkboard: vi.fn(),
  getWatchlistSharing: vi.fn(async () => ({ visibility: 'private' })),
  updateWatchlistSharing: vi.fn(),
}));
// `/` now redirects to `/portfolio` (§7.2), so a couple of auth-flow tests land
// on the Portfolio page. Auto-mock its data module so it settles without a real
// network call; these tests only assert we reached the authenticated shell.
vi.mock('../lib/portfolioApi');

import { ApiError } from '../lib/apiClient';
import * as api from '../lib/userApi';
import { listPortfolios } from '../lib/portfolioApi';
import { listWorkboard } from '../lib/workboardApi';
import { UserApp } from './UserApp';

const member: MeResponse = {
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

/** Mirrors the live URL into the DOM so tests can assert where routing settled. */
function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderAtWithLocation(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      <Routes>
        <Route path="/*" element={<UserApp />} />
      </Routes>
    </MemoryRouter>,
  );
}

const anonymous = () =>
  vi.mocked(api.getMe).mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'Not signed in.'));

/**
 * Budget for the first assertion after a sign-in. Landing authenticated is the
 * longest chain in this file — the login mutation flips the auth gate, the
 * legacy path redirects into its Origin destination, the shell and the
 * destination mount, and only then does that page's own query paint the text
 * being asserted on.
 *
 * Idle, that chain settles in well under 100ms; it is also the part of these
 * tests most sensitive to CPU contention, measured repeatedly past 2s on a
 * loaded machine while the sign-in-page waits around it stayed in the tens of
 * milliseconds. So on a saturated CI runner it is Testing Library's 1s default
 * that expires, not the app failing to render. These waits are still bounded
 * and still fail on a genuine regression — just not on runner load.
 * `AppShell.test.tsx` budgets the same shell surfaces the same way.
 */
const SIGNED_IN_RENDER = { timeout: 5_000 } as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getParanoidMediaState).mockResolvedValue({
    privacyMode: 'normal',
    mediaState: null,
  });
  // WorkboardPage fetches the watchlist on mount; return an empty list so the
  // page renders without errors in tests that exercise the workboard route.
  vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
});

test('an unauthenticated visit to a user route redirects to /login', async () => {
  anonymous();

  renderAt('/workboard');

  expect(await screen.findByText('Sign in to your account')).toBeInTheDocument();
  expect(
    screen.queryByText('Your watched assets, alerts and blueprints at a glance.'),
  ).not.toBeInTheDocument();
});

test('an unauthenticated visit to an unknown route still redirects to /login', async () => {
  anonymous();

  renderAtWithLocation('/not-a-real-route');

  expect(await screen.findByText('Sign in to your account')).toBeInTheDocument();
  expect(screen.getByTestId('location')).toHaveTextContent('/login');
});

test('the retired /people/following deep link redirects to the Friends tab', async () => {
  vi.mocked(api.getMe).mockResolvedValue(member);
  vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [] });

  renderAtWithLocation('/people/following');

  await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/people'));
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

  // Landed on the intended route (the legacy /workboard path redirects into
  // the Workbench destination), not the Home command center.
  expect(
    await screen.findByText(
      'Your watched assets, alerts and blueprints at a glance.',
      {},
      SIGNED_IN_RENDER,
    ),
  ).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: /Welcome back/ })).not.toBeInTheDocument();
  expect(api.login).toHaveBeenCalledWith({
    identifier: 'jane',
    password: 'correct horse',
    staySignedIn: true,
    oauthLogin: false,
  });
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

test('a 429 on login shows a dedicated rate-limit message, not the generic credentials error', async () => {
  anonymous();
  vi.mocked(api.login).mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'Too many requests.'));

  const user = userEvent.setup();
  renderAt('/login');

  await screen.findByText('Sign in to your account');
  await user.type(screen.getByLabelText('Email or username'), 'jane');
  await user.type(screen.getByLabelText('Password'), 'wrong-password');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));

  expect(
    await screen.findByText(/Too many login attempts\. Please wait a moment/i),
  ).toBeInTheDocument();
  expect(screen.queryByText('Incorrect email/username or password.')).not.toBeInTheDocument();
  // Still on login screen.
  expect(screen.getByText('Sign in to your account')).toBeInTheDocument();
});

test('a 429 on login with retryAfterSeconds mentions the wait time', async () => {
  anonymous();
  vi.mocked(api.login).mockRejectedValue(
    new ApiError(429, 'RATE_LIMITED', 'Too many requests.', undefined, 30),
  );

  const user = userEvent.setup();
  renderAt('/login');

  await screen.findByText('Sign in to your account');
  await user.type(screen.getByLabelText('Email or username'), 'jane');
  await user.type(screen.getByLabelText('Password'), 'wrong-password');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));

  expect(await screen.findByText(/30 seconds/i)).toBeInTheDocument();
  expect(screen.queryByText('Incorrect email/username or password.')).not.toBeInTheDocument();
});

test('a 429 on the bootstrap /auth/me holds the splash and retries — never mistakes rate-limit for signed-out', async () => {
  // Regression: the bootstrap used to fall through 429 → anonymous, which
  // bounced a session-carrying caller to /login after a burst-limit trip
  // (e2e #625: compressed multi-navigation spec repeatedly hard-reloading
  // `/social/friends`). A 429 must instead surface the toast and retry, so a
  // transient rate-limit never signs the user out.
  vi.mocked(api.getMe)
    .mockRejectedValueOnce(new ApiError(429, 'RATE_LIMITED', 'Too many requests.', undefined, 1))
    .mockResolvedValue(member);
  vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [] });

  renderAt('/portfolio');

  // Held on splash (never bounced to /login) while the retry is pending.
  expect(screen.queryByText('Sign in to your account')).not.toBeInTheDocument();
  // The rate-limit toast is shown while waiting.
  expect(await screen.findByText(/You're doing that too fast/i)).toBeInTheDocument();
  // After the retry, the app admits the user — the shell renders (§7.4).
  expect(
    await screen.findByRole('button', { name: 'Account menu' }, { timeout: 3_000 }),
  ).toBeInTheDocument();
  await waitFor(() => expect(api.getMe).toHaveBeenCalledTimes(2));
});

test.each([0, 500])(
  'a status %i bootstrap outage offers retry without prompting for credentials',
  async (status) => {
    vi.mocked(api.getMe)
      .mockRejectedValueOnce(
        new ApiError(status, status === 0 ? 'NETWORK_ERROR' : 'UNKNOWN', 'unavailable'),
      )
      .mockResolvedValueOnce(member);
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [] });
    const user = userEvent.setup();

    renderAt('/portfolio');

    expect(await screen.findByText(/can’t verify your session right now/i)).toBeInTheDocument();
    expect(screen.queryByText('Sign in to your account')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
    expect(api.getMe).toHaveBeenCalledTimes(2);
  },
);

test('a must-change session is trapped, then released by a successful change', async () => {
  // A fresh load of a forced-change account: /auth/me responds 403.
  vi.mocked(api.getMe).mockRejectedValue(
    new ApiError(403, 'PASSWORD_CHANGE_REQUIRED', 'Password change required.'),
  );
  vi.mocked(api.changePassword).mockResolvedValue(member);

  const user = userEvent.setup();
  renderAt('/');

  // Trapped: the change screen is up and the app shell is unreachable.
  expect(await screen.findByText('Choose a new password')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();

  // No "Current password" field: the temp-password login is the proof, so it is
  // never asked for a second time (#248 item 7).
  expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
  await user.type(screen.getByLabelText('New password'), 'a-brand-new-secret');
  await user.type(screen.getByLabelText('Confirm new password'), 'a-brand-new-secret');
  await user.click(screen.getByRole('button', { name: 'Update password' }));

  // Released into the app shell (lands on /portfolio via the `/` redirect).
  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(api.changePassword).toHaveBeenCalledWith({
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
    // Brand-new account: FirstRunGate diverts it to setup. Set here rather than
    // on `member`, which stands for an established user in every other test.
    firstRunCompletedAt: null,
  });

  const user = userEvent.setup();
  renderAt('/invite/tok-abc123');

  // Fixed email is shown and locked.
  const email = await screen.findByDisplayValue('newbie@bettertrack.test');
  expect(email).toBeDisabled();

  await user.type(screen.getByLabelText('Username'), 'newbie');
  await user.type(screen.getByLabelText('Password'), 'a-brand-new-secret');
  await user.click(screen.getByRole('button', { name: 'Create account' }));

  // Accepting an invite creates an account, so it lands on first-run setup —
  // not on Home. Dismissing it opens the app exactly as before.
  expect(await screen.findByRole('heading', { name: 'Is this you?' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Do this later' }));

  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(api.acceptInvite).toHaveBeenCalledWith({
    token: 'tok-abc123',
    username: 'newbie',
    password: 'a-brand-new-secret',
  });
});

test('logout then login as a different user shows no stale account data (#253)', async () => {
  // AccountSettingsPage caches `GET /auth/me` under a 30s staleTime — long
  // enough that, without an explicit cache clear on logout, a same-test
  // relogin would still render the previous user's cached identity.
  anonymous();
  vi.mocked(api.login).mockResolvedValueOnce(member);
  vi.mocked(api.logout).mockResolvedValue();
  vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [] });

  const user = userEvent.setup();
  renderAt('/settings/account');

  await screen.findByText('Sign in to your account');
  // The initial bootstrap `getMe` (rejected by `anonymous()` above) already
  // ran; only now redirect it, so AccountSettingsPage's own query — which
  // fires after login — resolves to jane.
  vi.mocked(api.getMe).mockResolvedValue(member);
  await user.type(screen.getByLabelText('Email or username'), 'jane');
  await user.type(screen.getByLabelText('Password'), 'correct horse');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));

  expect(
    await screen.findByText('jane@bettertrack.test', {}, SIGNED_IN_RENDER),
  ).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Account menu' }));
  await user.click(screen.getByRole('menuitem', { name: 'Logout' }));
  await screen.findByText('Sign in to your account');

  const otherMember: MeResponse = {
    ...member,
    id: 'user-2',
    username: 'bob',
    email: 'bob@bettertrack.test',
  };
  vi.mocked(api.login).mockResolvedValueOnce(otherMember);
  vi.mocked(api.getMe).mockResolvedValue(otherMember);

  await user.type(screen.getByLabelText('Email or username'), 'bob');
  await user.type(screen.getByLabelText('Password'), 'another correct horse');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));

  // Signing out closed the Control Center with the session that opened it, so
  // the identity has to be asked for again — which is the point: the second
  // read must come from bob's account, not from jane's cached `['auth','me']`.
  const utilities = await screen.findByRole('navigation', { name: 'Utilities' });
  await user.click(within(utilities).getByRole('link', { name: 'Control Center' }));

  expect(await screen.findByText('bob@bettertrack.test', {}, SIGNED_IN_RENDER)).toBeInTheDocument();
  expect(screen.queryByText('jane@bettertrack.test')).not.toBeInTheDocument();
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

test('an unknown authenticated user path renders a not-found state without navigating away', async () => {
  vi.mocked(api.getMe).mockResolvedValue(member);
  vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [] });

  renderAtWithLocation('/blabla');

  expect(await screen.findByText('Page not found')).toBeInTheDocument();
  expect(screen.getByText('/blabla', { selector: 'code' })).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Back to start' })).toHaveAttribute('href', '/');
  expect(screen.getByRole('button', { name: 'Back to previous page' })).toBeInTheDocument();

  await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/blabla'));
  const pathname = screen.getByTestId('location').textContent;
  expect(pathname).toBe('/blabla');
});
