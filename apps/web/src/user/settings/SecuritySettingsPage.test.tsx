import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  MeResponse,
  SessionInfoResponse,
  SessionSummary,
  TwoFactorStatusResponse,
} from '@bettertrack/contracts';

vi.mock('../../lib/userApi', () => ({
  getMe: vi.fn(),
  getSession: vi.fn(),
  listSessions: vi.fn(),
  revokeSession: vi.fn(),
  revokeOtherSessions: vi.fn(),
  setPin: vi.fn(),
  disablePin: vi.fn(),
  setPinLockIdleMinutes: vi.fn(),
  getGoogleLinkStatus: vi.fn(),
  unlinkGoogle: vi.fn(),
  googleStartUrl: vi.fn(() => 'http://api.test/api/v1/auth/google/start'),
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
import {
  disablePin,
  getGoogleLinkStatus,
  getMe,
  getSession,
  listSessions,
  revokeOtherSessions,
  revokeSession,
  setPin,
  setPinLockIdleMinutes,
  unlinkGoogle,
} from '../../lib/userApi';
import { SecuritySettingsPage } from './SecuritySettingsPage';

const SESSION: SessionInfoResponse = {
  signedInAt: '2026-06-01T08:00:00.000Z',
  renewedAt: '2026-07-01T08:00:00.000Z',
  persistent: true,
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
    locale: 'en',
    lastLoginAt: '2026-07-01T08:00:00.000Z',
    createdAt: '2026-01-15T09:00:00.000Z',
  };
}

function renderPage(initialEntry = '/settings/security') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={client}>
        <SecuritySettingsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const GOOGLE_OFF = {
  enabled: false,
  linked: false,
  email: null,
  linkedAt: null,
  canUnlink: false,
} as const;

const SESSIONS: SessionSummary[] = [
  {
    id: 'handle-current',
    device: 'Chrome on macOS',
    createdAt: '2026-07-01T08:00:00.000Z',
    lastSeenAt: '2026-07-07T09:00:00.000Z',
    current: true,
    persistent: true,
  },
  {
    id: 'handle-other',
    device: 'Firefox on Windows',
    createdAt: '2026-06-20T08:00:00.000Z',
    lastSeenAt: '2026-07-05T10:00:00.000Z',
    current: false,
    persistent: false,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION);
  vi.mocked(listSessions).mockResolvedValue(SESSIONS);
  vi.mocked(revokeSession).mockResolvedValue(undefined);
  vi.mocked(revokeOtherSessions).mockResolvedValue({ revoked: 1 });
  vi.mocked(setPin).mockResolvedValue(makeMe(true));
  vi.mocked(disablePin).mockResolvedValue(makeMe(false));
  vi.mocked(setPinLockIdleMinutes).mockResolvedValue(makeMe(true));
  vi.mocked(getTwoFactorStatus).mockResolvedValue(makeTwoFactorStatus());
  vi.mocked(enrollEmailTwoFactor).mockResolvedValue(undefined);
  vi.mocked(disableEmailTwoFactor).mockResolvedValue(undefined);
  // Google off by default so the section stays hidden unless a test opts in.
  vi.mocked(getGoogleLinkStatus).mockResolvedValue(GOOGLE_OFF);
  vi.mocked(unlinkGoogle).mockResolvedValue(undefined);
});

describe('SecuritySettingsPage', () => {
  test('renders session info', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    renderPage();

    expect(await screen.findByText(/signed in since/i)).toBeInTheDocument();
    expect(screen.getByText(/expires after 30 days of inactivity/i)).toBeInTheDocument();
  });

  test('an ephemeral session reports its real lifetime, not "30 days" (V4-P2b, §399 §A)', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    vi.mocked(getSession).mockResolvedValue({ ...SESSION, persistent: false });
    renderPage();

    // The browser-only copy, never the persistent 30-day claim.
    expect(await screen.findByText(/signs out when you close it/i)).toBeInTheDocument();
    expect(screen.queryByText(/expires after 30 days of inactivity/i)).not.toBeInTheDocument();
  });

  test('lists active sessions with device labels and a current-device marker (V3-P11a)', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Active sessions' })).toBeInTheDocument();
    expect(await screen.findByText('Chrome on macOS')).toBeInTheDocument();
    expect(screen.getByText('Firefox on Windows')).toBeInTheDocument();
    // The current session is marked and has no per-row log-out button.
    expect(screen.getByText('This device')).toBeInTheDocument();
    // Exactly one per-row "Log out" (the non-current device).
    expect(screen.getAllByRole('button', { name: 'Log out' })).toHaveLength(1);
  });

  test('marks each session persistent vs ephemeral (V4-P2b, §399 §A)', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    renderPage();

    // The current session is persistent; the other was a browser-session login.
    expect(await screen.findByText('Stays signed in')).toBeInTheDocument();
    expect(screen.getByText('This browser only')).toBeInTheDocument();
  });

  test('logs out one device via revokeSession (V3-P11a)', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(revokeSession).toHaveBeenCalledWith('handle-other'));
  });

  test('logs out all other devices behind a confirm step (V3-P11a)', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    const user = userEvent.setup();
    renderPage();

    // First click reveals the confirmation, not an immediate revoke.
    await user.click(await screen.findByRole('button', { name: 'Log out all other devices' }));
    expect(revokeOtherSessions).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Log out all other devices' }));
    await waitFor(() => expect(revokeOtherSessions).toHaveBeenCalled());
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

describe('SecuritySettingsPage — Google account (§13.4 V4-P4b)', () => {
  const LINKED = {
    enabled: true,
    linked: true,
    email: 'me@example.com',
    linkedAt: '2026-07-01T08:00:00.000Z',
    canUnlink: true,
  } as const;

  test('the section is hidden when Google is not configured (routes 404 / disabled)', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    // Default beforeEach mock is GOOGLE_OFF (enabled: false).
    renderPage();
    // The rest of the page renders; the Google section never appears.
    expect(await screen.findByText(/signed in since/i)).toBeInTheDocument();
    expect(screen.queryByText('Google account')).not.toBeInTheDocument();
  });

  test('shows the linked identity and unlinks after a password re-auth', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    vi.mocked(getGoogleLinkStatus).mockResolvedValue(LINKED);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('Linked as me@example.com')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Unlink' }));
    await user.type(await screen.findByLabelText('Password'), 'my-password-1');
    await user.click(screen.getByRole('button', { name: 'Unlink Google' }));

    await waitFor(() => expect(unlinkGoogle).toHaveBeenCalledWith('my-password-1'));
    expect(await screen.findByText('Google account unlinked.')).toBeInTheDocument();
  });

  test('a wrong password surfaces an in-form error and does not unlink further', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    vi.mocked(getGoogleLinkStatus).mockResolvedValue(LINKED);
    vi.mocked(unlinkGoogle).mockRejectedValue(new ApiError(401, 'INVALID_CREDENTIALS', 'nope'));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Unlink' }));
    await user.type(await screen.findByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Unlink Google' }));

    expect(await screen.findByText('Your password is incorrect.')).toBeInTheDocument();
  });

  test('Google as the only sign-in method: unlink is withheld with a hint', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    vi.mocked(getGoogleLinkStatus).mockResolvedValue({ ...LINKED, canUnlink: false });
    renderPage();

    expect(await screen.findByText('Linked as me@example.com')).toBeInTheDocument();
    expect(screen.getByText(/only way to sign in/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlink' })).not.toBeInTheDocument();
  });

  test('when not linked, offers a Connect Google affordance', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    vi.mocked(getGoogleLinkStatus).mockResolvedValue({
      enabled: true,
      linked: false,
      email: null,
      linkedAt: null,
      canUnlink: false,
    });
    renderPage();

    expect(await screen.findByText('No Google account is linked.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect Google' })).toBeInTheDocument();
  });

  test('announces a just-completed link from the ?google=linked callback marker', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    vi.mocked(getGoogleLinkStatus).mockResolvedValue(LINKED);
    renderPage('/settings/security?google=linked');

    expect(await screen.findByText('Google account linked.')).toBeInTheDocument();
  });

  test('surfaces an email-mismatch connect failure from the ?error=google_email_mismatch marker', async () => {
    // Connect is email-match-only (owner order 2026-07-16): the callback bounces
    // a mismatched Google email back as ?error=google_email_mismatch.
    vi.mocked(getMe).mockResolvedValue(makeMe(false));
    vi.mocked(getGoogleLinkStatus).mockResolvedValue({
      enabled: true,
      linked: false,
      email: null,
      linkedAt: null,
      canUnlink: false,
    });
    renderPage('/settings/security?error=google_email_mismatch');

    expect(await screen.findByText(/doesn't match your account email/i)).toBeInTheDocument();
    // The connect affordance is still offered — nothing was linked.
    expect(screen.getByRole('link', { name: 'Connect Google' })).toBeInTheDocument();
  });
});
