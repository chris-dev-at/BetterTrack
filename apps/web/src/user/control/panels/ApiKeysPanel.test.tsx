import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { ApiKeyListResponse, CreateApiKeyResponse } from '@bettertrack/contracts';

vi.mock('../../../lib/apiKeysApi', () => ({
  listApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
}));

import { createApiKey, listApiKeys, revokeApiKey } from '../../../lib/apiKeysApi';
import { ResolvedPrivacyModeProvider } from '../../vault/usePrivacyMode';
import { ApiKeysPanel } from './ApiKeysPanel';

const EMPTY: ApiKeyListResponse = { keys: [] };

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

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ApiKeysPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ApiKeysPanel', () => {
  test('shows the empty state when no keys exist', async () => {
    vi.mocked(listApiKeys).mockResolvedValue(EMPTY);
    renderPanel();
    expect(await screen.findByText(/no api keys yet/i)).toBeInTheDocument();
  });

  test('retries a failed key-list read in place', async () => {
    vi.mocked(listApiKeys).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(EMPTY);
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByText(/no api keys yet/i)).toBeInTheDocument();
    expect(listApiKeys).toHaveBeenCalledTimes(2);
  });

  test('lists existing keys with their scopes', async () => {
    vi.mocked(listApiKeys).mockResolvedValue(ONE_KEY);
    renderPanel();
    expect(await screen.findByText('My script')).toBeInTheDocument();
    expect(screen.getByText('portfolio:read')).toBeInTheDocument();
    expect(screen.getByText(/never used/i)).toBeInTheDocument();
  });

  test('creates a key and shows the token exactly once', async () => {
    vi.mocked(listApiKeys).mockResolvedValue(EMPTY);
    vi.mocked(createApiKey).mockResolvedValue(CREATED);
    const user = userEvent.setup();
    renderPanel();

    await user.type(await screen.findByLabelText('Name'), 'New key');
    // V5-P0b: scope picker is per-module; the query stays scoped to THIS form.
    const createKeyForm = screen.getByRole('button', { name: 'Create key' }).closest('form')!;
    await user.click(within(createKeyForm).getByRole('checkbox', { name: /portfolio · read/i }));
    await user.click(screen.getByRole('button', { name: 'Create key' }));

    await waitFor(() =>
      expect(createApiKey).toHaveBeenCalledWith({ name: 'New key', scopes: ['portfolio:read'] }),
    );

    // The one-time token is revealed in the modal with a "won't be shown again" notice.
    expect(await screen.findByText(CREATED.token)).toBeInTheDocument();
    expect(screen.getByText(/won't be shown again/i)).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.getByText(CREATED.token)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: "I've saved this" }));
    await waitFor(() => expect(screen.queryByText(CREATED.token)).not.toBeInTheDocument());
  });

  test('blocks creation with no scope selected', async () => {
    vi.mocked(listApiKeys).mockResolvedValue(EMPTY);
    const user = userEvent.setup();
    renderPanel();

    await user.type(await screen.findByLabelText('Name'), 'No scopes');
    await user.click(screen.getByRole('button', { name: 'Create key' }));

    expect(await screen.findByText(/select at least one scope/i)).toBeInTheDocument();
    expect(createApiKey).not.toHaveBeenCalled();
  });

  test('V5-P0b: scope picker sections are collapsed by default (anti-bloat)', async () => {
    vi.mocked(listApiKeys).mockResolvedValue(EMPTY);
    const { container } = renderPanel();
    // The create-key form renders a native <details> scope picker that starts
    // closed, so the panel doesn't open on a wall of module ticks. (The sibling
    // assertion for the OAuth-app form lives in OAuthAppsPanel.test.tsx now that
    // registration is its own panel.)
    await screen.findByLabelText('Name');
    const detailsElements = container.querySelectorAll('details');
    expect(detailsElements.length).toBeGreaterThanOrEqual(1);
    detailsElements.forEach((d) => expect(d.open).toBe(false));
    // Header still shows a "None selected" affordance in the collapsed picker.
    expect(screen.getAllByText(/none selected/i).length).toBeGreaterThanOrEqual(1);
  });

  test('a paranoid account still sees a granted portfolio scope, marked inactive', async () => {
    vi.mocked(listApiKeys).mockResolvedValue(ONE_KEY);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    render(
      <QueryClientProvider client={client}>
        <ResolvedPrivacyModeProvider mode="paranoid">
          <ApiKeysPanel />
        </ResolvedPrivacyModeProvider>
      </QueryClientProvider>,
    );

    // The key really carries the scope — it only stops resolving while the
    // account is paranoid — so hiding the chip would understate the credential.
    expect(await screen.findByText('portfolio:read')).toBeInTheDocument();
    expect(screen.getByText(/inactive in Paranoid mode/i)).toBeInTheDocument();
    // New portfolio-scoped grants stay refused: the module is not offered.
    const createKeyForm = screen.getByRole('button', { name: 'Create key' }).closest('form')!;
    expect(
      within(createKeyForm).queryByRole('checkbox', { name: /portfolio · read/i }),
    ).not.toBeInTheDocument();
  });

  test('revokes a key after confirmation', async () => {
    vi.mocked(listApiKeys).mockResolvedValue(ONE_KEY);
    vi.mocked(revokeApiKey).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Revoke' }));
    await user.click(screen.getByRole('button', { name: 'Confirm revoke' }));

    await waitFor(() => expect(revokeApiKey).toHaveBeenCalledWith(ONE_KEY.keys[0]!.id));
  });
});
