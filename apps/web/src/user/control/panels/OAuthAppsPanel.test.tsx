import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { CreateOAuthClientResponse, OAuthClientListResponse } from '@bettertrack/contracts';

vi.mock('../../../lib/oauthApi', () => ({
  listOAuthClients: vi.fn(),
  createOAuthClient: vi.fn(),
  deleteOAuthClient: vi.fn(),
  listOAuthGrants: vi.fn(),
  revokeOAuthGrant: vi.fn(),
}));

import { createOAuthClient, listOAuthClients } from '../../../lib/oauthApi';
import { OAuthAppsPanel } from './OAuthAppsPanel';

const NO_CLIENTS: OAuthClientListResponse = { clients: [] };

const CREATED_CLIENT: CreateOAuthClientResponse = {
  client: {
    id: '00000000-0000-0000-0000-0000000000cc',
    clientId: 'btc_public_client_id',
    name: 'My mobile app',
    redirectUris: ['https://example.com/callback'],
    scopes: ['portfolio:read'],
    public: false,
    firstParty: false,
    logoPath: null,
    createdAt: '2026-07-05T08:00:00.000Z',
  },
  clientSecret: 'bts_shown_once_client_secret',
};

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <OAuthAppsPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // The app list loads on mount — give it an empty default; individual tests
  // override as needed.
  vi.mocked(listOAuthClients).mockResolvedValue(NO_CLIENTS);
});

describe('OAuthAppsPanel', () => {
  test('registers an OAuth app and shows the one-time client secret', async () => {
    vi.mocked(createOAuthClient).mockResolvedValue(CREATED_CLIENT);
    const user = userEvent.setup();
    renderPanel();

    await user.type(await screen.findByLabelText('App name'), 'My mobile app');
    await user.type(screen.getByLabelText('Redirect URI 1'), 'https://example.com/callback');
    // V5-P0b: scope query stays scoped to the OAuth-app form.
    const registerForm = screen.getByRole('button', { name: 'Register app' }).closest('form')!;
    await user.click(within(registerForm).getByRole('checkbox', { name: /portfolio · read/i }));
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

  test('registering an OAuth app with a write scope auto-selects and stores its read (#371)', async () => {
    vi.mocked(createOAuthClient).mockResolvedValue(CREATED_CLIENT);
    const user = userEvent.setup();
    renderPanel();

    await user.type(await screen.findByLabelText('App name'), 'Writer app');
    await user.type(screen.getByLabelText('Redirect URI 1'), 'https://example.com/callback');
    // Tick Portfolio · Write in the register form — the implied read
    // auto-selects and locks per #371.
    const registerForm = screen.getByRole('button', { name: 'Register app' }).closest('form')!;
    await user.click(within(registerForm).getByRole('checkbox', { name: /portfolio · write/i }));
    const readCheckbox = within(registerForm).getByRole('checkbox', {
      name: /portfolio · read/i,
    });
    expect(readCheckbox).toBeChecked();
    expect(readCheckbox).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Register app' }));

    await waitFor(() =>
      expect(createOAuthClient).toHaveBeenCalledWith({
        name: 'Writer app',
        redirectUris: ['https://example.com/callback'],
        scopes: ['portfolio:read', 'portfolio:write'],
        public: false,
      }),
    );
  });

  test('V5-P0b: scope picker sections are collapsed by default (anti-bloat)', async () => {
    const { container } = renderPanel();
    // The register-app form renders a native <details> scope picker that starts
    // closed, so registering an app doesn't scroll past every module tick to
    // reach the redirect-URI or public-client fields. (The sibling assertion for
    // the create-key form lives in ApiKeysPanel.test.tsx.)
    await screen.findByLabelText('App name');
    const detailsElements = container.querySelectorAll('details');
    expect(detailsElements.length).toBeGreaterThanOrEqual(1);
    detailsElements.forEach((d) => expect(d.open).toBe(false));
    // Header still shows a "None selected" affordance in the collapsed picker.
    expect(screen.getAllByText(/none selected/i).length).toBeGreaterThanOrEqual(1);
  });
});
