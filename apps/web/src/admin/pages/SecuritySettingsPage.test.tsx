import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import type { AdminTwoFactorStatusResponse, MeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { AuthProvider } from '../AuthContext';
import { SecuritySettingsPage } from './SecuritySettingsPage';

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

const status: AdminTwoFactorStatusResponse = {
  setupRequired: false,
  totpEnabled: true,
  totpPending: false,
  emailEnabled: false,
  twoFactorEmail: null,
  recoveryCodesRemaining: 8,
};

function renderPage() {
  return render(
    <AuthProvider>
      <SecuritySettingsPage />
    </AuthProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getMe).mockResolvedValue(admin);
  vi.mocked(api.getTwoFactorStatus).mockResolvedValue(status);
});

test('renders the current 2FA status: methods, 2FA email and recovery-code count', async () => {
  renderPage();

  // Authenticator on, email off with no address, recovery codes reflected.
  expect(await screen.findByText('Authenticator app is on.')).toBeInTheDocument();
  expect(screen.getByText('No two-factor email set yet.')).toBeInTheDocument();
  expect(screen.getByText('8 recovery codes remaining.')).toBeInTheDocument();

  // The management actions reflect the current state.
  expect(screen.getByRole('button', { name: 'Re-enroll authenticator' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Set up email codes' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Regenerate recovery codes' })).toBeInTheDocument();
});

test('re-enrolls TOTP: disables with a current code, then confirms a fresh secret', async () => {
  const user = userEvent.setup();
  vi.mocked(api.disableTotp).mockResolvedValue();
  vi.mocked(api.enrollTotp).mockResolvedValue({
    otpauthUri: 'otpauth://totp/BetterTrack:root?secret=NEWSECRET',
    secret: 'NEWSECRET',
  });
  // A later method (email still on) → no fresh recovery codes on re-enroll.
  vi.mocked(api.confirmTotp).mockResolvedValue({ recoveryCodes: null });

  renderPage();

  // Start the re-enroll: the disable-with-code step comes first (§400).
  await user.click(await screen.findByRole('button', { name: 'Re-enroll authenticator' }));
  const disableCode = await screen.findByLabelText('Current authenticator code or recovery code');
  await user.type(disableCode, '111111');
  await user.click(screen.getByRole('button', { name: 'Turn off & re-enroll' }));

  // Disable fired with the entered code, then a fresh secret is fetched to enroll.
  await waitFor(() => expect(api.disableTotp).toHaveBeenCalledWith({ code: '111111' }));
  expect(api.enrollTotp).toHaveBeenCalledTimes(1);

  // Confirm the new secret with a live code.
  const confirmCode = await screen.findByLabelText('Confirmation code');
  await user.type(confirmCode, '654321');
  await user.click(screen.getByRole('button', { name: 'Confirm & enable' }));

  await waitFor(() => expect(api.confirmTotp).toHaveBeenCalledWith({ code: '654321' }));
  expect(await screen.findByText('Authenticator app enabled.')).toBeInTheDocument();
});

test('regenerating recovery codes shows the fresh set exactly once', async () => {
  const user = userEvent.setup();
  vi.mocked(api.regenerateRecoveryCodes).mockResolvedValue({
    recoveryCodes: ['aaaa-1111', 'bbbb-2222', 'cccc-3333'],
  });

  renderPage();

  await user.click(await screen.findByRole('button', { name: 'Regenerate recovery codes' }));

  // The one-time panel appears with the fresh codes and a save affordance.
  expect(await screen.findByText('aaaa-1111')).toBeInTheDocument();
  expect(screen.getByText('cccc-3333')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: "I've saved these codes" })).toBeInTheDocument();
});
