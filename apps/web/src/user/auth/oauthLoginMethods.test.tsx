import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { MeResponse, OAuthAuthorizationDetailsResponse } from '@bettertrack/contracts';

vi.mock('../../lib/userApi');
vi.mock('../../lib/portfolioApi');
vi.mock('../../lib/oauthApi');
vi.mock('../../lib/workboardApi', () => ({
  WORKBOARD_QUERY_KEY: ['workboard'],
  listWorkboard: vi.fn(),
  addToWorkboard: vi.fn(),
  removeFromWorkboard: vi.fn(),
  reorderWorkboard: vi.fn(),
}));
vi.mock('../../lib/passkeys', () => ({
  browserSupportsWebAuthn: vi.fn(() => false),
  isPasskeyCancellation: vi.fn(() => false),
  signInWithPasskey: vi.fn(),
}));

import { ApiError } from '../../lib/apiClient';
import * as oauthApi from '../../lib/oauthApi';
import { browserSupportsWebAuthn, signInWithPasskey } from '../../lib/passkeys';
import * as api from '../../lib/userApi';
import { listWorkboard } from '../../lib/workboardApi';
import { waitForColdStart } from '../../test/waitForColdStart';
import { UserApp } from '../UserApp';

/**
 * The OAuth authorize-flow login offers EVERY sign-in method the web login
 * offers (owner-reported 2026-10-29). The mobile app opens
 * `/oauth/authorize?…` in an Android Custom Tab; an anonymous visitor is
 * bounced to `/login` with that request in `state.from`. That login used to
 * hide "Continue with Google" and "Sign in with a passkey" behind
 * `!oauthContext`, so a phone user could only type a password.
 *
 * The parity test does not hard-code a method list: it renders the WEB login
 * with every method switched on, enumerates what it actually offers, and
 * demands the authorize-flow login offer the same — so a future method added
 * to the web login cannot silently be missing inside the authorize flow.
 */

/** The authorize request as the mobile app builds it (first-party client, PKCE). */
const AUTHORIZE =
  '/oauth/authorize?response_type=code&client_id=btc_IbT1mzw_7kBiPHPkGfaE0Q' +
  '&redirect_uri=bettertrack%3A%2F%2Foauth%2Fcallback&scope=portfolio%3Aread' +
  '&state=opaque-state-xyz&code_challenge=a-pkce-code-challenge&code_challenge_method=S256';

const GOOGLE_START = 'http://api.test/api/v1/auth/google/start';

const user: MeResponse = {
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
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const FIRST_PARTY_DETAILS: OAuthAuthorizationDetailsResponse = {
  client: {
    clientId: 'btc_IbT1mzw_7kBiPHPkGfaE0Q',
    name: 'BetterTrackMobile',
    firstParty: true,
    logoPath: null,
  },
  scopes: [{ scope: 'portfolio:read', label: 'View your portfolios' }],
  redirectUri: 'bettertrack://oauth/callback',
  state: 'opaque-state-xyz',
};

function renderAt(entry: string | { pathname: string; search?: string; state?: unknown }) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/*" element={<UserApp />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Wait until the login has settled its registration-info read (Sign up appears). */
async function settledLogin() {
  await waitForColdStart(() => screen.getByText('Sign in to your account'));
  await screen.findByRole('link', { name: 'Sign up' });
}

/** Every interactive control the login offers, by accessible name (sorted). */
function controlNames(): string[] {
  return [...screen.queryAllByRole('button'), ...screen.queryAllByRole('link')]
    .map((el) => el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '')
    .sort();
}

/** The sign-in methods the page declares, in render order. */
function declaredMethods(): string[] {
  return Array.from(document.querySelectorAll('[data-sign-in-method]')).map(
    (el) => el.getAttribute('data-sign-in-method') ?? '',
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  vi.mocked(api.getMe).mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'nope'));
  vi.mocked(api.getParanoidMediaState).mockResolvedValue({
    privacyMode: 'normal',
    mediaState: null,
  });
  vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
  // Every method switched ON: Google configured, WebAuthn supported, open sign-up.
  vi.mocked(api.getRegistrationInfo).mockResolvedValue({ mode: 'open', googleEnabled: true });
  vi.mocked(browserSupportsWebAuthn).mockReturnValue(true);
  vi.mocked(api.googleStartUrl).mockImplementation((returnTo?: string | null) =>
    returnTo ? `${GOOGLE_START}?returnTo=${encodeURIComponent(returnTo)}` : GOOGLE_START,
  );
  vi.mocked(oauthApi.getAuthorizationDetails).mockResolvedValue(FIRST_PARTY_DETAILS);
});

test('the authorize-flow login offers every sign-in method the web login offers', async () => {
  // The web login, as the reference: what does it actually offer?
  const web = renderAt('/login');
  await settledLogin();
  const webControls = controlNames();
  const webMethods = declaredMethods();
  web.unmount();

  // Non-vacuous: the reference really carries the alternative methods.
  expect(webControls).toEqual(
    expect.arrayContaining(['Continue with Google', 'Sign in with a passkey', 'Sign in']),
  );
  expect(webMethods).toEqual(expect.arrayContaining(['google', 'passkey', 'password']));

  // The authorize-flow login (RequireUser's bounce: the request in state.from).
  renderAt({ pathname: '/login', state: { from: AUTHORIZE } });
  await settledLogin();

  expect(controlNames()).toEqual(webControls);
  expect(declaredMethods()).toEqual(webMethods);
});

test('the authorize-flow Google button carries the pending authorize request through the round trip', async () => {
  renderAt({ pathname: '/login', state: { from: AUTHORIZE } });
  await settledLogin();

  const google = screen.getByRole('link', { name: 'Continue with Google' });
  expect(google).toHaveAttribute(
    'href',
    `${GOOGLE_START}?returnTo=${encodeURIComponent(AUTHORIZE)}`,
  );
  expect(api.googleStartUrl).toHaveBeenCalledWith(AUTHORIZE);
});

test('the web login Google button carries no return target (unchanged web flow)', async () => {
  renderAt('/login');
  await settledLogin();
  expect(screen.getByRole('link', { name: 'Continue with Google' })).toHaveAttribute(
    'href',
    GOOGLE_START,
  );
});

test('a passkey sign-in inside the authorize flow asks for an ephemeral session and continues into consent', async () => {
  vi.mocked(signInWithPasskey).mockResolvedValue(user); // pinEnabled: false
  const u = userEvent.setup();
  renderAt({ pathname: '/login', state: { from: AUTHORIZE } });
  await settledLogin();

  await u.click(screen.getByRole('button', { name: 'Sign in with a passkey' }));

  // The consent screen for the app that started the flow — not the webapp.
  expect(await screen.findByText('BetterTrackMobile')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();
  // §399 §A: an OAuth-flow login asks for an EPHEMERAL session.
  expect(signInWithPasskey).toHaveBeenCalledWith(false);
  // The pending request reached consent verbatim — PKCE and state intact.
  await waitFor(() =>
    expect(oauthApi.getAuthorizationDetails).toHaveBeenCalledWith(
      expect.objectContaining({
        client_id: 'btc_IbT1mzw_7kBiPHPkGfaE0Q',
        redirect_uri: 'bettertrack://oauth/callback',
        state: 'opaque-state-xyz',
        code_challenge: 'a-pkce-code-challenge',
        code_challenge_method: 'S256',
      }),
      expect.anything(),
    ),
  );
});

test('a passkey sign-in on a PIN account inside the authorize flow offers the stay-signed-in step first', async () => {
  vi.mocked(signInWithPasskey).mockResolvedValue({ ...user, pinEnabled: true });
  const u = userEvent.setup();
  renderAt({ pathname: '/login', state: { from: AUTHORIZE } });
  await settledLogin();

  await u.click(screen.getByRole('button', { name: 'Sign in with a passkey' }));

  // Same PIN-dependent persist choice a password login gets (V4-P2b, §399 §A).
  expect(await screen.findByLabelText(/stay signed in on this browser/i)).toBeInTheDocument();
  expect(signInWithPasskey).toHaveBeenCalledWith(false);
  await u.click(screen.getByRole('button', { name: 'Continue' }));
  expect(await screen.findByText('BetterTrackMobile')).toBeInTheDocument();
});

test('a Google failure bounced back with returnTo keeps the authorize context on the login', async () => {
  renderAt(`/login?error=google_failed&returnTo=${encodeURIComponent(AUTHORIZE)}`);
  await settledLogin();

  // The notice, and every method still carrying the authorize request.
  expect(screen.getByText('Google sign-in failed. Please try again.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Continue with Google' })).toHaveAttribute(
    'href',
    `${GOOGLE_START}?returnTo=${encodeURIComponent(AUTHORIZE)}`,
  );
  expect(screen.getByRole('link', { name: 'Sign up' })).toHaveAttribute(
    'href',
    `/register?returnTo=${encodeURIComponent(AUTHORIZE)}`,
  );
  // OAuth-flow login rules apply (no up-front "stay signed in").
  expect(screen.queryByLabelText('Stay signed in')).not.toBeInTheDocument();
});

/** The login ignored its `returnTo`: an ordinary web login, nothing carried. */
function expectPlainWebLogin() {
  expect(screen.getByRole('link', { name: 'Continue with Google' })).toHaveAttribute(
    'href',
    GOOGLE_START,
  );
  expect(api.googleStartUrl).not.toHaveBeenCalledWith(expect.stringContaining('evil'));
  expect(screen.getByRole('link', { name: 'Sign up' })).toHaveAttribute('href', '/register');
  expect(screen.getByLabelText('Stay signed in')).toBeInTheDocument();
}

test.each([
  ['an external origin', 'https://evil.test/oauth/authorize'],
  ['a bare external origin', 'https://evil'],
  ['a protocol-relative URL', '//evil.test/oauth/authorize'],
  ['a bare protocol-relative URL', '//evil'],
  ['a traversal off the authorize path', '/oauth/authorize/../x'],
  ['a javascript: URL', 'javascript:alert(1)'],
  ['an internal non-authorize path', '/settings/security'],
])('a %s in the login returnTo is ignored: a plain web login', async (_label, hostile) => {
  renderAt(`/login?error=google_failed&returnTo=${encodeURIComponent(hostile)}`);
  await settledLogin();
  expectPlainWebLogin();
});

test.each([
  ['the authorize request first, a hostile target second', [AUTHORIZE, '//evil']],
  ['a hostile target first, the authorize request second', ['https://evil', AUTHORIZE]],
])('a repeated returnTo (%s) is refused outright: a plain web login', async (_label, values) => {
  const query = values.map((v) => `returnTo=${encodeURIComponent(v)}`).join('&');
  renderAt(`/login?error=google_failed&${query}`);
  await settledLogin();
  expectPlainWebLogin();
});
