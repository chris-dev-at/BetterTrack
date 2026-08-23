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
import { I18nProvider } from '../../../i18n';
import { ResolvedPrivacyModeProvider } from '../../vault/usePrivacyMode';
import { AuthorizedAppsPanel } from './AuthorizedAppsPanel';

const NO_GRANTS: OAuthGrantListResponse = { grants: [] };

const ONE_GRANT: OAuthGrantListResponse = {
  grants: [
    {
      id: '00000000-0000-0000-0000-0000000000dd',
      clientId: 'btc_some_app',
      appName: 'Charting Buddy',
      firstParty: false,
      current: false,
      scopes: ['portfolio:read'],
      createdAt: '2026-07-01T08:00:00.000Z',
      lastUsedAt: null,
    },
  ],
};

const FEEDBACK_GRANT: OAuthGrantListResponse = {
  grants: [
    {
      ...ONE_GRANT.grants[0]!,
      scopes: ['feedback:write'],
    },
  ],
};

const FIRST_PARTY_GRANT: OAuthGrantListResponse = {
  grants: [
    {
      ...ONE_GRANT.grants[0]!,
      clientId: 'btc_bettertrack_mobile',
      appName: 'BetterTrackMobile',
      firstParty: true,
    },
  ],
};

function renderPanel(initialLocale = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={initialLocale}>
        <AuthorizedAppsPanel />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // The grant list loads on mount — empty by default; tests override as needed.
  vi.mocked(listOAuthGrants).mockResolvedValue(NO_GRANTS);
});

describe('AuthorizedAppsPanel', () => {
  test('retries a failed grant-list read in place', async () => {
    vi.mocked(listOAuthGrants)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(NO_GRANTS);
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByText(/no authorized apps/i)).toBeInTheDocument();
    expect(listOAuthGrants).toHaveBeenCalledTimes(2);
  });

  test('lists an authorized app in plain language and revokes it after confirmation', async () => {
    vi.mocked(listOAuthGrants).mockResolvedValue(ONE_GRANT);
    vi.mocked(revokeOAuthGrant).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPanel();

    const grantRow = (await screen.findByText('Charting Buddy')).closest('li')!;
    expect(grantRow).toHaveTextContent('Charting Buddy can:');
    // Scopes render via OAUTH_SCOPE_LABELS, not the raw scope string.
    expect(
      within(grantRow).getByText(/View your portfolios, holdings, transactions and cash balances/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Revoke access' }));
    await user.click(screen.getByRole('button', { name: 'Confirm revoke' }));

    await waitFor(() => expect(revokeOAuthGrant).toHaveBeenCalledWith(ONE_GRANT.grants[0]!.id));
  });

  test.each([
    [
      'en',
      'BetterTrack app',
      'can:',
      "Apps you've allowed to access your account. Revoking an app immediately kills its tokens — it must be re-authorized to regain access.",
    ],
    [
      'de',
      'BetterTrack-App',
      'kann:',
      'Apps, denen du Zugriff auf dein Konto erlaubt hast. Der Widerruf einer App macht ihre Tokens sofort ungültig — sie muss erneut autorisiert werden, um wieder Zugriff zu erhalten.',
    ],
  ])(
    'badges a first-party grant next to its name in %s',
    async (locale, badge, canAccess, description) => {
      vi.mocked(listOAuthGrants).mockResolvedValue(FIRST_PARTY_GRANT);
      renderPanel(locale);

      const grantRow = (await screen.findByText('BetterTrackMobile')).closest('li')!;
      const appName = within(grantRow).getByText('BetterTrackMobile');
      const firstPartyBadge = within(grantRow).getByText(badge);
      const accessLabel = within(grantRow).getByText(canAccess);

      expect(appName.nextElementSibling).toBe(firstPartyBadge);
      expect(firstPartyBadge.nextElementSibling).toBe(accessLabel);
      expect(screen.getByText(description)).toBeInTheDocument();
    },
  );

  test('localizes feedback grant copy from the stable scope id', async () => {
    vi.mocked(listOAuthGrants).mockResolvedValue(FEEDBACK_GRANT);
    renderPanel('de');

    expect(
      await screen.findByText(
        'Feedback, Funktionswünsche und Fehlerberichte in deinem Namen senden',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Send feedback, feature requests and bug reports on your behalf'),
    ).not.toBeInTheDocument();
  });

  test('marks a scope Paranoid mode refuses instead of hiding it from the grant', async () => {
    vi.mocked(listOAuthGrants).mockResolvedValue(ONE_GRANT);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    render(
      <QueryClientProvider client={client}>
        <ResolvedPrivacyModeProvider mode="paranoid">
          <AuthorizedAppsPanel />
        </ResolvedPrivacyModeProvider>
      </QueryClientProvider>,
    );

    // The grant really carries the scope — it only stops resolving while the
    // account is paranoid — so dropping the line would understate the access
    // the user granted, exactly as `ApiKeysPanel` argues for its chips.
    const grantRow = (await screen.findByText('Charting Buddy')).closest('li')!;
    expect(
      within(grantRow).getByText(/View your portfolios, holdings, transactions and cash balances/i),
    ).toBeInTheDocument();
    expect(within(grantRow).getByText(/inactive in Paranoid mode/i)).toBeInTheDocument();
  });
});
