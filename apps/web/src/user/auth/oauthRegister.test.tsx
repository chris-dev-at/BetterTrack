import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type {
  MeResponse,
  OAuthAuthorizationDetailsResponse,
  RegistrationMode,
} from '@bettertrack/contracts';

vi.mock('../../lib/oauthApi', () => ({
  getAuthorizationDetails: vi.fn(),
  approveAuthorization: vi.fn(),
  denyAuthorization: vi.fn(),
  listOAuthClients: vi.fn(),
  createOAuthClient: vi.fn(),
  deleteOAuthClient: vi.fn(),
  listOAuthGrants: vi.fn(),
  revokeOAuthGrant: vi.fn(),
}));
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
import * as oauthApi from '../../lib/oauthApi';
import * as api from '../../lib/userApi';
import { listWorkboard } from '../../lib/workboardApi';
import { waitForColdStart } from '../../test/waitForColdStart';
import { UserApp } from '../UserApp';
import { registerPathForAuthorize } from './oauthContinuation';

/**
 * App-native registration inside the OAuth authorize flow (owner directive
 * 2026-08-07; PROJECTPLAN.md §6.13 part 2, §13.4 V4-P2b).
 *
 * The bug this pins down: registering from the phone's Custom Tab used to land
 * in the WEBAPP, stranding the user outside the app that started the flow.
 * These tests walk the whole surface — the `screen=register` hint, the 201
 * continuation into consent, and every mode that must NOT continue.
 */

/** The authorize request as the mobile app builds it (first-party client, PKCE). */
const AUTHORIZE =
  '/oauth/authorize?response_type=code&client_id=btc_IbT1mzw_7kBiPHPkGfaE0Q' +
  '&redirect_uri=bettertrack%3A%2F%2Foauth%2Fcallback&scope=portfolio%3Aread' +
  '&state=opaque-state-xyz&code_challenge=a-pkce-code-challenge&code_challenge_method=S256';

/** …plus the "open on the registration form" hint the app's button appends. */
const AUTHORIZE_REGISTER = `${AUTHORIZE}&screen=register`;

/** The register URL the flow hands out — asserted, then reused as the entry point. */
const REGISTER_WITH_CONTINUATION = registerPathForAuthorize(AUTHORIZE_REGISTER);

const newUser: MeResponse = {
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
  // A brand-new account has never been through setup. In the OAuth flow that
  // must NOT divert to /welcome — first-run setup happens in the app.
  firstRunCompletedAt: null,
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

function renderAt(entry: string | { pathname: string; state?: unknown }) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/*" element={<UserApp />} />
      </Routes>
    </MemoryRouter>,
  );
}

function setMode(mode: RegistrationMode) {
  vi.mocked(api.getRegistrationInfo).mockResolvedValue({ mode, googleEnabled: false });
}

/** Fill and submit the register form. */
async function fillRegisterForm(u: ReturnType<typeof userEvent.setup>, submitLabel: string) {
  await u.type(screen.getByLabelText('Email'), 'jane@bettertrack.test');
  await u.type(screen.getByLabelText('Username'), 'jane');
  await u.type(screen.getByLabelText('Password'), 'jane-strong-pass-1');
  await u.click(screen.getByRole('button', { name: submitLabel }));
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
  vi.mocked(oauthApi.getAuthorizationDetails).mockResolvedValue(FIRST_PARTY_DETAILS);
});

// ── The entry points: how the app reaches the register form ──────────────────

test('screen=register on the authorize URL opens the register form directly, no login screen', async () => {
  setMode('open');
  // Exactly what happens on the phone: the tab opens the authorize URL, and
  // RequireUser bounces the anonymous visitor to /login carrying it.
  renderAt({ pathname: '/login', state: { from: AUTHORIZE_REGISTER } });

  expect(await waitForColdStart(() => screen.getByLabelText('Email'))).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();
  // Never the login form.
  expect(screen.queryByLabelText('Email or username')).not.toBeInTheDocument();
});

test('the OAuth login screen offers Sign up, carrying the authorize request as returnTo', async () => {
  setMode('open');
  renderAt({ pathname: '/login', state: { from: AUTHORIZE } });

  const signUp = await waitForColdStart(() => screen.getByRole('link', { name: 'Sign up' }));
  const href = signUp.getAttribute('href') ?? '';
  expect(href.startsWith('/register?returnTo=')).toBe(true);
  const returnTo = new URLSearchParams(href.slice(href.indexOf('?') + 1)).get('returnTo');
  expect(returnTo).toBe(AUTHORIZE);
});

test('a closed instance offers no Sign up inside the OAuth flow either', async () => {
  setMode('closed');
  renderAt({ pathname: '/login', state: { from: AUTHORIZE } });

  await waitForColdStart(() => screen.getByLabelText('Email or username'));
  expect(screen.queryByRole('link', { name: 'Sign up' })).not.toBeInTheDocument();
});

// ── 201 → continue straight into the authorize request ───────────────────────

test('open mode: a created account continues into consent — never the webapp home', async () => {
  setMode('open');
  vi.mocked(api.register).mockResolvedValue(newUser);
  const u = userEvent.setup();
  renderAt(REGISTER_WITH_CONTINUATION);

  await waitForColdStart(() => screen.getByLabelText('Email'));
  await fillRegisterForm(u, 'Create account');

  // The consent screen for the app that started the flow — not Home, not the
  // first-run wizard (the authorize path is FirstRunGate-exempt).
  expect(await screen.findByText('BetterTrackMobile')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Is this you?' })).not.toBeInTheDocument();

  // The pending authorize request reached the API verbatim — PKCE and state intact.
  await waitFor(() =>
    expect(oauthApi.getAuthorizationDetails).toHaveBeenCalledWith(
      expect.objectContaining({
        client_id: 'btc_IbT1mzw_7kBiPHPkGfaE0Q',
        redirect_uri: 'bettertrack://oauth/callback',
        scope: 'portfolio:read',
        state: 'opaque-state-xyz',
        code_challenge: 'a-pkce-code-challenge',
        code_challenge_method: 'S256',
      }),
      expect.anything(),
    ),
  );
});

test('open mode: the registration asks the server for an ephemeral session (§16, §399 §A)', async () => {
  setMode('open');
  vi.mocked(api.register).mockResolvedValue(newUser);
  const u = userEvent.setup();
  renderAt(REGISTER_WITH_CONTINUATION);

  await waitForColdStart(() => screen.getByLabelText('Email'));
  await fillRegisterForm(u, 'Create account');

  await waitFor(() =>
    expect(api.register).toHaveBeenCalledWith({
      email: 'jane@bettertrack.test',
      username: 'jane',
      password: 'jane-strong-pass-1',
      locale: 'en',
      oauthRegistration: true,
    }),
  );
});

test('invite-token mode: the token field is asked for as usual, then the flow continues', async () => {
  setMode('invite_token');
  vi.mocked(api.register).mockResolvedValue(newUser);
  const u = userEvent.setup();
  renderAt(REGISTER_WITH_CONTINUATION);

  await u.type(await waitForColdStart(() => screen.getByLabelText(/Access token/i)), 'INVITE-XYZ');
  await fillRegisterForm(u, 'Create account');

  await waitFor(() =>
    expect(api.register).toHaveBeenCalledWith(
      expect.objectContaining({ inviteToken: 'INVITE-XYZ', oauthRegistration: true }),
    ),
  );
  expect(await screen.findByText('BetterTrackMobile')).toBeInTheDocument();
});

// ── Modes that must NOT continue ─────────────────────────────────────────────

test('approval mode: 202 parks on the pending state inside the same surface, no consent', async () => {
  setMode('approval');
  vi.mocked(api.register).mockResolvedValue({ pending: true });
  const u = userEvent.setup();
  renderAt(REGISTER_WITH_CONTINUATION);

  await waitForColdStart(() => screen.getByLabelText('Email'));
  await fillRegisterForm(u, 'Request account');

  expect(await screen.findByText(/pending administrator approval/i)).toBeInTheDocument();
  // The app is told, in this same surface, to come back later.
  expect(screen.getByText(/return to the BetterTrack app/i)).toBeInTheDocument();
  // No session, so nothing to authorize with — consent was never reached.
  expect(screen.queryByText('BetterTrackMobile')).not.toBeInTheDocument();
  expect(oauthApi.getAuthorizationDetails).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();
});

test('closed mode: the closed notice explains itself and returns to the authorize request', async () => {
  setMode('closed');
  renderAt(REGISTER_WITH_CONTINUATION);

  expect(
    await waitForColdStart(() => screen.getByText(/registration is currently closed/i)),
  ).toBeInTheDocument();
  // Back-to-sign-in stays inside the OAuth flow — and drops the `screen` hint,
  // which would otherwise bounce straight back here forever.
  const back = screen.getByRole('link', { name: 'Go to sign in' });
  expect(back).toHaveAttribute('href', AUTHORIZE);
  expect(back.getAttribute('href')).not.toContain('screen=');
});

test('the mirrored Sign-in box returns to the authorize request, not to a bare /login', async () => {
  setMode('open');
  renderAt(REGISTER_WITH_CONTINUATION);

  await waitForColdStart(() => screen.getByLabelText('Email'));
  expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', AUTHORIZE);
});

test('Google sign-up is hidden inside the OAuth flow — its round-trip would drop the continuation', async () => {
  vi.mocked(api.getRegistrationInfo).mockResolvedValue({ mode: 'open', googleEnabled: true });
  vi.mocked(api.googleStartUrl).mockReturnValue('http://api.test/api/v1/auth/google/start');
  renderAt(REGISTER_WITH_CONTINUATION);

  await waitForColdStart(() => screen.getByLabelText('Email'));
  expect(screen.queryByRole('link', { name: 'Continue with Google' })).not.toBeInTheDocument();
});

// ── The guard, seen from the page ────────────────────────────────────────────

test.each([
  ['an external origin', 'https://evil.test/oauth/authorize'],
  ['a protocol-relative URL', '//evil.test'],
  ['a javascript: URL', 'javascript:alert(1)'],
  ['an internal non-authorize path', '/settings/security'],
])('a %s in returnTo is ignored: registration lands in the webapp instead', async (_l, hostile) => {
  setMode('open');
  vi.mocked(api.register).mockResolvedValue(newUser);
  const u = userEvent.setup();
  renderAt(`/register?returnTo=${encodeURIComponent(hostile)}`);

  await waitForColdStart(() => screen.getByLabelText('Email'));
  // No continuation is on offer, so the page is the ordinary register surface.
  expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');

  await fillRegisterForm(u, 'Create account');

  // The ordinary path: first-run setup in the webapp, and no ephemeral-session
  // request — the payload is byte-identical to a plain registration.
  expect(await screen.findByRole('heading', { name: 'Is this you?' })).toBeInTheDocument();
  expect(api.register).toHaveBeenCalledWith({
    email: 'jane@bettertrack.test',
    username: 'jane',
    password: 'jane-strong-pass-1',
    locale: 'en',
  });
  expect(oauthApi.getAuthorizationDetails).not.toHaveBeenCalled();
});
