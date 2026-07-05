import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { ApiKeyListResponse, CreateApiKeyResponse } from '@bettertrack/contracts';

vi.mock('../../lib/apiKeysApi', () => ({
  listApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
}));

import { createApiKey, listApiKeys, revokeApiKey } from '../../lib/apiKeysApi';
import { ApiAccessPage } from './ApiAccessPage';

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
});
