import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type {
  MeResponse,
  OAuthApproveResponse,
  OAuthAuthorizationDetailsResponse,
} from '@bettertrack/contracts';

vi.mock('../../lib/oauthApi', () => ({
  getAuthorizationDetails: vi.fn(),
  approveAuthorization: vi.fn(),
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

import { ApiError } from '../../lib/apiClient';
import { approveAuthorization, getAuthorizationDetails } from '../../lib/oauthApi';
import * as userApi from '../../lib/userApi';
import { UserApp } from '../UserApp';
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
  client: { clientId: 'btc_charting_buddy', name: 'Charting Buddy' },
  scopes: [
    {
      scope: 'portfolio:read',
      label: 'View your portfolios, holdings, transactions and cash balances',
    },
    { scope: 'market:read', label: 'Search assets and read market data' },
  ],
  redirectUri: 'https://app.example.com/cb',
  state: 'opaque-state-xyz',
};

const APPROVED: OAuthApproveResponse = {
  redirectTo: 'https://app.example.com/cb?code=one-time-code&state=opaque-state-xyz',
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
});
afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

/** Render just the consent screen for an already-authenticated user. */
function renderConsent() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[AUTHORIZE_PATH]}>
        <Routes>
          <Route path="/oauth/authorize" element={<ConsentPage />} />
          <Route path="/" element={<div>Home</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test('renders the requested scopes in plain language and approving navigates to redirectTo', async () => {
  vi.mocked(getAuthorizationDetails).mockResolvedValue(DETAILS);
  vi.mocked(approveAuthorization).mockResolvedValue(APPROVED);
  const user = userEvent.setup();
  renderConsent();

  // App name + plain-language scopes (not the raw scope tokens).
  expect(await screen.findByText('Authorize Charting Buddy')).toBeInTheDocument();
  expect(
    screen.getByText('View your portfolios, holdings, transactions and cash balances'),
  ).toBeInTheDocument();
  expect(screen.getByText('Search assets and read market data')).toBeInTheDocument();

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

test('cancelling does not issue a code or navigate to the redirect URI', async () => {
  vi.mocked(getAuthorizationDetails).mockResolvedValue(DETAILS);
  const user = userEvent.setup();
  renderConsent();

  await screen.findByText('Authorize Charting Buddy');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));

  expect(await screen.findByText('Authorization cancelled')).toBeInTheDocument();
  expect(approveAuthorization).not.toHaveBeenCalled();
  expect(window.location.href).toBe('http://localhost/');
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
  expect(await screen.findByText('Sign in to your account')).toBeInTheDocument();
  expect(screen.queryByText('Authorize Charting Buddy')).not.toBeInTheDocument();

  // Signing in returns us to the consent screen with the request intact — proven
  // by the details call carrying the original state + PKCE from the URL.
  await user.type(screen.getByLabelText('Email or username'), 'jane');
  await user.type(screen.getByLabelText('Password'), 'jane-strong-password-1');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));

  expect(await screen.findByText('Authorize Charting Buddy')).toBeInTheDocument();
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
