import { render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import {
  NOTIFICATION_TYPES,
  type AccountDefaultsResponse,
  type MeResponse,
  type NotificationMatrix,
} from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { AuthProvider } from '../AuthContext';
import { AccountDefaultsPage } from './AccountDefaultsPage';

/**
 * The lean-default matrix every account starts with. Every cell ON here —
 * these tests care about column visibility, not the seed values.
 */
function makeMatrix(): NotificationMatrix {
  const routing = {
    inapp: true,
    email: true,
    telegram: true,
    discord: true,
    push: true,
    webpush: true,
  };
  return Object.fromEntries(
    NOTIFICATION_TYPES.map((type) => [type, { ...routing }]),
  ) as NotificationMatrix;
}

function makeDefaults(overrides: Partial<AccountDefaultsResponse> = {}): AccountDefaultsResponse {
  return {
    chatEnabled: true,
    defaultPortfolioVisibility: 'private',
    developerStatus: false,
    notificationMatrix: makeMatrix(),
    // V5-P0 kill-switch default: neither channel offered.
    channelsConfigurable: { telegram: false, discord: false },
    ...overrides,
  };
}

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
      <AccountDefaultsPage />
    </AuthProvider>,
  );
}

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
});

test('kill-switch OFF: hides the Telegram + Discord matrix columns', async () => {
  vi.mocked(api.getAccountDefaults).mockResolvedValue(makeDefaults());

  renderPage();

  // Wait for the always-visible In-app column header to prove the matrix rendered.
  expect(await screen.findByRole('columnheader', { name: 'In-app' })).toBeInTheDocument();

  // The V4-P10 additive channel headers must NOT render.
  expect(screen.queryByRole('columnheader', { name: 'Telegram' })).not.toBeInTheDocument();
  expect(screen.queryByRole('columnheader', { name: 'Discord' })).not.toBeInTheDocument();

  // No per-type cell checkbox exists for either channel either.
  expect(
    screen.queryByRole('checkbox', { name: /friend\.request · Telegram/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('checkbox', { name: /friend\.request · Discord/ }),
  ).not.toBeInTheDocument();
});

test('kill-switch ON: renders every matrix column', async () => {
  vi.mocked(api.getAccountDefaults).mockResolvedValue(
    makeDefaults({ channelsConfigurable: { telegram: true, discord: true } }),
  );

  renderPage();

  expect(await screen.findByRole('columnheader', { name: 'In-app' })).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: 'Telegram' })).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: 'Discord' })).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'friend.request · Telegram' })).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'friend.request · Discord' })).toBeInTheDocument();
});
