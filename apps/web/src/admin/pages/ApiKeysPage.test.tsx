import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import type { AdminApiKey, ApiKeyTier, MeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { AuthProvider } from '../AuthContext';
import { ApiKeysPage } from './ApiKeysPage';

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

function renderPage() {
  return render(
    <AuthProvider>
      <ApiKeysPage />
    </AuthProvider>,
  );
}

const tier = (over: Partial<ApiKeyTier> = {}): ApiKeyTier => ({
  id: 't-default',
  name: 'Default',
  requestLimit: 120,
  windowSec: 60,
  isDefault: true,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  ...over,
});

const key = (over: Partial<AdminApiKey> = {}): AdminApiKey => ({
  id: 'k-1',
  userId: 'user-1',
  name: 'CI bot',
  tierId: null,
  tierName: null,
  lastUsedAt: '2026-07-20T00:00:00.000Z',
  createdAt: '2026-07-01T00:00:00.000Z',
  revokedAt: null,
  ...over,
});

beforeEach(() => {
  vi.mocked(api.getMe).mockResolvedValue(admin);
  vi.mocked(api.getTwoFactorStatus).mockResolvedValue({
    setupRequired: false,
    totpEnabled: true,
    totpPending: false,
    emailEnabled: false,
    twoFactorEmail: null,
    recoveryCodesRemaining: 8,
  });
  vi.mocked(api.listApiKeyTiers).mockResolvedValue({
    tiers: [tier(), tier({ id: 't-pro', name: 'Pro', requestLimit: 600, isDefault: false })],
  });
  vi.mocked(api.listAdminApiKeys).mockResolvedValue({ keys: [key()] });
  vi.mocked(api.getApiKeyAudit).mockResolvedValue({
    keyId: 'k-1',
    lastUsedAt: '2026-07-20T00:00:00.000Z',
    entries: [
      {
        id: 'e-1',
        method: 'GET',
        path: '/portfolios',
        status: 200,
        createdAt: '2026-07-20T00:00:00.000Z',
      },
    ],
  });
});

test('renders tiers and keys, and creates a tier', async () => {
  vi.mocked(api.createApiKeyTier).mockResolvedValue(
    tier({ id: 't-new', name: 'Slow', requestLimit: 10, isDefault: false }),
  );
  renderPage();

  // 600 is the Pro tier's limit — unique to the tiers table (the tier name also
  // appears as a <option> in each key's select, so assert on the limit instead).
  await waitFor(() => expect(screen.getByText('600')).toBeInTheDocument());
  expect(screen.getByText('CI bot')).toBeInTheDocument();

  await userEvent.type(screen.getByLabelText('Name'), 'Slow');
  await userEvent.clear(screen.getByLabelText('Limit'));
  await userEvent.type(screen.getByLabelText('Limit'), '10');
  await userEvent.click(screen.getByRole('button', { name: 'Add tier' }));

  await waitFor(() =>
    expect(vi.mocked(api.createApiKeyTier)).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Slow', requestLimit: 10, windowSec: 60 }),
    ),
  );
});

test('assigns a tier to a key', async () => {
  vi.mocked(api.assignApiKeyTier).mockResolvedValue(key({ tierId: 't-pro', tierName: 'Pro' }));
  renderPage();

  const select = await screen.findByLabelText('Tier for CI bot');
  await userEvent.selectOptions(select, 't-pro');

  await waitFor(() => expect(vi.mocked(api.assignApiKeyTier)).toHaveBeenCalledWith('k-1', 't-pro'));
});

test('opens the per-key audit log', async () => {
  renderPage();

  await userEvent.click(await screen.findByRole('button', { name: 'View audit' }));

  await waitFor(() =>
    expect(vi.mocked(api.getApiKeyAudit)).toHaveBeenCalledWith('k-1', expect.anything()),
  );
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('/portfolios')).toBeInTheDocument();
});
