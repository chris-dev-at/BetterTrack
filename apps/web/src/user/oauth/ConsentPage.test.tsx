import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  API_KEY_SCOPES,
  type ApiKeyScope,
  OAUTH_SCOPE_LABELS,
  type MeResponse,
  type OAuthApproveResponse,
  type OAuthAuthorizationDetailsResponse,
  type OAuthDenyResponse,
} from '@bettertrack/contracts';

vi.mock('../../lib/oauthApi', () => ({
  getAuthorizationDetails: vi.fn(),
  approveAuthorization: vi.fn(),
  denyAuthorization: vi.fn(),
  // The Settings page (loaded via UserApp) also imports these; stub them so the
  // module mock is complete even though this suite never exercises them.
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
vi.mock('../../lib/runtimeConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/runtimeConfig')>();
  return {
    ...actual,
    // Exercise the shipped plain-HTTP ports topology: the API asset is not
    // same-origin because the SPA and API listen on different ports.
    apiBaseUrl: () => 'http://track.lan:4300/api/v1',
  };
});

import { ApiError } from '../../lib/apiClient';
import {
  approveAuthorization,
  denyAuthorization,
  getAuthorizationDetails,
} from '../../lib/oauthApi';
import * as userApi from '../../lib/userApi';
import { waitForColdStart } from '../../test/waitForColdStart';
import { AuthProvider } from '../AuthContext';
import { UserApp } from '../UserApp';
import { ResolvedPrivacyModeProvider } from '../vault/usePrivacyMode';
import { ConsentPage } from './ConsentPage';

// A realistic authorization-code + PKCE request as it arrives on the URL.
const AUTHORIZE_QUERY = new URLSearchParams({
  response_type: 'code',
  client_id: 'btc_charting_buddy',
  redirect_uri: 'https://app.example.com/cb',
  scope: 'portfolio:read market:read',
  state: 'opaque-state-xyz',
  code_challenge: 'a-pkce-code-challenge',
  code_challenge_method: 'S256',
}).toString();

const AUTHORIZE_PATH = `/oauth/authorize?${AUTHORIZE_QUERY}`;

const DETAILS: OAuthAuthorizationDetailsResponse = {
  client: {
    clientId: 'btc_charting_buddy',
    name: 'Charting Buddy',
    firstParty: false,
    logoPath: null,
  },
  scopes: [
    {
      scope: 'portfolio:read',
      label:
        'View your portfolios, holdings, transactions, cash balances and the dividend, earnings and news feeds derived from them',
    },
    { scope: 'market:read', label: 'Search assets and read market data' },
  ],
  redirectUri: 'https://app.example.com/cb',
  state: 'opaque-state-xyz',
};

const APPROVED: OAuthApproveResponse = {
  redirectTo: 'https://app.example.com/cb?code=one-time-code&state=opaque-state-xyz',
};

const DENIED: OAuthDenyResponse = {
  redirectTo: 'https://app.example.com/cb?error=access_denied&state=opaque-state-xyz',
};

const meUser: MeResponse = {
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

// jsdom throws on real navigation — swap window.location for a plain object so
// the Approve handler's `window.location.href = …` is observable, not a crash.
const originalLocation = window.location;
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { ...originalLocation, href: 'http://localhost/', assign: vi.fn() },
  });
  // Default to signed-in as `jane` — every test that renders the consent screen
  // needs an authenticated user for the "Signed in as …" line and the logout
  // path. Individual tests override to test the unauthenticated redirect.
  vi.mocked(userApi.getMe).mockResolvedValue(meUser);
  vi.mocked(userApi.getParanoidMediaState).mockResolvedValue({
    privacyMode: 'normal',
    mediaState: null,
  });
});
afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

/**
 * Render the consent screen wrapped in a real AuthProvider so `useAuth()` (used
 * by V4-P2b for the "Signed in as X" line and the "Use another account" logout)
 * behaves like it does in the app. The bootstrap `/auth/me` is mocked above.
 */
function renderConsent({
  path = AUTHORIZE_PATH,
  privacyMode = 'normal',
}: {
  path?: string;
  privacyMode?: 'normal' | 'paranoid';
} = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ResolvedPrivacyModeProvider mode={privacyMode} accountId={meUser.id}>
        <MemoryRouter initialEntries={[path]}>
          <AuthProvider>
            <Routes>
              <Route path="/oauth/authorize" element={<ConsentPage />} />
              <Route path="/" element={<div>Home</div>} />
              <Route path="/login" element={<div>Login page stub</div>} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </ResolvedPrivacyModeProvider>
    </QueryClientProvider>,
  );
}

test('third-party card shows the signed-in account plus Use another account, and approving navigates to redirectTo', async () => {
  vi.mocked(getAuthorizationDetails).mockResolvedValue(DETAILS);
  vi.mocked(approveAuthorization).mockResolvedValue(APPROVED);
  const user = userEvent.setup();
  renderConsent();

  // App name + plain-language scopes (not the raw scope tokens).
  expect(await screen.findByText('Third-party app')).toBeInTheDocument();
  expect(
    screen.getByText(
      'View your portfolios, holdings, transactions, cash balances and the dividend, earnings and news feeds derived from them',
    ),
  ).toBeInTheDocument();
  expect(screen.getByText('Search assets and read market data')).toBeInTheDocument();
  // V4-P2b: the signed-in identity and switch-account escape hatch are always
  // shown, so a browser-shared session can't authorize under the wrong account.
  expect(screen.getByText('Signed in as jane')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Use another account' })).toBeInTheDocument();
  // No configured/cached logo stays on the existing letter placeholder.
  expect(document.querySelector('img')).toBeNull();
  expect(screen.getByText('C')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Approve' }));

  // Approve forwards the full request (PKCE + state preserved) and follows the
  // service-signed destination — never a raw redirect_uri.
  await waitFor(() => expect(window.location.href).toBe(APPROVED.redirectTo));
  expect(approveAuthorization).toHaveBeenCalledWith(
    expect.objectContaining({
      client_id: 'btc_charting_buddy',
      redirect_uri: 'https://app.example.com/cb',
      scope: 'portfolio:read market:read',
      state: 'opaque-state-xyz',
      code_challenge: 'a-pkce-code-challenge',
      code_challenge_method: 'S256',
    }),
  );
});

test('consent screen names the destructive capabilities the requested scopes carry (#1860)', async () => {
  // The scopes whose copy understated what they grant — the consent screen is
  // the ONLY place the user is told before authorizing, so the corrected
  // sentences have to survive the whole label → i18n → ScopeSummary path.
  vi.mocked(getAuthorizationDetails).mockResolvedValue({
    ...DETAILS,
    scopes: [
      { scope: 'mirrorchain:write', label: OAUTH_SCOPE_LABELS['mirrorchain:write'] },
      { scope: 'account:security', label: OAUTH_SCOPE_LABELS['account:security'] },
      { scope: 'portfolio:write', label: OAUTH_SCOPE_LABELS['portfolio:write'] },
    ],
  });
  renderConsent();

  expect(await screen.findByText(/delete a group portfolio/i)).toBeInTheDocument();
  expect(screen.getByText(/transfer ownership/i)).toBeInTheDocument();
  expect(screen.getByText(/permanently deleting a vault/i)).toBeInTheDocument();
  expect(screen.getByText(/tax regime/i)).toBeInTheDocument();
});

test('client logos load from the cross-port BetterTrack API and fall back if that cache read fails', async () => {
  vi.mocked(getAuthorizationDetails).mockResolvedValue({
    ...DETAILS,
    client: {
      ...DETAILS.client,
      logoPath: '/oauth/client-logos/btc_charting_buddy',
    },
  });
  renderConsent();

  await screen.findByText('Third-party app');
  const logo = document.querySelector('img');
  expect(logo).not.toBeNull();
  expect(logo).toHaveAttribute(
    'src',
    'http://track.lan:4300/api/v1/oauth/client-logos/btc_charting_buddy',
  );
  expect(logo?.getAttribute('src')).not.toContain('app.example.com');

  fireEvent.error(logo!);
  expect(document.querySelector('img')).toBeNull();
  expect(screen.getByText('C')).toBeInTheDocument();
});

test('first-party client interposes an account chooser — never auto-approves before an explicit Continue', async () => {
  // V4-P2b (owner directive 2026-07-07): the authorize page ALWAYS interposes
  // "Signed in as X — Continue / Use another account", INCLUDING first-party
  // clients. Android Custom Tabs share browser cookies, so a silent auto-approve
  // could sign the app in as whoever the browser is currently signed in as.
  vi.mocked(getAuthorizationDetails).mockResolvedValue({
    ...DETAILS,
    client: { ...DETAILS.client, name: 'BetterTrack Mobile', firstParty: true },
  });
  vi.mocked(approveAuthorization).mockResolvedValue(APPROVED);
  const user = userEvent.setup();
  renderConsent();

  // Branded as the official app; the scope-approval prompt is still skipped,
  // but the account confirmation is now the required click.
  expect(await screen.findByText('Official BetterTrack app')).toBeInTheDocument();
  expect(screen.getByText('Signed in as jane')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Use another account' })).toBeInTheDocument();
  // Scope prompt stays hidden for a first-party client (auto-approve).
  expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  // Give the previous auto-approve effect two microtask ticks to fire (it must
  // never fire in the new flow) before asserting approve was not called.
  await Promise.resolve();
  await Promise.resolve();
  expect(approveAuthorization).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(approveAuthorization).toHaveBeenCalledTimes(1));
  expect(approveAuthorization).toHaveBeenCalledWith(
    expect.objectContaining({ scope: 'portfolio:read market:read' }),
  );
  await waitFor(() => expect(window.location.href).toBe(APPROVED.redirectTo));
});

// The bearer scopes paranoid mode kills (#1063), pinned literally rather than
// derived from `isParanoidBlockedScope` so this stays a real assertion about the
// grant and not a restatement of the implementation. Mirrors the API's
// authoritative `portfolioApiScope` kill-registry entry
// (`apps/api/src/services/account/paranoidEnforcement.ts`) intersected with
// `API_KEY_SCOPES` — `tax:*`/`import:*` live in the registry but are not
// grantable scopes. `vault:sync` is deliberately absent: opaque ciphertext sync
// is the one capability that survives paranoid mode (#1043).
const PARANOID_UNAVAILABLE_SCOPES: readonly ApiKeyScope[] = [
  'portfolio:read',
  'portfolio:write',
  'cash:read',
  'cash:write',
  'mirrorchain:read',
  'mirrorchain:write',
];

test('paranoid first-party authorization drops the unavailable scopes and grants the mobile ceiling remainder', async () => {
  const mobileScopes = [...API_KEY_SCOPES];
  const allowedScopes = mobileScopes.filter(
    (scope) => !PARANOID_UNAVAILABLE_SCOPES.includes(scope),
  );
  const mobileQuery = new URLSearchParams(AUTHORIZE_QUERY);
  mobileQuery.set('scope', mobileScopes.join(' '));
  vi.mocked(getAuthorizationDetails).mockResolvedValue({
    ...DETAILS,
    client: { ...DETAILS.client, name: 'BetterTrack Mobile', firstParty: true },
    scopes: mobileScopes.map((scope) => ({ scope, label: scope })),
  });
  vi.mocked(approveAuthorization).mockResolvedValue(APPROVED);
  const user = userEvent.setup();

  renderConsent({
    path: `/oauth/authorize?${mobileQuery.toString()}`,
    privacyMode: 'paranoid',
  });

  expect(await screen.findByText('Official BetterTrack app')).toBeInTheDocument();
  expect(
    screen.getByText(
      'Portfolio access is unavailable while Paranoid mode is on. If requested, vault sync and other available permissions will still be granted.',
    ),
  ).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Continue' }));

  await waitFor(() => expect(approveAuthorization).toHaveBeenCalledTimes(1));
  expect(approveAuthorization).toHaveBeenCalledWith(
    expect.objectContaining({
      scope: allowedScopes.join(' '),
      state: 'opaque-state-xyz',
      code_challenge: 'a-pkce-code-challenge',
      code_challenge_method: 'S256',
    }),
  );
  const approvedParams = vi.mocked(approveAuthorization).mock.calls[0]?.[0];
  const grantedScopes = approvedParams?.scope.split(' ') ?? [];
  // The ciphertext-sync exception survives; every killed scope is gone. Asserted
  // per-scope so a registry addition that the consent screen forgets to drop
  // fails here by name rather than as an opaque joined-string diff.
  expect(grantedScopes).toContain('vault:sync');
  for (const scope of PARANOID_UNAVAILABLE_SCOPES) {
    expect(grantedScopes, scope).not.toContain(scope);
  }
  await waitFor(() => expect(window.location.href).toBe(APPROVED.redirectTo));
});

test('paranoid first-party authorization still refuses when no grantable scopes remain', async () => {
  const portfolioOnlyQuery = new URLSearchParams(AUTHORIZE_QUERY);
  portfolioOnlyQuery.set('scope', 'portfolio:read');
  vi.mocked(getAuthorizationDetails).mockResolvedValue({
    ...DETAILS,
    client: { ...DETAILS.client, name: 'BetterTrack Mobile', firstParty: true },
    scopes: DETAILS.scopes.filter(({ scope }) => scope === 'portfolio:read'),
  });

  renderConsent({
    path: `/oauth/authorize?${portfolioOnlyQuery.toString()}`,
    privacyMode: 'paranoid',
  });

  expect(await screen.findByText(/portfolio access.*unavailable/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
  expect(approveAuthorization).not.toHaveBeenCalled();
});

test('paranoid third-party authorization keeps the existing refusal policy', async () => {
  vi.mocked(getAuthorizationDetails).mockResolvedValue(DETAILS);

  renderConsent({ privacyMode: 'paranoid' });

  expect(await screen.findByText(/portfolio access.*unavailable/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  expect(approveAuthorization).not.toHaveBeenCalled();
});

test('Use another account signs the current session out and lands on the login screen carrying the untouched authorize URL', async () => {
  vi.mocked(getAuthorizationDetails).mockResolvedValue({
    ...DETAILS,
    client: { ...DETAILS.client, name: 'BetterTrack Mobile', firstParty: true },
  });
  vi.mocked(userApi.logout).mockResolvedValue(undefined);
  const user = userEvent.setup();
  renderConsent();

  await screen.findByText('Official BetterTrack app');
  await user.click(screen.getByRole('button', { name: 'Use another account' }));

  // The session gets torn down and the router lands on /login. The full
  // authorize URL (query included) travels as `state.from` so the #419 login
  // ladder can round-trip back here after re-authentication.
  await waitFor(() => expect(userApi.logout).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('Login page stub')).toBeInTheDocument();
  expect(approveAuthorization).not.toHaveBeenCalled();
});

test('cancelling sends the full request and navigates only to the server denial redirect', async () => {
  vi.mocked(getAuthorizationDetails).mockResolvedValue(DETAILS);
  vi.mocked(denyAuthorization).mockResolvedValue(DENIED);
  const user = userEvent.setup();
  renderConsent();

  await screen.findByText('Third-party app');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));

  await waitFor(() => expect(window.location.href).toBe(DENIED.redirectTo));
  expect(denyAuthorization).toHaveBeenCalledWith(
    expect.objectContaining({
      client_id: 'btc_charting_buddy',
      redirect_uri: 'https://app.example.com/cb',
      scope: 'portfolio:read market:read',
      state: 'opaque-state-xyz',
      code_challenge: 'a-pkce-code-challenge',
      code_challenge_method: 'S256',
    }),
  );
  expect(approveAuthorization).not.toHaveBeenCalled();
});

test('a rejected denial stays local and shows the no-access fallback', async () => {
  vi.mocked(getAuthorizationDetails).mockResolvedValue(DETAILS);
  vi.mocked(denyAuthorization).mockRejectedValue(
    new ApiError(400, 'INVALID_REDIRECT_URI', 'bad redirect'),
  );
  const user = userEvent.setup();
  renderConsent();

  await screen.findByText('Third-party app');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));

  expect(
    await screen.findByText(/could not safely return to the requesting app/i),
  ).toBeInTheDocument();
  expect(screen.getByText('Authorization cancelled')).toBeInTheDocument();
  expect(window.location.href).toBe('http://localhost/');
  expect(approveAuthorization).not.toHaveBeenCalled();
});

test('an invalid request (400 from the API) shows an error and never redirects', async () => {
  vi.mocked(getAuthorizationDetails).mockRejectedValue(
    new ApiError(400, 'INVALID_CLIENT', 'bad client'),
  );
  renderConsent();

  expect(await screen.findByText(/authorization request is invalid/i)).toBeInTheDocument();
  expect(window.location.href).toBe('http://localhost/');
});

test('an unauthenticated visit is redirected to login preserving the authorize query', async () => {
  // Anonymous: the bootstrap /auth/me rejects, so RequireUser bounces to /login
  // with the full /oauth/authorize?… URL stashed as the return path.
  vi.mocked(userApi.getMe).mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'nope'));
  vi.mocked(userApi.login).mockResolvedValue(meUser);
  vi.mocked(getAuthorizationDetails).mockResolvedValue(DETAILS);
  const user = userEvent.setup();

  render(
    <MemoryRouter initialEntries={[AUTHORIZE_PATH]}>
      <Routes>
        <Route path="/*" element={<UserApp />} />
      </Routes>
    </MemoryRouter>,
  );

  // Not the consent screen — the login screen, because we were anonymous.
  expect(
    await waitForColdStart(() => screen.getByText('Sign in to your account')),
  ).toBeInTheDocument();
  expect(screen.queryByText('Third-party app')).not.toBeInTheDocument();

  // Signing in returns us to the consent screen with the request intact — proven
  // by the details call carrying the original state + PKCE from the URL.
  await user.type(screen.getByLabelText('Email or username'), 'jane');
  await user.type(screen.getByLabelText('Password'), 'jane-strong-password-1');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));

  expect(await screen.findByText('Third-party app')).toBeInTheDocument();
  await waitFor(() =>
    expect(getAuthorizationDetails).toHaveBeenCalledWith(
      expect.objectContaining({
        client_id: 'btc_charting_buddy',
        state: 'opaque-state-xyz',
        code_challenge: 'a-pkce-code-challenge',
        code_challenge_method: 'S256',
      }),
      expect.anything(),
    ),
  );
});
