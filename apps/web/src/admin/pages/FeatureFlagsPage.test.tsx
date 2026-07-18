import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import type {
  AdminFeatureFlag,
  AdminFeatureFlagsResponse,
  MeResponse,
} from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { AuthProvider } from '../AuthContext';
import { FeatureFlagsPage } from './FeatureFlagsPage';

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

const flag = (key: AdminFeatureFlag['key'], enabled: boolean): AdminFeatureFlag => ({
  key,
  enabled,
  description: `${key} desc`,
  updatedAt: null,
  updatedBy: null,
});

const list: AdminFeatureFlagsResponse = {
  flags: [
    flag('realtime', true),
    flag('liveMode', true),
    flag('chat', true),
    flag('alerts', true),
    flag('imports', true),
    flag('ai', true),
  ],
};

function renderPage() {
  return render(
    <AuthProvider>
      <FeatureFlagsPage />
    </AuthProvider>,
  );
}

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
  vi.mocked(api.getFeatureFlags).mockResolvedValue(list);
});

test('lists every localized flag with its On state', async () => {
  renderPage();

  await waitFor(() => expect(screen.getByText('Chat')).toBeInTheDocument());
  expect(screen.getByText('Realtime')).toBeInTheDocument();
  expect(screen.getByText('Live Mode')).toBeInTheDocument();
  expect(screen.getByText('Price alerts')).toBeInTheDocument();
  expect(screen.getByText('Imports')).toBeInTheDocument();
  expect(screen.getByText('AI')).toBeInTheDocument();
  expect(screen.getAllByText('On').length).toBe(6);
});

test('toggling a flag OFF calls the API with the flipped value', async () => {
  const user = userEvent.setup();
  vi.mocked(api.setFeatureFlag).mockResolvedValue({
    flags: list.flags.map((f) => (f.key === 'chat' ? { ...f, enabled: false } : f)),
  });
  renderPage();

  await waitFor(() => expect(screen.getByText('Chat')).toBeInTheDocument());
  const chatRow = screen.getByText('Chat').closest('tr')!;
  await user.click(within(chatRow).getByRole('button', { name: 'Disable' }));

  await waitFor(() => expect(api.setFeatureFlag).toHaveBeenCalledWith('chat', false));
});

test('shows an error state when the fetch fails', async () => {
  vi.mocked(api.getFeatureFlags).mockRejectedValue(new Error('boom'));
  renderPage();

  await waitFor(() =>
    expect(screen.getByText('Could not load feature flags.')).toBeInTheDocument(),
  );
});
