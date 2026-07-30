import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { OAuthGrantListResponse } from '@bettertrack/contracts';

vi.mock('../../../lib/oauthApi', () => ({
  listOAuthClients: vi.fn(),
  createOAuthClient: vi.fn(),
  deleteOAuthClient: vi.fn(),
  listOAuthGrants: vi.fn(),
  revokeOAuthGrant: vi.fn(),
}));

import { listOAuthGrants, revokeOAuthGrant } from '../../../lib/oauthApi';
import { AuthorizedAppsPanel } from './AuthorizedAppsPanel';

const NO_GRANTS: OAuthGrantListResponse = { grants: [] };

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

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthorizedAppsPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // The grant list loads on mount — empty by default; tests override as needed.
  vi.mocked(listOAuthGrants).mockResolvedValue(NO_GRANTS);
});

describe('AuthorizedAppsPanel', () => {
  test('lists an authorized app in plain language and revokes it after confirmation', async () => {
    vi.mocked(listOAuthGrants).mockResolvedValue(ONE_GRANT);
    vi.mocked(revokeOAuthGrant).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPanel();

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
