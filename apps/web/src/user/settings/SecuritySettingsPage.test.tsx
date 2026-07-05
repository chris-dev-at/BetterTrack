import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  MeResponse,
  SessionInfoResponse,
  TwoFactorStatusResponse,
} from '@bettertrack/contracts';

vi.mock('../../lib/userApi', () => ({
  getMe: vi.fn(),
  getSession: vi.fn(),
  setPin: vi.fn(),
  disablePin: vi.fn(),
  setPinLockIdleMinutes: vi.fn(),
}));

vi.mock('../../lib/twoFactorApi', () => ({
  getTwoFactorStatus: vi.fn(),
  enrollTwoFactor: vi.fn(),
  confirmTwoFactor: vi.fn(),
  disableTwoFactor: vi.fn(),
  regenerateRecoveryCodes: vi.fn(),
}));

import {
  confirmTwoFactor,
  disableTwoFactor,
  enrollTwoFactor,
  getTwoFactorStatus,
  regenerateRecoveryCodes,
} from '../../lib/twoFactorApi';
import { disablePin, getMe, getSession, setPin, setPinLockIdleMinutes } from '../../lib/userApi';
import { SecuritySettingsPage } from './SecuritySettingsPage';

const SESSION: SessionInfoResponse = {
  signedInAt: '2026-06-01T08:00:00.000Z',
  renewedAt: '2026-07-01T08:00:00.000Z',
  expiresAt: '2026-07-31T08:00:00.000Z',
};

function makeTwoFactorStatus(
  overrides: Partial<TwoFactorStatusResponse> = {},
): TwoFactorStatusResponse {
  return { enabled: false, pending: false, recoveryCodesRemaining: 0, ...overrides };
}

function makeMe(pinEnabled: boolean): MeResponse {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'ada@example.com',
    username: 'ada',
    role: 'user',
    status: 'active',
    mustChangePassword: false,
    pinEnabled,
    pinLockIdleMinutes: null,
    baseCurrency: 'EUR',
    lastLoginAt: '2026-07-01T08:00:00.000Z',
    createdAt: '2026-01-15T09:00:00.000Z',
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <SecuritySettingsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION);
  vi.mocked(setPin).mockResolvedValue(makeMe(true));
  vi.mocked(disablePin).mockResolvedValue(makeMe(false));
  vi.mocked(setPinLockIdleMinutes).mockResolvedValue(makeMe(true));
  vi.mocked(getTwoFactorStatus).mockResolvedValue(makeTwoFactorStatus());
});

describe('SecuritySettingsPage', () => {
  test('renders session info', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    renderPage();

    expect(await screen.findByText(/signed in since/i)).toBeInTheDocument();
    expect(screen.getByText(/expires after 30 days of inactivity/i)).toBeInTheDocument();
  });

  test('enables a PIN when none is set', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('PIN'), '1234');
    await user.type(screen.getByLabelText('Confirm PIN'), '1234');
    await user.click(screen.getByRole('button', { name: 'Enable PIN' }));

    await waitFor(() => expect(setPin).toHaveBeenCalledWith({ pin: '1234' }));
  });

  test('rejects a mismatched PIN confirmation', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('PIN'), '1234');
    await user.type(screen.getByLabelText('Confirm PIN'), '5678');
    await user.click(screen.getByRole('button', { name: 'Enable PIN' }));

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(setPin).not.toHaveBeenCalled();
  });

  test('changes and disables an existing PIN', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(true));
    const user = userEvent.setup();
    renderPage();

    // Change flow reveals the PIN form and submits via setPin.
    await user.click(await screen.findByRole('button', { name: 'Change PIN' }));
    await user.type(screen.getByLabelText('PIN'), '9999');
    await user.type(screen.getByLabelText('Confirm PIN'), '9999');
    await user.click(screen.getByRole('button', { name: 'Save new PIN' }));

    await waitFor(() => expect(setPin).toHaveBeenCalledWith({ pin: '9999' }));

    // Disable calls disablePin.
    await user.click(await screen.findByRole('button', { name: 'Disable PIN' }));
    await waitFor(() => expect(disablePin).toHaveBeenCalled());
  });

  test('the unlock-window control only shows once a PIN is enabled (#288)', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    renderPage();

    // With no PIN, the enable form is up but no window picker.
    expect(await screen.findByRole('button', { name: 'Enable PIN' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Unlock window')).not.toBeInTheDocument();
  });

  test('the unlock window defaults to 10 minutes when unset (#288)', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(true)); // pinLockIdleMinutes: null → default
    renderPage();

    const select = (await screen.findByLabelText('Unlock window')) as HTMLSelectElement;
    expect(select.value).toBe('10');
  });

  test('changing the unlock window persists the new value (#288)', async () => {
    vi.mocked(getMe).mockResolvedValue({ ...makeMe(true), pinLockIdleMinutes: 5 });
    vi.mocked(setPinLockIdleMinutes).mockResolvedValue({
      ...makeMe(true),
      pinLockIdleMinutes: 30,
    });
    const user = userEvent.setup();
    renderPage();

    const select = (await screen.findByLabelText('Unlock window')) as HTMLSelectElement;
    expect(select.value).toBe('5');
    await user.selectOptions(select, '30');

    await waitFor(() => expect(setPinLockIdleMinutes).toHaveBeenCalledWith({ idleMinutes: 30 }));
  });
});

describe('SecuritySettingsPage — two-factor authentication', () => {
  test('shows the disabled status with a way to start enrollment', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    vi.mocked(getTwoFactorStatus).mockResolvedValue(makeTwoFactorStatus({ enabled: false }));
    renderPage();

    expect(
      await screen.findByRole('heading', { name: 'Two-factor authentication' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Set up two-factor authentication' }),
    ).toBeInTheDocument();
  });

  test('shows the enabled status with regenerate and disable actions', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    vi.mocked(getTwoFactorStatus).mockResolvedValue(
      makeTwoFactorStatus({ enabled: true, recoveryCodesRemaining: 3 }),
    );
    renderPage();

    expect(await screen.findByText(/enabled — 3 recovery codes remaining/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regenerate recovery codes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disable 2FA' })).toBeInTheDocument();
  });

  test('enroll wizard: confirms a code and shows the recovery codes once', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    vi.mocked(getTwoFactorStatus).mockResolvedValue(makeTwoFactorStatus({ enabled: false }));
    vi.mocked(enrollTwoFactor).mockResolvedValue({
      otpauthUri: 'otpauth://totp/BetterTrack:ada%40example.com?secret=ABCDEFGHIJKLMNOP',
      secret: 'ABCDEFGHIJKLMNOP',
    });
    vi.mocked(confirmTwoFactor).mockResolvedValue({
      recoveryCodes: ['aaaa-bbbb-cccc-dddd', 'eeee-ffff-gggg-hhhh'],
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Set up two-factor authentication' }),
    );

    expect(await screen.findByText('ABCDEFGHIJKLMNOP')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Confirmation code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirm & enable' }));

    await waitFor(() => expect(confirmTwoFactor).toHaveBeenCalledWith({ code: '123456' }));

    expect(await screen.findByText('aaaa-bbbb-cccc-dddd')).toBeInTheDocument();
    expect(screen.getByText('eeee-ffff-gggg-hhhh')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: "I've saved these codes" }));

    expect(
      await screen.findByRole('button', { name: 'Set up two-factor authentication' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(getTwoFactorStatus).toHaveBeenCalledTimes(2));
  });

  test('regenerates recovery codes when already enabled', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    vi.mocked(getTwoFactorStatus).mockResolvedValue(
      makeTwoFactorStatus({ enabled: true, recoveryCodesRemaining: 3 }),
    );
    vi.mocked(regenerateRecoveryCodes).mockResolvedValue({
      recoveryCodes: ['zzzz-yyyy-xxxx-wwww'],
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Regenerate recovery codes' }));

    await waitFor(() => expect(regenerateRecoveryCodes).toHaveBeenCalled());
    expect(await screen.findByText('zzzz-yyyy-xxxx-wwww')).toBeInTheDocument();
  });

  test('disables 2FA with a code', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    vi.mocked(getTwoFactorStatus).mockResolvedValue(
      makeTwoFactorStatus({ enabled: true, recoveryCodesRemaining: 5 }),
    );
    vi.mocked(disableTwoFactor).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Disable 2FA' }));
    await user.type(
      screen.getByLabelText(/authenticator code or recovery code/i),
      'abcd-efgh-ijkl-mnop',
    );
    await user.click(screen.getByRole('button', { name: 'Disable 2FA' }));

    await waitFor(() =>
      expect(disableTwoFactor).toHaveBeenCalledWith({ code: 'abcd-efgh-ijkl-mnop' }),
    );
    expect(
      await screen.findByText(/two-factor authentication has been turned off/i),
    ).toBeInTheDocument();
  });
});
