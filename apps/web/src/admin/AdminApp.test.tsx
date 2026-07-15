import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type {
  AdminStats,
  AdminTwoFactorStatusResponse,
  AdminUser,
  MeResponse,
} from '@bettertrack/contracts';

vi.mock('../lib/adminApi');
import * as api from '../lib/adminApi';
import { ApiError } from '../lib/apiClient';
import { AdminApp } from './AdminApp';

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
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const jane: AdminUser = {
  id: 'user-1',
  email: 'jane@bettertrack.test',
  username: 'jane',
  role: 'user',
  status: 'active',
  mustChangePassword: false,
  chatBanned: false,
  lastLoginAt: null,
  createdAt: '2026-02-02T00:00:00.000Z',
};

const stats: AdminStats = {
  userCount: 1,
  activeUserCount: 1,
  disabledUserCount: 0,
  pendingInviteCount: 0,
};

/** An enrolled admin: the mandatory-2FA setup gate is satisfied (#400). */
const enrolledTwoFactor: AdminTwoFactorStatusResponse = {
  setupRequired: false,
  totpEnabled: true,
  totpPending: false,
  emailEnabled: false,
  twoFactorEmail: null,
  recoveryCodesRemaining: 8,
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/*" element={<AdminApp />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Mirrors the live URL into the DOM so tests can assert where routing settled. */
function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderAtWithLocation(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      <Routes>
        <Route path="/admin/*" element={<AdminApp />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(api.getStats).mockResolvedValue(stats);
  vi.mocked(api.listUsers).mockResolvedValue({ users: [jane] });
  // Bootstrap/login now consult the 2FA setup gate — default to an enrolled admin.
  vi.mocked(api.getTwoFactorStatus).mockResolvedValue(enrolledTwoFactor);
});

test('anonymous visitors are sent to the admin login, not the users page', async () => {
  // A non-admin/anonymous session: /auth/me responds 401 (the API returns 404
  // for non-admins on admin routes — neither leaks route detail to the UI).
  vi.mocked(api.getMe).mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'Not signed in.'));

  renderAt('/admin/users');

  // The login screen carries the wordmark's "Admin" edition; the guarded
  // users page (with jane's email) must not render for an anonymous visitor.
  expect(await screen.findByText('Admin')).toBeInTheDocument();
  expect(screen.queryByText('jane@bettertrack.test')).not.toBeInTheDocument();
});

test('authenticated admins reach the guarded users page', async () => {
  vi.mocked(api.getMe).mockResolvedValue(admin);

  renderAt('/admin/users');

  expect(await screen.findByText('jane@bettertrack.test')).toBeInTheDocument();
});

test('a reset admin is trapped into the forced change, then recovers into the console (#248 item 6)', async () => {
  // A reset admin session: /auth/me responds 403 (the forced-change guard blocks
  // it), so the admin area traps into its own change screen rather than bricking.
  vi.mocked(api.getMe).mockRejectedValue(
    new ApiError(403, 'PASSWORD_CHANGE_REQUIRED', 'Password change required.'),
  );
  vi.mocked(api.changePassword).mockResolvedValue(admin);

  const user = userEvent.setup();
  renderAt('/admin/users');

  // Trapped: the forced-change screen is up; the guarded users page is unreachable.
  expect(
    await screen.findByText('Set a new password before continuing to the admin console.'),
  ).toBeInTheDocument();
  expect(screen.queryByText('jane@bettertrack.test')).not.toBeInTheDocument();
  // No current-password re-entry (#248 item 7).
  expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();

  await user.type(screen.getByLabelText('New password'), 'ops-recovered-strong-9');
  await user.type(screen.getByLabelText('Confirm new password'), 'ops-recovered-strong-9');
  await user.click(screen.getByRole('button', { name: 'Update password' }));

  // Recovered on the same session — the console opens up.
  expect(await screen.findByText('jane@bettertrack.test')).toBeInTheDocument();
  expect(api.changePassword).toHaveBeenCalledWith({ newPassword: 'ops-recovered-strong-9' });
});

test('an admin with no 2FA method is trapped into the forced-enrollment wizard, not the console (#400)', async () => {
  vi.mocked(api.getMe).mockResolvedValue(admin);
  // The setup gate is open: bootstrap resolves the admin, then the exempt status
  // endpoint reports no confirmed method.
  vi.mocked(api.getTwoFactorStatus).mockResolvedValue({
    ...enrolledTwoFactor,
    setupRequired: true,
    totpEnabled: false,
  });

  renderAt('/admin/users');

  // The mandatory-enrollment wizard is up; the guarded users page is unreachable.
  expect(await screen.findByText('Set up two-factor authentication')).toBeInTheDocument();
  expect(screen.queryByText('jane@bettertrack.test')).not.toBeInTheDocument();
});

test('the enrollment wizard sets up TOTP, shows recovery codes once, then opens the console (#400)', async () => {
  const user = userEvent.setup();
  vi.mocked(api.getMe).mockResolvedValue(admin);
  // Unenrolled at bootstrap; enrolled once the wizard confirms a method.
  vi.mocked(api.getTwoFactorStatus).mockResolvedValueOnce({
    ...enrolledTwoFactor,
    setupRequired: true,
    totpEnabled: false,
  });
  vi.mocked(api.enrollTotp).mockResolvedValue({
    otpauthUri: 'otpauth://totp/BetterTrack:root?secret=SEED',
    secret: 'SEED',
  });
  // First method enabled → a fresh set of recovery codes, shown once.
  vi.mocked(api.confirmTotp).mockResolvedValue({ recoveryCodes: ['aaa-111', 'bbb-222'] });

  renderAt('/admin/users');

  // Trapped in the wizard; pick the authenticator method.
  expect(await screen.findByText('Set up two-factor authentication')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /Authenticator app \(TOTP\)/ }));

  // Confirm the enrolled secret.
  await user.type(await screen.findByLabelText('Confirmation code'), '424242');
  await user.click(screen.getByRole('button', { name: 'Confirm & enable' }));

  // Recovery codes are shown exactly once; acknowledging them opens the console.
  expect(await screen.findByText('aaa-111')).toBeInTheDocument();
  expect(api.confirmTotp).toHaveBeenCalledWith({ code: '424242' });
  await user.click(screen.getByRole('button', { name: "I've saved these codes" }));

  expect(await screen.findByText('jane@bettertrack.test')).toBeInTheDocument();
});

test('an enrolled admin passes the login 2FA challenge and enters the console (#400)', async () => {
  const user = userEvent.setup();
  // Anonymous bootstrap so the login form renders.
  vi.mocked(api.getMe).mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'Not signed in.'));
  vi.mocked(api.getVersion).mockRejectedValue(new ApiError(0, 'NETWORK_ERROR', 'offline'));
  // Password step hands back a challenge (session withheld); verify promotes it.
  vi.mocked(api.login).mockResolvedValue({
    twoFactorRequired: true,
    pendingToken: 'pending-token',
    channels: ['totp', 'email', 'recovery'],
  });
  vi.mocked(api.verifyTwoFactor).mockResolvedValue(admin);

  renderAt('/admin/login');

  await user.type(await screen.findByLabelText('Email or username'), 'rootadmin');
  await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));

  // The challenge screen replaces the password form; the console is still gated.
  expect(await screen.findByText('Two-factor authentication')).toBeInTheDocument();
  expect(screen.queryByText('jane@bettertrack.test')).not.toBeInTheDocument();

  await user.type(screen.getByLabelText('Verification code'), '123456');
  await user.click(screen.getByRole('button', { name: 'Verify' }));

  // A valid factor lands the admin in the console.
  expect(await screen.findByText('jane@bettertrack.test')).toBeInTheDocument();
  expect(api.verifyTwoFactor).toHaveBeenCalledWith({
    pendingToken: 'pending-token',
    code: '123456',
  });
});

test('an unknown nested admin path lands on the users home in one hop, without appending segments', async () => {
  vi.mocked(api.getMe).mockResolvedValue(admin);

  // Deep, unmatched sub-path. A relative catch-all redirect would resolve against
  // the splat's full pathname and append endlessly (/admin/blabla/users/users/…);
  // the absolute fallback must instead land squarely on the home route.
  renderAtWithLocation('/admin/blabla');

  // We reached the guarded users page (jane), i.e. the redirect resolved to a
  // real route rather than looping on the fallback.
  expect(await screen.findByText('jane@bettertrack.test')).toBeInTheDocument();

  // Exactly the absolute home — no 'blabla', no duplicated segments.
  const pathname = screen.getByTestId('location').textContent;
  expect(pathname).toBe('/admin/users');
  expect(pathname).not.toContain('blabla');
});
