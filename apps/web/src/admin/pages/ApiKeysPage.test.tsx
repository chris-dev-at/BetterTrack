import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import type { AdminApiKey, ApiKeyTier, MeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { I18nProvider } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
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

function renderPage(locale: 'en' | 'de' = 'en') {
  return render(
    <I18nProvider initialLocale={locale}>
      <AuthProvider>
        <ApiKeysPage />
      </AuthProvider>
    </I18nProvider>,
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

test('renders the extracted key-governance copy in German', async () => {
  renderPage('de');

  expect(await screen.findByRole('heading', { name: 'API-Schlüssel' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Limitstufen' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Stufe hinzufügen' })).toBeInTheDocument();
});

test('retries a failed tier-list read without hiding the key list', async () => {
  vi.mocked(api.listApiKeyTiers)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ tiers: [tier()] });
  const user = userEvent.setup();
  renderPage();

  expect(await screen.findByText('CI bot')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Try again' }));

  expect(await screen.findByText('120')).toBeInTheDocument();
  expect(api.listApiKeyTiers).toHaveBeenCalledTimes(2);
});

test('retries a failed key-list read without hiding the tier list', async () => {
  vi.mocked(api.listAdminApiKeys)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ keys: [key()] });
  const user = userEvent.setup();
  renderPage();

  expect(await screen.findByText('120')).toBeInTheDocument();
  const keysSection = screen.getByRole('heading', { level: 2, name: 'Keys' }).closest('section');
  expect(keysSection).not.toBeNull();
  await user.click(within(keysSection!).getByRole('button', { name: 'Try again' }));

  expect(await within(keysSection!).findByText('CI bot')).toBeInTheDocument();
  expect(api.listAdminApiKeys).toHaveBeenCalledTimes(2);
});

test('retries a failed per-key audit read', async () => {
  vi.mocked(api.getApiKeyAudit).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
    keyId: 'k-1',
    lastUsedAt: null,
    entries: [],
  });
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole('button', { name: 'View audit' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Try again' }));

  expect(await within(dialog).findByText('No recorded requests yet.')).toBeInTheDocument();
  expect(api.getApiKeyAudit).toHaveBeenCalledTimes(2);
});

test('localizes an API mutation failure instead of rendering the server message', async () => {
  vi.mocked(api.createApiKeyTier).mockRejectedValue(
    new ApiError(500, 'INTERNAL', 'The tier could not be created.'),
  );
  const user = userEvent.setup();
  renderPage('de');

  await user.type(await screen.findByLabelText('Name'), 'Langsam');
  await user.click(screen.getByRole('button', { name: 'Stufe hinzufügen' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Etwas ist schiefgelaufen. Bitte versuche es erneut.',
  );
  expect(screen.queryByText(/tier could not be created/i)).not.toBeInTheDocument();
});
