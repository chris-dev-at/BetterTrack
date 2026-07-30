import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { MeResponse, Passkey, TwoFactorStatusResponse } from '@bettertrack/contracts';

vi.mock('../../../lib/userApi', () => ({
  changePassword: vi.fn(),
  listPasskeys: vi.fn(),
  renamePasskey: vi.fn(),
  deletePasskey: vi.fn(),
  // The PIN app lock moved here from Sessions (owner order).
  getMe: vi.fn(),
  setPin: vi.fn(),
  disablePin: vi.fn(),
  setPinLockIdleMinutes: vi.fn(),
}));

vi.mock('../../../lib/passkeys', () => ({
  browserSupportsWebAuthn: vi.fn(() => true),
  isPasskeyCancellation: vi.fn(() => false),
  registerPasskey: vi.fn(),
}));

vi.mock('../../../lib/twoFactorApi', () => ({
  getTwoFactorStatus: vi.fn(),
  enrollTwoFactor: vi.fn(),
  confirmTwoFactor: vi.fn(),
  disableTwoFactor: vi.fn(),
  enrollEmailTwoFactor: vi.fn(),
  confirmEmailTwoFactor: vi.fn(),
  disableEmailTwoFactor: vi.fn(),
  regenerateRecoveryCodes: vi.fn(),
}));

import { ApiError } from '../../../lib/apiClient';
import { registerPasskey } from '../../../lib/passkeys';
import {
  confirmEmailTwoFactor,
  confirmTwoFactor,
  disableEmailTwoFactor,
  disableTwoFactor,
  enrollEmailTwoFactor,
  enrollTwoFactor,
  getTwoFactorStatus,
  regenerateRecoveryCodes,
} from '../../../lib/twoFactorApi';
import {
  changePassword,
  deletePasskey,
  disablePin,
  getMe,
  listPasskeys,
  renamePasskey,
  setPin,
  setPinLockIdleMinutes,
} from '../../../lib/userApi';
import { SignInPanel } from './SignInPanel';

const ME: MeResponse = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'ada@example.com',
  username: 'ada',
  role: 'user',
  status: 'active',
  mustChangePassword: false,
  pinEnabled: false,
  pinLockIdleMinutes: null,
  baseCurrency: 'EUR',
  locale: 'en',
  lastLoginAt: '2026-07-01T10:00:00.000Z',
  createdAt: '2026-01-15T09:00:00.000Z',
};

/** `ME` with the PIN on/off — the flag that drives the PIN group's shape. */
function makeMe(pinEnabled: boolean): MeResponse {
  return { ...ME, pinEnabled };
}

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

function makePasskey(overrides: Partial<Passkey> = {}): Passkey {
  return {
    id: 'pk-1',
    name: 'MacBook Touch ID',
    createdAt: '2026-06-01T08:00:00.000Z',
    lastUsedAt: '2026-07-01T08:00:00.000Z',
    ...overrides,
  };
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <MemoryRouter initialEntries={['/control/sign-in']}>
      <QueryClientProvider client={client}>
        <SignInPanel />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/**
 * "Current password" is the accessible label of BOTH the change-password field
 * and the passkey re-auth field — merging credentials onto one panel made them
 * coexist, and the labels are load-bearing (tests + e2e), so they stay. Queries
 * scope to the owning group instead of guessing.
 */
function group(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 3, name });
  const section = heading.closest('section');
  if (!section) throw new Error(`no group section for "${name}"`);
  return section as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(changePassword).mockResolvedValue(ME);
  vi.mocked(getTwoFactorStatus).mockResolvedValue(makeTwoFactorStatus());
  vi.mocked(enrollEmailTwoFactor).mockResolvedValue(undefined);
  vi.mocked(disableEmailTwoFactor).mockResolvedValue(undefined);
  vi.mocked(listPasskeys).mockResolvedValue([]);
  vi.mocked(getMe).mockResolvedValue(makeMe(false));
  vi.mocked(setPin).mockResolvedValue(makeMe(true));
  vi.mocked(disablePin).mockResolvedValue(makeMe(false));
  vi.mocked(setPinLockIdleMinutes).mockResolvedValue(makeMe(true));
});

describe('SignInPanel — password', () => {
  // Popup-native: ONE compact head naming the panel; the four credential
  // groups keep real headings so the outline survives the compaction.
  test('carries one panel head and its four credential groups', async () => {
    renderPanel();

    // The PIN group waits on `getMe`, so anchor on it before counting.
    await screen.findByRole('heading', { level: 3, name: 'PIN' });

    const heads = screen.getAllByRole('heading', { level: 2 });
    expect(heads).toHaveLength(1);
    expect(heads[0]).toHaveTextContent('Sign-in');
    // The PIN is the fourth, and it comes LAST so it never reads as a third
    // factor beside the real ones.
    const groups = ['Change password', 'Two-factor authentication', 'Passkeys', 'PIN'];
    expect(screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent)).toEqual(
      groups,
    );
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  test('change-password submit calls the client with current + new', async () => {
    const user = userEvent.setup();
    renderPanel();

    const form = group('Change password');
    await user.type(within(form).getByLabelText('Current password'), 'oldpassword1');
    await user.type(within(form).getByLabelText('New password'), 'newpassword123');
    await user.type(within(form).getByLabelText('Confirm new password'), 'newpassword123');
    await user.click(within(form).getByRole('button', { name: 'Update password' }));

    await waitFor(() =>
      expect(changePassword).toHaveBeenCalledWith({
        currentPassword: 'oldpassword1',
        newPassword: 'newpassword123',
      }),
    );
    expect(await screen.findByText(/password has been changed/i)).toBeInTheDocument();
  });

  test('mismatched new passwords do not call the client', async () => {
    const user = userEvent.setup();
    renderPanel();

    const form = group('Change password');
    await user.type(within(form).getByLabelText('Current password'), 'oldpassword1');
    await user.type(within(form).getByLabelText('New password'), 'newpassword123');
    await user.type(within(form).getByLabelText('Confirm new password'), 'different12345');
    await user.click(within(form).getByRole('button', { name: 'Update password' }));

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(changePassword).not.toHaveBeenCalled();
  });

  test('a wrong current password surfaces the credential error, not a generic one', async () => {
    vi.mocked(changePassword).mockRejectedValue(new ApiError(401, 'INVALID_CREDENTIALS', 'nope'));
    const user = userEvent.setup();
    renderPanel();

    const form = group('Change password');
    await user.type(within(form).getByLabelText('Current password'), 'wrongpassword');
    await user.type(within(form).getByLabelText('New password'), 'newpassword123');
    await user.type(within(form).getByLabelText('Confirm new password'), 'newpassword123');
    await user.click(within(form).getByRole('button', { name: 'Update password' }));

    expect(await screen.findByText(/current password is incorrect/i)).toBeInTheDocument();
  });
});

describe('SignInPanel — two-factor authentication (#298)', () => {
  test('shows both methods disabled, each with its own setup button', async () => {
    vi.mocked(getTwoFactorStatus).mockResolvedValue(makeTwoFactorStatus());
    renderPanel();

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
    vi.mocked(getTwoFactorStatus).mockResolvedValue(makeTwoFactorStatus());
    vi.mocked(enrollTwoFactor).mockResolvedValue({
      otpauthUri: 'otpauth://totp/BetterTrack:ada%40example.com?secret=ABCDEFGHIJKLMNOP',
      secret: 'ABCDEFGHIJKLMNOP',
    });
    vi.mocked(confirmTwoFactor).mockResolvedValue({
      recoveryCodes: ['aaaa-bbbb-cccc-dddd', 'eeee-ffff-gggg-hhhh'],
    });
    const user = userEvent.setup();
    renderPanel();

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
    vi.mocked(getTwoFactorStatus).mockResolvedValue(makeTwoFactorStatus());
    vi.mocked(confirmEmailTwoFactor).mockResolvedValue({
      recoveryCodes: ['iiii-jjjj-kkkk-llll'],
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Set up email codes' }));
    await waitFor(() => expect(enrollEmailTwoFactor).toHaveBeenCalled());

    await user.type(await screen.findByLabelText('Email code'), '654321');
    await user.click(screen.getByRole('button', { name: 'Confirm & enable' }));

    await waitFor(() => expect(confirmEmailTwoFactor).toHaveBeenCalledWith({ code: '654321' }));
    expect(await screen.findByText('iiii-jjjj-kkkk-llll')).toBeInTheDocument();
  });

  test('email enroll blocked (no SMTP) shows the lockout-guard message', async () => {
    vi.mocked(getTwoFactorStatus).mockResolvedValue(makeTwoFactorStatus());
    vi.mocked(enrollEmailTwoFactor).mockRejectedValue(
      new ApiError(
        400,
        'TWO_FACTOR_EMAIL_UNAVAILABLE',
        'Email delivery is not configured, so email codes can’t be sent.',
      ),
    );
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Set up email codes' }));

    expect(await screen.findByText(/email delivery is not configured/i)).toBeInTheDocument();
    expect(confirmEmailTwoFactor).not.toHaveBeenCalled();
  });

  test('shows both methods enabled with turn-off and regenerate actions', async () => {
    vi.mocked(getTwoFactorStatus).mockResolvedValue(
      makeTwoFactorStatus({ totpEnabled: true, emailEnabled: true, recoveryCodesRemaining: 3 }),
    );
    renderPanel();

    expect(await screen.findByText(/3 recovery codes remaining/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regenerate recovery codes' })).toBeInTheDocument();
    // One turn-off button per enabled method.
    expect(screen.getAllByRole('button', { name: 'Turn off' })).toHaveLength(2);
  });

  test('disables the authenticator method with a code', async () => {
    vi.mocked(getTwoFactorStatus).mockResolvedValue(
      makeTwoFactorStatus({ totpEnabled: true, recoveryCodesRemaining: 5 }),
    );
    vi.mocked(disableTwoFactor).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPanel();

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
    vi.mocked(getTwoFactorStatus).mockResolvedValue(
      makeTwoFactorStatus({ emailEnabled: true, recoveryCodesRemaining: 5 }),
    );
    const user = userEvent.setup();
    renderPanel();

    // Email is the only enabled method, so there is exactly one "Turn off".
    await user.click(await screen.findByRole('button', { name: 'Turn off' }));

    await waitFor(() => expect(disableEmailTwoFactor).toHaveBeenCalled());
    expect(await screen.findByText(/email codes turned off/i)).toBeInTheDocument();
  });

  test('regenerates recovery codes when a method is enabled', async () => {
    vi.mocked(getTwoFactorStatus).mockResolvedValue(
      makeTwoFactorStatus({ totpEnabled: true, recoveryCodesRemaining: 3 }),
    );
    vi.mocked(regenerateRecoveryCodes).mockResolvedValue({
      recoveryCodes: ['zzzz-yyyy-xxxx-wwww'],
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Regenerate recovery codes' }));

    await waitFor(() => expect(regenerateRecoveryCodes).toHaveBeenCalled());
    expect(await screen.findByText('zzzz-yyyy-xxxx-wwww')).toBeInTheDocument();
  });
});

describe('SignInPanel — passkeys (§13.4 V4-P4)', () => {
  test('lists passkeys with name, added, and last-used', async () => {
    vi.mocked(listPasskeys).mockResolvedValue([
      makePasskey({ id: 'pk-1', name: 'MacBook Touch ID' }),
      makePasskey({ id: 'pk-2', name: 'YubiKey', lastUsedAt: null }),
    ]);
    renderPanel();

    expect(await screen.findByText('MacBook Touch ID')).toBeInTheDocument();
    expect(screen.getByText('YubiKey')).toBeInTheDocument();
    // One shows a last-used stamp; the never-used one reads "never used".
    expect(screen.getAllByText(/last used/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/never used/i)).toBeInTheDocument();
  });

  test('renames a passkey', async () => {
    vi.mocked(listPasskeys).mockResolvedValue([makePasskey()]);
    vi.mocked(renamePasskey).mockResolvedValue(makePasskey({ name: 'Work laptop' }));
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Rename' }));
    const input = screen.getByLabelText('Passkey name');
    await user.clear(input);
    await user.type(input, 'Work laptop');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(renamePasskey).toHaveBeenCalledWith('pk-1', 'Work laptop'));
  });

  test('deletes a passkey after confirming the password', async () => {
    vi.mocked(listPasskeys).mockResolvedValue([
      makePasskey({ id: 'pk-1' }),
      makePasskey({ id: 'pk-2', name: 'YubiKey' }),
    ]);
    vi.mocked(deletePasskey).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPanel();

    await user.click((await screen.findAllByRole('button', { name: 'Delete' }))[0]!);
    // Scoped: the change-password form owns a "Current password" field too.
    const keys = group('Passkeys');
    await user.type(within(keys).getByLabelText('Current password'), 'my-password');
    await user.click(within(keys).getByRole('button', { name: 'Remove passkey' }));

    await waitFor(() =>
      expect(deletePasskey).toHaveBeenCalledWith('pk-1', { password: 'my-password' }),
    );
  });

  test('warns when removing the last passkey (password login remains)', async () => {
    vi.mocked(listPasskeys).mockResolvedValue([makePasskey()]);
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(screen.getByText(/last passkey/i)).toBeInTheDocument();
  });

  test('registers a passkey with a name + password re-auth', async () => {
    vi.mocked(listPasskeys).mockResolvedValue([]);
    vi.mocked(registerPasskey).mockResolvedValue(makePasskey({ name: 'New key' }));
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Add a passkey' }));
    const keys = group('Passkeys');
    await user.type(within(keys).getByLabelText('Passkey name'), 'New key');
    await user.type(within(keys).getByLabelText('Current password'), 'my-password');
    await user.click(within(keys).getByRole('button', { name: 'Add passkey' }));

    await waitFor(() =>
      expect(registerPasskey).toHaveBeenCalledWith('New key', { password: 'my-password' }),
    );
  });

  test('an unsupported browser hides the add form and says so', async () => {
    const { browserSupportsWebAuthn } = await import('../../../lib/passkeys');
    vi.mocked(browserSupportsWebAuthn).mockReturnValueOnce(false);
    vi.mocked(listPasskeys).mockResolvedValue([]);
    renderPanel();

    expect(await screen.findByText(/doesn't support passkeys/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a passkey' })).not.toBeInTheDocument();
  });
});

/**
 * The PIN app lock (§6.1, §13.2 V2-P2, #288/#304) — moved here from the Sessions
 * panel on owner order. Endpoints, confirmations and copy are unchanged; only its
 * home is. Its labels are "PIN" / "Confirm PIN" / "Unlock window", so none of
 * them collides with this panel's two "Current password" fields.
 */
describe('SignInPanel — the PIN app lock', () => {
  test('enables a PIN when none is set', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.type(await screen.findByLabelText('PIN'), '1234');
    await user.type(screen.getByLabelText('Confirm PIN'), '1234');
    await user.click(screen.getByRole('button', { name: 'Enable PIN' }));

    await waitFor(() => expect(setPin).toHaveBeenCalledWith({ pin: '1234' }));
  });

  test('rejects a mismatched PIN confirmation', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.type(await screen.findByLabelText('PIN'), '1234');
    await user.type(screen.getByLabelText('Confirm PIN'), '5678');
    await user.click(screen.getByRole('button', { name: 'Enable PIN' }));

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(setPin).not.toHaveBeenCalled();
  });

  test('changes and disables an existing PIN', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(true));
    const user = userEvent.setup();
    renderPanel();

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
    renderPanel();

    // With no PIN, the enable form is up but no window picker.
    expect(await screen.findByRole('button', { name: 'Enable PIN' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Unlock window')).not.toBeInTheDocument();
  });

  test('the unlock window defaults to 10 minutes when unset (#288)', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe(true)); // pinLockIdleMinutes: null → default
    renderPanel();

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
    renderPanel();

    const select = (await screen.findByLabelText('Unlock window')) as HTMLSelectElement;
    expect(select.value).toBe('5');
    await user.selectOptions(select, '30');

    await waitFor(() => expect(setPinLockIdleMinutes).toHaveBeenCalledWith({ idleMinutes: 30 }));
  });

  // The PIN is a privacy curtain over an existing session, not a second factor —
  // the copy that says so is load-bearing and must survive the move.
  test('keeps the "not a second factor" framing', async () => {
    renderPanel();

    expect(await screen.findByText(/not a second factor/i)).toBeInTheDocument();
  });
});
