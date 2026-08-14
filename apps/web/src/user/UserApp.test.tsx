import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { Alert, MeResponse, SharedLinkResponse } from '@bettertrack/contracts';

import { waitForColdStart } from '../test/waitForColdStart';

vi.mock('../lib/userApi');
vi.mock('../lib/workboardApi', () => ({
  WORKBOARD_QUERY_KEY: ['workboard'],
  WATCHLISTS_QUERY_KEY: ['workboard', 'watchlists'],
  listWorkboard: vi.fn(),
  listWatchlists: vi.fn(async () => ({ watchlists: [] })),
  addToWorkboard: vi.fn(),
  removeFromWorkboard: vi.fn(),
  reorderWorkboard: vi.fn(),
}));
// `/` now redirects to `/portfolio` (§7.2), so a couple of auth-flow tests land
// on the Portfolio page. Auto-mock its data module so it settles without a real
// network call; these tests only assert we reached the authenticated shell.
vi.mock('../lib/portfolioApi');
vi.mock('../lib/socialApi');
vi.mock('./vault/v2/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./vault/v2/api')>()),
  listVaults: vi.fn(async () => []),
}));
vi.mock('../lib/alertsApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/alertsApi')>()),
  listAlerts: vi.fn(),
  rearmAlert: vi.fn(),
}));

import { ApiError, apiRequest } from '../lib/apiClient';
import { listAlerts, rearmAlert } from '../lib/alertsApi';
import * as api from '../lib/userApi';
import { listPortfolios } from '../lib/portfolioApi';
import { listFollowing, listItemFollows, resolveShareLink } from '../lib/socialApi';
import { listWorkboard } from '../lib/workboardApi';
import { listVaults } from './vault/v2/api';
import { queryClient, UserApp } from './UserApp';

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

const publicWatchlist: SharedLinkResponse = {
  kind: 'watchlist',
  watchlist: {
    watchlistId: '00000000-0000-0000-0000-000000000010',
    name: 'Public watchlist',
    owner: { id: '00000000-0000-0000-0000-000000000011', username: 'jane' },
    items: [],
  },
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getParanoidMediaState).mockResolvedValue({
    privacyMode: 'normal',
    mediaState: null,
  });
  // WorkboardPage fetches the watchlist on mount; return an empty list so the
  // page renders without errors in tests that exercise the workboard route.
  vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
  vi.mocked(listFollowing).mockResolvedValue({
    following: [],
    followingCount: 0,
    followerCount: 0,
  });
  vi.mocked(listItemFollows).mockResolvedValue({ items: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('the app query client protects implicit reads without overriding explicit query settings', () => {
  const implicit = queryClient.defaultQueryOptions({
    queryKey: ['test', 'implicit-defaults'],
    queryFn: async () => null,
  });
  expect(implicit.staleTime).toBe(30_000);
  expect(implicit.refetchOnWindowFocus).toBe(false);
  expect(implicit.retry).toBe(1);

  const explicit = queryClient.defaultQueryOptions({
    queryKey: ['test', 'explicit-stale-time'],
    queryFn: async () => null,
    staleTime: 60_000,
  });
  expect(explicit.staleTime).toBe(60_000);
});

test('an unauthenticated visit to a user route redirects to /login', async () => {
  anonymous();

  renderAt('/workboard');

  expect(
    await waitForColdStart(() => screen.getByText('Sign in to your account')),
  ).toBeInTheDocument();
  expect(
    screen.queryByText('Your watched assets, alerts and blueprints at a glance.'),
  ).not.toBeInTheDocument();
});

test('an anonymous public link does not start the protected vault directory', async () => {
  anonymous();
  vi.mocked(resolveShareLink).mockResolvedValue(publicWatchlist);
  queryClient.clear();

  renderAt('/s/tok_abc');

  expect(
    await waitForColdStart(() => screen.getByText('Read-only shared view')),
  ).toBeInTheDocument();
  expect(await screen.findByRole('heading', { name: 'Public watchlist' })).toBeInTheDocument();
  expect(listVaults).not.toHaveBeenCalled();
});

test('an unauthenticated visit to an unknown route still redirects to /login', async () => {
  anonymous();

  renderAtWithLocation('/not-a-real-route');

  expect(
    await waitForColdStart(() => screen.getByText('Sign in to your account')),
  ).toBeInTheDocument();
  expect(screen.getByTestId('location')).toHaveTextContent('/login');
});

test('/people/following renders and is reachable from People navigation', async () => {
  vi.mocked(api.getMe).mockResolvedValue(member);
  vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [] });

  renderAtWithLocation('/people/following');

  expect(
    await waitForColdStart(() => screen.getByRole('heading', { name: 'Following' })),
  ).toBeInTheDocument();
  expect(screen.getByTestId('location')).toHaveTextContent('/people/following');
  expect(screen.getAllByRole('link', { name: 'Following' })[0]).toHaveAttribute(
    'href',
    '/people/following',
  );
});

test('after signing in, the user returns to the originally requested route', async () => {
  anonymous();
  vi.mocked(api.login).mockResolvedValue(member);

  const user = userEvent.setup();
  renderAt('/workboard');

  await waitForColdStart(() => screen.getByText('Sign in to your account'));
  await user.type(screen.getByLabelText('Email or username'), 'jane');
  await user.type(screen.getByLabelText('Password'), 'correct horse');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));

  // Landed on the intended route (the legacy /workboard path redirects into
  // the Workbench destination), not the Home command center.
  expect(
    await waitForColdStart(() =>
      screen.getByText('Your watched assets, alerts and blueprints at a glance.'),
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

  await waitForColdStart(() => screen.getByText('Sign in to your account'));
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

  await waitForColdStart(() => screen.getByText('Sign in to your account'));
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

  await waitForColdStart(() => screen.getByText('Sign in to your account'));
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
  expect(
    await waitForColdStart(() => screen.getByText(/You're doing that too fast/i)),
  ).toBeInTheDocument();
  // After the retry, the app admits the user — the shell renders (§7.4).
  expect(
    await waitForColdStart(() => screen.getByRole('button', { name: 'Account menu' })),
  ).toBeInTheDocument();
  await waitFor(() => expect(api.getMe).toHaveBeenCalledTimes(2));
});

test('a rate-limited mutation shows only the global 429 notice', async () => {
  const triggeredAlert: Alert = {
    id: 'al1',
    kind: 'price_above',
    threshold: 200,
    refPrice: null,
    repeat: false,
    status: 'triggered',
    lastTriggeredAt: '2026-08-05T06:00:00.000Z',
    asset: {
      id: 'asset-1',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      currency: 'USD',
      type: 'stock',
    },
  };
  vi.mocked(api.getMe).mockResolvedValue(member);
  vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [] });
  vi.mocked(listAlerts).mockResolvedValue({ items: [triggeredAlert] });
  let releaseRateLimitedResponse!: (response: Response) => void;
  const rateLimitedResponse = new Promise<Response>((resolve) => {
    releaseRateLimitedResponse = resolve;
  });
  let markRearmSettled!: () => void;
  const rearmSettled = new Promise<void>((resolve) => {
    markRearmSettled = resolve;
  });
  vi.mocked(rearmAlert).mockImplementation(async () => {
    try {
      return await apiRequest<Alert>('/alerts/al1/rearm', { method: 'POST' });
    } finally {
      // The global policy receives the 429 before apiRequest rejects. Waiting
      // for that handoff lets the assertion below keep its ordinary UI wait.
      markRearmSettled();
    }
  });
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>((input) => {
      if (!String(input).endsWith('/alerts/al1/rearm')) {
        throw new TypeError(`Unexpected test request: ${String(input)}`);
      }
      return rateLimitedResponse;
    }),
  );

  const user = userEvent.setup();
  renderAt('/workbench/alerts');

  await user.click(await waitForColdStart(() => screen.getByRole('button', { name: 'Re-arm' })));

  await waitFor(() => expect(rearmAlert).toHaveBeenCalledWith('al1'));
  await act(async () => {
    releaseRateLimitedResponse({
      ok: false,
      status: 429,
      json: async () => ({
        error: { code: 'RATE_LIMITED', message: 'Too many requests.' },
      }),
      headers: {
        get: (name: string) => (name.toLowerCase() === 'retry-after' ? '30' : null),
      },
    } as Response);
    await rearmSettled;
  });

  expect(
    await screen.findByText("You're doing that too fast. Please wait 30 seconds and try again."),
  ).toBeInTheDocument();
  expect(
    screen.queryByText("Couldn't update that alert. Please try again."),
  ).not.toBeInTheDocument();
  expect(screen.getAllByRole('alert')).toHaveLength(1);
});

/** The alert the rate-limit scenarios below act on; re-armable, so it keeps its button. */
const triggeredAlertFixture: Alert = {
  id: 'al1',
  kind: 'price_above',
  threshold: 200,
  refPrice: null,
  repeat: false,
  status: 'triggered',
  lastTriggeredAt: '2026-08-05T06:00:00.000Z',
  asset: {
    id: 'asset-1',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    currency: 'USD',
    type: 'stock',
  },
};

/** Every `/alerts/al1/rearm` call answers 429 with `Retry-After: 30`. */
function stubRateLimitedRearm() {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>(async (input) => {
      if (!String(input).endsWith('/alerts/al1/rearm')) {
        throw new TypeError(`Unexpected test request: ${String(input)}`);
      }
      return {
        ok: false,
        status: 429,
        json: async () => ({
          error: { code: 'RATE_LIMITED', message: 'Too many requests.' },
        }),
        headers: {
          get: (name: string) => (name.toLowerCase() === 'retry-after' ? '30' : null),
        },
      } as Response;
    }),
  );
}

const RATE_LIMIT_NOTICE = "You're doing that too fast. Please wait 30 seconds and try again.";

test('a 429 takes over the toast slot from a success notice that is still showing', async () => {
  // Regression: the rate-limit notice and mutation feedback used to render two
  // independent toasts into the same fixed slot. Suppressing the *generic* 429
  // error was not enough — a success toast from seconds earlier stayed mounted
  // and, being later in DOM order, covered the rate-limit error the user needs.
  vi.mocked(api.getMe).mockResolvedValue(member);
  vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [] });
  vi.mocked(listAlerts).mockResolvedValue({ items: [triggeredAlertFixture] });
  let attempt = 0;
  vi.mocked(rearmAlert).mockImplementation(() => {
    attempt += 1;
    // First re-arm succeeds and mounts the success toast; the second is
    // rate-limited well inside that toast's lifetime.
    if (attempt === 1) return Promise.resolve({ ...triggeredAlertFixture, status: 'active' });
    return apiRequest<Alert>('/alerts/al1/rearm', { method: 'POST' });
  });
  stubRateLimitedRearm();

  const user = userEvent.setup();
  renderAt('/workbench/alerts');

  await user.click(await waitForColdStart(() => screen.getByRole('button', { name: 'Re-arm' })));
  expect(await screen.findByText('Alert re-armed.')).toBeInTheDocument();

  await user.click(await screen.findByRole('button', { name: 'Re-arm' }));

  expect(await screen.findByText(RATE_LIMIT_NOTICE)).toBeInTheDocument();
  expect(screen.queryByText('Alert re-armed.')).not.toBeInTheDocument();
  const alerts = screen.getAllByRole('alert');
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toHaveTextContent(RATE_LIMIT_NOTICE);
});

test('an identical repeat 429 surfaces again after the notice was dismissed', async () => {
  // Guards the handoff: the banner source is a plain string, so if it were only
  // cleared on dismissal of a toast it no longer owns, the identical second 429
  // would not be a state change and the user would see nothing at all.
  vi.mocked(api.getMe).mockResolvedValue(member);
  vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [] });
  vi.mocked(listAlerts).mockResolvedValue({ items: [triggeredAlertFixture] });
  vi.mocked(rearmAlert).mockImplementation(() =>
    apiRequest<Alert>('/alerts/al1/rearm', { method: 'POST' }),
  );
  stubRateLimitedRearm();

  const user = userEvent.setup();
  renderAt('/workbench/alerts');

  await user.click(await waitForColdStart(() => screen.getByRole('button', { name: 'Re-arm' })));
  expect(await screen.findByText(RATE_LIMIT_NOTICE)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Dismiss' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());

  await user.click(screen.getByRole('button', { name: 'Re-arm' }));

  expect(await screen.findByText(RATE_LIMIT_NOTICE)).toBeInTheDocument();
  expect(screen.getAllByRole('alert')).toHaveLength(1);
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

    expect(
      await waitForColdStart(() => screen.getByText(/can’t verify your session right now/i)),
    ).toBeInTheDocument();
    expect(screen.queryByText('Sign in to your account')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(
      await waitForColdStart(() => screen.getByRole('button', { name: 'Account menu' })),
    ).toBeInTheDocument();
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
  expect(
    await waitForColdStart(() => screen.getByText('Choose a new password')),
  ).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();

  // No "Current password" field: the temp-password login is the proof, so it is
  // never asked for a second time (#248 item 7).
  expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
  await user.type(screen.getByLabelText('New password'), 'a-brand-new-secret');
  await user.type(screen.getByLabelText('Confirm new password'), 'a-brand-new-secret');
  await user.click(screen.getByRole('button', { name: 'Update password' }));

  // Released into the app shell (lands on /portfolio via the `/` redirect).
  expect(
    await waitForColdStart(() => screen.getByRole('button', { name: 'Account menu' })),
  ).toBeInTheDocument();
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

  await waitForColdStart(() => screen.getByText('Choose a new password'));
  await user.click(screen.getByRole('button', { name: 'Sign out' }));

  // Now anonymous at `/` → the guard sends us to login.
  expect(
    await waitForColdStart(() => screen.getByText('Sign in to your account')),
  ).toBeInTheDocument();
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
  const email = await waitForColdStart(() => screen.getByDisplayValue('newbie@bettertrack.test'));
  expect(email).toBeDisabled();

  await user.type(screen.getByLabelText('Username'), 'newbie');
  await user.type(screen.getByLabelText('Password'), 'a-brand-new-secret');
  await user.click(screen.getByRole('button', { name: 'Create account' }));

  // Accepting an invite creates an account, so it lands on first-run setup —
  // not on Home. Dismissing it opens the app exactly as before.
  expect(
    await waitForColdStart(() => screen.getByRole('heading', { name: 'Is this you?' })),
  ).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Do this later' }));

  expect(
    await waitForColdStart(() => screen.getByRole('button', { name: 'Account menu' })),
  ).toBeInTheDocument();
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

  await waitForColdStart(() => screen.getByText('Sign in to your account'));
  // The initial bootstrap `getMe` (rejected by `anonymous()` above) already
  // ran; only now redirect it, so AccountSettingsPage's own query — which
  // fires after login — resolves to jane.
  vi.mocked(api.getMe).mockResolvedValue(member);
  await user.type(screen.getByLabelText('Email or username'), 'jane');
  await user.type(screen.getByLabelText('Password'), 'correct horse');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));

  expect(
    await waitForColdStart(() => screen.getByText('jane@bettertrack.test')),
  ).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Account menu' }));
  await user.click(screen.getByRole('menuitem', { name: 'Logout' }));
  await waitForColdStart(() => screen.getByText('Sign in to your account'));

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
  const utilities = await waitForColdStart(() =>
    screen.getByRole('navigation', { name: 'Utilities' }),
  );
  await user.click(within(utilities).getByRole('link', { name: 'Control Center' }));

  expect(
    await waitForColdStart(() => screen.getByText('bob@bettertrack.test')),
  ).toBeInTheDocument();
  expect(screen.queryByText('jane@bettertrack.test')).not.toBeInTheDocument();
});

test('invite accept: an invalid token is rejected with a clear message and no form', async () => {
  anonymous();
  vi.mocked(api.validateInvite).mockResolvedValue({ valid: false, email: null });

  renderAt('/invite/expired-token');

  expect(
    await waitForColdStart(() => screen.getByText(/invalid, expired, or has already been used/i)),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();
});

test('an unknown authenticated user path renders a not-found state without navigating away', async () => {
  vi.mocked(api.getMe).mockResolvedValue(member);
  vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [] });

  renderAtWithLocation('/blabla');

  expect(await waitForColdStart(() => screen.getByText('Page not found'))).toBeInTheDocument();
  expect(screen.getByText('/blabla', { selector: 'code' })).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Back to start' })).toHaveAttribute('href', '/');
  expect(screen.getByRole('button', { name: 'Back to previous page' })).toBeInTheDocument();

  await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/blabla'));
  const pathname = screen.getByTestId('location').textContent;
  expect(pathname).toBe('/blabla');
});
