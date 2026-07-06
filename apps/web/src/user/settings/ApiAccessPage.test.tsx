import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  ApiKeyListResponse,
  CreateApiKeyResponse,
  CreateOAuthClientResponse,
  OAuthClientListResponse,
  OAuthGrantListResponse,
} from '@bettertrack/contracts';

vi.mock('../../lib/apiKeysApi', () => ({
  listApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
}));

vi.mock('../../lib/oauthApi', () => ({
  listOAuthClients: vi.fn(),
  createOAuthClient: vi.fn(),
  deleteOAuthClient: vi.fn(),
  listOAuthGrants: vi.fn(),
  revokeOAuthGrant: vi.fn(),
}));

import { createApiKey, listApiKeys, revokeApiKey } from '../../lib/apiKeysApi';
import {
  createOAuthClient,
  listOAuthClients,
  listOAuthGrants,
  revokeOAuthGrant,
} from '../../lib/oauthApi';
import { ApiAccessPage } from './ApiAccessPage';

const EMPTY: ApiKeyListResponse = { keys: [] };

const NO_CLIENTS: OAuthClientListResponse = { clients: [] };
const NO_GRANTS: OAuthGrantListResponse = { grants: [] };

const CREATED_CLIENT: CreateOAuthClientResponse = {
  client: {
    id: '00000000-0000-0000-0000-0000000000cc',
    clientId: 'btc_public_client_id',
    name: 'My mobile app',
    redirectUris: ['https://example.com/callback'],
    scopes: ['portfolio:read'],
    public: false,
    firstParty: false,
    logoUrl: null,
    createdAt: '2026-07-05T08:00:00.000Z',
  },
  clientSecret: 'bts_shown_once_client_secret',
};

const ONE_GRANT: OAuthGrantListResponse = {
  grants: [
    {
      id: '00000000-0000-0000-0000-0000000000dd',
      clientId: 'btc_some_app',
      appName: 'Charting Buddy',
      scopes: ['portfolio:read'],
      createdAt: '2026-07-01T08:00:00.000Z',
      lastUsedAt: null,
    },
  ],
};

const ONE_KEY: ApiKeyListResponse = {
  keys: [
    {
      id: '00000000-0000-0000-0000-0000000000aa',
      name: 'My script',
      scopes: ['portfolio:read'],
      createdAt: '2026-07-01T08:00:00.000Z',
      lastUsedAt: null,
    },
  ],
};

const CREATED: CreateApiKeyResponse = {
  key: {
    id: '00000000-0000-0000-0000-0000000000bb',
    name: 'New key',
    scopes: ['portfolio:read'],
    createdAt: '2026-07-05T08:00:00.000Z',
    lastUsedAt: null,
  },
  token: 'btk_shown_once_secret_token',
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ApiAccessPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // The OAuth sections load on mount — give them empty defaults so the personal-
  // key tests aren't affected. Individual OAuth tests override as needed.
  vi.mocked(listOAuthClients).mockResolvedValue(NO_CLIENTS);
  vi.mocked(listOAuthGrants).mockResolvedValue(NO_GRANTS);
});

describe('ApiAccessPage', () => {
  test('shows the empty state when no keys exist', async () => {
    vi.mocked(listApiKeys).mockResolvedValue(EMPTY);
    renderPage();
    expect(await screen.findByText(/no api keys yet/i)).toBeInTheDocument();
  });

  test('lists existing keys with their scopes', async () => {
    vi.mocked(listApiKeys).mockResolvedValue(ONE_KEY);
    renderPage();
    expect(await screen.findByText('My script')).toBeInTheDocument();
    expect(screen.getByText('portfolio:read')).toBeInTheDocument();
    expect(screen.getByText(/never used/i)).toBeInTheDocument();
  });

  test('creates a key and shows the token exactly once', async () => {
    vi.mocked(listApiKeys).mockResolvedValue(EMPTY);
    vi.mocked(createApiKey).mockResolvedValue(CREATED);
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('Name'), 'New key');
    await user.click(screen.getByRole('checkbox', { name: /portfolio · read/i }));
    await user.click(screen.getByRole('button', { name: 'Create key' }));

    await waitFor(() =>
      expect(createApiKey).toHaveBeenCalledWith({ name: 'New key', scopes: ['portfolio:read'] }),
    );

    // The one-time token is revealed in the modal with a "won't be shown again" notice.
    expect(await screen.findByText(CREATED.token)).toBeInTheDocument();
    expect(screen.getByText(/won't be shown again/i)).toBeInTheDocument();
  });

  test('blocks creation with no scope selected', async () => {
    vi.mocked(listApiKeys).mockResolvedValue(EMPTY);
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('Name'), 'No scopes');
    await user.click(screen.getByRole('button', { name: 'Create key' }));

    expect(await screen.findByText(/select at least one scope/i)).toBeInTheDocument();
    expect(createApiKey).not.toHaveBeenCalled();
  });

  test('revokes a key after confirmation', async () => {
    vi.mocked(listApiKeys).mockResolvedValue(ONE_KEY);
    vi.mocked(revokeApiKey).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Revoke' }));
    await user.click(screen.getByRole('button', { name: 'Confirm revoke' }));

    await waitFor(() => expect(revokeApiKey).toHaveBeenCalledWith(ONE_KEY.keys[0]!.id));
  });

  test('registers an OAuth app and shows the one-time client secret', async () => {
    vi.mocked(listApiKeys).mockResolvedValue(EMPTY);
    vi.mocked(createOAuthClient).mockResolvedValue(CREATED_CLIENT);
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('App name'), 'My mobile app');
    await user.type(screen.getByLabelText('Redirect URI 1'), 'https://example.com/callback');
    // The OAuth scope checkbox is named by the plain-language label + scope token.
    await user.click(
      screen.getByRole('checkbox', {
        name: /view your portfolios, holdings, transactions and cash balances/i,
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Register app' }));

    await waitFor(() =>
      expect(createOAuthClient).toHaveBeenCalledWith({
        name: 'My mobile app',
        redirectUris: ['https://example.com/callback'],
        scopes: ['portfolio:read'],
        public: false,
      }),
    );

    // The one-time secret + the non-secret client id are revealed once.
    expect(await screen.findByText(CREATED_CLIENT.clientSecret!)).toBeInTheDocument();
    expect(screen.getByText(CREATED_CLIENT.client.clientId)).toBeInTheDocument();
    expect(screen.getByText(/won't be shown again/i)).toBeInTheDocument();
  });

  test('lists an authorized app in plain language and revokes it after confirmation', async () => {
    vi.mocked(listApiKeys).mockResolvedValue(EMPTY);
    vi.mocked(listOAuthGrants).mockResolvedValue(ONE_GRANT);
    vi.mocked(revokeOAuthGrant).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    const grantRow = (await screen.findByText('Charting Buddy can:')).closest('li')!;
    // Scopes render via OAUTH_SCOPE_LABELS, not the raw scope string.
    expect(
      within(grantRow).getByText(/View your portfolios, holdings, transactions and cash balances/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Revoke access' }));
    await user.click(screen.getByRole('button', { name: 'Confirm revoke' }));

    await waitFor(() => expect(revokeOAuthGrant).toHaveBeenCalledWith(ONE_GRANT.grants[0]!.id));
  });
});
