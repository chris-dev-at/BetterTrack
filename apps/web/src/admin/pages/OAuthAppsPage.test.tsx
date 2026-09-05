import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import type {
  CreateOAuthClientResponse,
  MeResponse,
  OAuthClientSummary,
} from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/adminApi';
import { I18nProvider, localizedMessage } from '../../i18n';
import { AuthProvider, useAuth } from '../AuthContext';
import { OAuthAppsPage } from './OAuthAppsPage';

const admin: MeResponse = {
  id: 'admin-1',
  email: 'admin@bettertrack.test',
  username: 'rootadmin',
  role: 'admin',
  status: 'active',
  mustChangePassword: false,
  pinEnabled: false,
  pinLockIdleMinutes: null,
  baseCurrency: 'EUR',
  locale: 'en',
  lastLoginAt: '2026-06-01T08:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const app: OAuthClientSummary = {
  id: '00000000-0000-0000-0000-0000000000bb',
  clientId: 'bt-admin-client',
  name: 'BetterTrack Mobile',
  redirectUris: ['https://app.bettertrack.test/callback'],
  scopes: ['portfolio:read'],
  public: false,
  firstParty: true,
  logoPath: null,
  createdAt: '2026-07-30T09:00:00.000Z',
};

const created: CreateOAuthClientResponse = {
  client: app,
  clientSecret: 'bt_admin_client_secret_once',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getMe).mockResolvedValue(admin);
  vi.mocked(api.getTwoFactorStatus).mockResolvedValue({
    setupRequired: false,
    totpEnabled: true,
    totpPending: false,
    emailEnabled: false,
    twoFactorEmail: null,
    recoveryCodesRemaining: 8,
  });
  vi.mocked(api.listFirstPartyApps).mockResolvedValue({ clients: [app] });
});

/** The console's auth status, so a sign-out on auth loss is observable. */
function AuthStatus() {
  const { status } = useAuth();
  return <span data-testid="status">{status}</span>;
}

function renderPage(locale: 'en' | 'de' = 'en') {
  return render(
    <I18nProvider initialLocale={locale}>
      <AuthProvider>
        <AuthStatus />
        <OAuthAppsPage />
      </AuthProvider>
    </I18nProvider>,
  );
}

test('requires a named confirmation before deleting an OAuth app', async () => {
  vi.mocked(api.deleteFirstPartyApp).mockResolvedValue(undefined);
  const user = userEvent.setup();
  renderPage();

  await screen.findByText(app.name);
  await user.click(screen.getByRole('button', { name: 'Delete' }));

  const dialog = await screen.findByRole('dialog', { name: 'Delete OAuth app?' });
  expect(dialog).toHaveTextContent('Delete “BetterTrack Mobile”?');
  expect(api.deleteFirstPartyApp).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(api.deleteFirstPartyApp).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Delete' }));
  await user.click(await screen.findByRole('button', { name: 'Delete app' }));

  await waitFor(() => expect(api.deleteFirstPartyApp).toHaveBeenCalledWith(app.id));
});

test('keeps a deletion failure visible in its confirmation dialog', async () => {
  vi.mocked(api.deleteFirstPartyApp).mockRejectedValue(
    new ApiError(409, 'oauth_client_has_grants', 'Revoke active grants before deleting this app.'),
  );
  const user = userEvent.setup();
  renderPage();

  await screen.findByText(app.name);
  await user.click(screen.getByRole('button', { name: 'Delete' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete OAuth app?' });
  const confirm = within(dialog).getByRole('button', { name: 'Delete app' });

  await user.click(confirm);

  // Catalog copy, not the server's envelope (#1814).
  const alert = await within(dialog).findByRole('alert');
  expect(alert).toHaveTextContent(localizedMessage('en', 'common.genericError'));
  expect(alert).not.toHaveTextContent('Revoke active grants before deleting this app.');
  expect(confirm).toBeEnabled();

  await user.click(confirm);
  await waitFor(() => expect(api.deleteFirstPartyApp).toHaveBeenCalledTimes(2));
});

test('keeps a one-time OAuth client secret open until it is acknowledged', async () => {
  vi.mocked(api.createFirstPartyApp).mockResolvedValue(created);
  const user = userEvent.setup();
  renderPage();

  await user.type(await screen.findByLabelText('App name'), app.name);
  await user.type(screen.getByLabelText('Redirect URI'), app.redirectUris[0]!);
  await user.click(screen.getByRole('checkbox', { name: /public client/i }));
  await user.click(screen.getByRole('button', { name: 'Register app' }));

  expect(await screen.findByText(created.clientSecret!)).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(screen.getByText(created.clientSecret!)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: "I've saved this" }));
  await waitFor(() => expect(screen.queryByText(created.clientSecret!)).not.toBeInTheDocument());
});

test('renders the extracted page copy in German', async () => {
  vi.mocked(api.listFirstPartyApps).mockResolvedValue({ clients: [] });

  renderPage('de');

  expect(await screen.findByRole('heading', { name: 'OAuth-Apps' })).toBeInTheDocument();
  expect(
    screen.getByText('Noch keine offiziellen Apps. Registriere oben die erste.'),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'App registrieren' })).toBeInTheDocument();
});

test('retries a failed app-list read', async () => {
  vi.mocked(api.listFirstPartyApps)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ clients: [] });
  const user = userEvent.setup();

  renderPage();

  await user.click(await screen.findByRole('button', { name: 'Try again' }));
  expect(
    await screen.findByText('No first-party apps yet. Register one above.'),
  ).toBeInTheDocument();
  expect(api.listFirstPartyApps).toHaveBeenCalledTimes(2);
});

test('a closed admin session window signs the console out instead of a create banner', async () => {
  const envelope = 'Not found';
  vi.mocked(api.createFirstPartyApp).mockRejectedValue(new ApiError(404, 'NOT_FOUND', envelope));
  const user = userEvent.setup();
  renderPage();

  await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
  await user.type(screen.getByLabelText('App name'), 'BetterTrack Desktop');
  await user.type(screen.getByLabelText('Redirect URI'), 'https://desktop.test/callback');
  await user.click(screen.getByRole('button', { name: 'Register app' }));

  await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
  expect(screen.queryByText(envelope)).not.toBeInTheDocument();
});
