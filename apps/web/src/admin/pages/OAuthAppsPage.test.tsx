import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import type {
  CreateOAuthClientResponse,
  MeResponse,
  OAuthClientSummary,
} from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { AuthProvider } from '../AuthContext';
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

function renderPage() {
  return render(
    <AuthProvider>
      <OAuthAppsPage />
    </AuthProvider>,
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
