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
  enrollEmailTwoFactor: vi.fn(),
  confirmEmailTwoFactor: vi.fn(),
  disableEmailTwoFactor: vi.fn(),
  regenerateRecoveryCodes: vi.fn(),
}));

import { ApiError } from '../../lib/apiClient';
import {
  confirmEmailTwoFactor,
  confirmTwoFactor,
  disableEmailTwoFactor,
  disableTwoFactor,
  enrollEmailTwoFactor,
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
  return {
    totpEnabled: false,
    totpPending: false,
    emailEnabled: false,
    recoveryCodesRemaining: 0,
    ...overrides,
  };
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
  vi.mocked(enrollEmailTwoFactor).mockResolvedValue(undefined);
  vi.mocked(disableEmailTwoFactor).mockResolvedValue(undefined);
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

describe('SecuritySettingsPage — two-factor authentication (#298)', () => {
  test('shows both methods disabled, each with its own setup button', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    vi.mocked(getTwoFactorStatus).mockResolvedValue(makeTwoFactorStatus());
    renderPage();

    expect(
      await screen.findByRole('heading', { name: 'Two-factor authentication' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Set up authenticator app' }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Set up email codes' })).toBeInTheDocument();
    // No recovery-code control while nothing is enabled.
    expect(
      screen.queryByRole('button', { name: 'Regenerate recovery codes' }),
    ).not.toBeInTheDocument();
  });

  test('authenticator enroll: renders a QR code, confirms, and shows recovery codes once', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    vi.mocked(getTwoFactorStatus).mockResolvedValue(makeTwoFactorStatus());
    vi.mocked(enrollTwoFactor).mockResolvedValue({
      otpauthUri: 'otpauth://totp/BetterTrack:ada%40example.com?secret=ABCDEFGHIJKLMNOP',
      secret: 'ABCDEFGHIJKLMNOP',
    });
    vi.mocked(confirmTwoFactor).mockResolvedValue({
      recoveryCodes: ['aaaa-bbbb-cccc-dddd', 'eeee-ffff-gggg-hhhh'],
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Set up authenticator app' }));

    // A scannable QR encodes the otpauth URI; the manual key is in the fallback.
    expect(await screen.findByLabelText('Two-factor setup QR code')).toBeInTheDocument();
    expect(screen.getByText('ABCDEFGHIJKLMNOP')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Confirmation code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirm & enable' }));

    await waitFor(() => expect(confirmTwoFactor).toHaveBeenCalledWith({ code: '123456' }));

    expect(await screen.findByText('aaaa-bbbb-cccc-dddd')).toBeInTheDocument();
    expect(screen.getByText('eeee-ffff-gggg-hhhh')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: "I've saved these codes" }));

    expect(
      await screen.findByRole('button', { name: 'Set up authenticator app' }),
    ).toBeInTheDocument();
  });

  test('email enroll: sends a code, confirms, and shows recovery codes (first method)', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    vi.mocked(getTwoFactorStatus).mockResolvedValue(makeTwoFactorStatus());
    vi.mocked(confirmEmailTwoFactor).mockResolvedValue({
      recoveryCodes: ['iiii-jjjj-kkkk-llll'],
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Set up email codes' }));
    await waitFor(() => expect(enrollEmailTwoFactor).toHaveBeenCalled());

    await user.type(await screen.findByLabelText('Email code'), '654321');
    await user.click(screen.getByRole('button', { name: 'Confirm & enable' }));

    await waitFor(() => expect(confirmEmailTwoFactor).toHaveBeenCalledWith({ code: '654321' }));
    expect(await screen.findByText('iiii-jjjj-kkkk-llll')).toBeInTheDocument();
  });

  test('email enroll blocked (no SMTP) shows the lockout-guard message', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    vi.mocked(getTwoFactorStatus).mockResolvedValue(makeTwoFactorStatus());
    vi.mocked(enrollEmailTwoFactor).mockRejectedValue(
      new ApiError(
        400,
        'TWO_FACTOR_EMAIL_UNAVAILABLE',
        'Email delivery is not configured, so email codes can’t be sent.',
      ),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Set up email codes' }));

    expect(await screen.findByText(/email delivery is not configured/i)).toBeInTheDocument();
    expect(confirmEmailTwoFactor).not.toHaveBeenCalled();
  });

  test('shows both methods enabled with turn-off and regenerate actions', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    vi.mocked(getTwoFactorStatus).mockResolvedValue(
      makeTwoFactorStatus({ totpEnabled: true, emailEnabled: true, recoveryCodesRemaining: 3 }),
    );
    renderPage();

    expect(await screen.findByText(/3 recovery codes remaining/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regenerate recovery codes' })).toBeInTheDocument();
    // One turn-off button per enabled method.
    expect(screen.getAllByRole('button', { name: 'Turn off' })).toHaveLength(2);
  });

  test('disables the authenticator method with a code', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    vi.mocked(getTwoFactorStatus).mockResolvedValue(
      makeTwoFactorStatus({ totpEnabled: true, recoveryCodesRemaining: 5 }),
    );
    vi.mocked(disableTwoFactor).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Turn off' }));
    await user.type(
      screen.getByLabelText(/authenticator code or recovery code/i),
      'abcd-efgh-ijkl-mnop',
    );
    await user.click(screen.getByRole('button', { name: 'Turn off authenticator app' }));

    await waitFor(() =>
      expect(disableTwoFactor).toHaveBeenCalledWith({ code: 'abcd-efgh-ijkl-mnop' }),
    );
    expect(await screen.findByText(/authenticator app turned off/i)).toBeInTheDocument();
  });

  test('disables the email method directly from the authenticated session', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    vi.mocked(getTwoFactorStatus).mockResolvedValue(
      makeTwoFactorStatus({ emailEnabled: true, recoveryCodesRemaining: 5 }),
    );
    const user = userEvent.setup();
    renderPage();

    // Email is the only enabled method, so there is exactly one "Turn off".
    await user.click(await screen.findByRole('button', { name: 'Turn off' }));

    await waitFor(() => expect(disableEmailTwoFactor).toHaveBeenCalled());
    expect(await screen.findByText(/email codes turned off/i)).toBeInTheDocument();
  });

  test('regenerates recovery codes when a method is enabled', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    vi.mocked(getTwoFactorStatus).mockResolvedValue(
      makeTwoFactorStatus({ totpEnabled: true, recoveryCodesRemaining: 3 }),
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
});
