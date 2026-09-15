import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  ADMIN_2FA_SETUP_REQUIRED,
  NOTIFICATION_SETTING_CHANNELS,
  NOTIFICATION_TYPES,
  type AccountDefaultsResponse,
  type AdminFeatureFlag,
  type AdminFeatureFlagsResponse,
  type AdminSessionPolicyResponse,
  type AiSettingsResponse,
  type AppSettingsResponse,
  type MeResponse,
  type NotificationMatrix,
  type SessionSummary,
  type TwoFactorEnrollResponse,
} from '@bettertrack/contracts';

vi.mock('../lib/adminApi');
import * as api from '../lib/adminApi';
import { I18nProvider, localizedMessage } from '../i18n';
import { ApiError } from '../lib/apiClient';
import { AuthProvider, useAuth } from './AuthContext';
import { useAdminMutation } from './useAdminMutation';
import { useResource } from './useResource';
import { LoginPage } from './pages/LoginPage';
import { AccountDefaultsPage } from './pages/AccountDefaultsPage';
import { AiSettingsPage } from './pages/AiSettingsPage';
import { FeatureFlagsPage } from './pages/FeatureFlagsPage';
import { RegistrationPage } from './pages/RegistrationPage';
import { SecuritySettingsPage } from './pages/SecuritySettingsPage';
import { SettingsPage } from './pages/SettingsPage';

/**
 * V5-P13c — the moment the admin session window closes (issue #1779).
 *
 * The server side is shipped and correct: the absolute lifetime is re-read from
 * `app_settings` on every session resolution and measured from the session's
 * `createdAt`, and an expired admin session answers **404** because §6.12 makes
 * every `/admin/*` route answer 404 to non-admins. This suite is about what the
 * console does with that 404, and about not waiting for it at all.
 *
 * The claims, one per acceptance criterion:
 *  1. a write from each of the six hand-rolled pages — and every keyless write on
 *     the P13c page itself — signs the console out and lands on the login screen
 *     with the translated expiry notice;
 *  2. `useAdminMutation`'s 404 disposition is per call site — no-row-id writes
 *     are auth loss, row-scoped writes still surface "row gone";
 *  3. a 403 `ADMIN_2FA_SETUP_REQUIRED` stays a distinct outcome;
 *  4. an idle console reaches the login screen when the deadline passes, with
 *     no operator click;
 *  5. lowering the lifetime shortens the client-held deadline;
 *  6. the read path's 401-or-404 sign-out is unchanged, and only CLAIMS an expiry
 *     when the 404 named no domain outcome;
 *  7. a browser clock that disagrees with the server's, in EITHER direction, is
 *     never turned into a sign-out — and the screen that decides this is measured
 *     against the session's OWN window, so a normal clock error on a 24 h-wide
 *     install does not silently disable the deadline instead;
 *  8. an AUTH-LOSS answer to the deadline refresh itself ends the session, rather
 *     than being swallowed into "unknown" while the previous, longer deadline
 *     stays armed — and an EXPIRY sign-out revokes the session server-side, so
 *     the operator is never told "expired" over a session a reload walks straight
 *     back into, while a domain 404 stays the local-only sign-out it always was
 *     (#1833).
 */

/** Expected copy always comes from the catalog, so EN and DE assert the same claim. */
const message = (locale: 'en' | 'de', key: string) => localizedMessage(locale, key);

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

const settings: AppSettingsResponse = {
  registrationMode: 'approval',
  betaMode: false,
  updatedAt: null,
  updatedBy: null,
};

const sessionPolicy: AdminSessionPolicyResponse = {
  sessionLifetimeHours: 12,
  minHours: 6,
  maxHours: 24,
  updatedAt: null,
  updatedBy: null,
};

/**
 * The current admin session's login instant. Anchored to "now" rather than a
 * frozen date: this session must still be INSIDE its 12 h window in the
 * real-timer tests below, or the console would sign itself out before the write
 * under test ever ran. The fake-timer block pins the clock to it explicitly.
 */
const SESSION_CREATED_AT_MS = Date.now();
const SESSION_CREATED_AT = new Date(SESSION_CREATED_AT_MS).toISOString();

const currentSession: SessionSummary = {
  id: 'session-handle',
  device: 'Test browser',
  createdAt: SESSION_CREATED_AT,
  lastSeenAt: SESSION_CREATED_AT,
  current: true,
  persistent: true,
};

const featureFlag = (key: AdminFeatureFlag['key']): AdminFeatureFlag => ({
  key,
  enabled: true,
  description: `${key} desc`,
  updatedAt: null,
  updatedBy: null,
});

const featureFlags: AdminFeatureFlagsResponse = {
  flags: [featureFlag('realtime'), featureFlag('chat')],
};

const aiSettings: AiSettingsResponse = {
  endpoint: null,
  model: null,
  dailyCap: 20,
  configured: false,
  updatedAt: null,
  updatedBy: null,
};

function makeMatrix(): NotificationMatrix {
  return Object.fromEntries(
    NOTIFICATION_TYPES.map((type) => [
      type,
      Object.fromEntries(NOTIFICATION_SETTING_CHANNELS.map((channel) => [channel, false])),
    ]),
  ) as NotificationMatrix;
}

const accountDefaults: AccountDefaultsResponse = {
  chatEnabled: true,
  defaultPortfolioVisibility: 'private',
  developerStatus: false,
  notificationMatrix: makeMatrix(),
  channelsConfigurable: { telegram: false, discord: false },
};

/** The §6.12 answer an expired admin session gets on every `/admin/*` route. */
const expiredAdminSession = () => new ApiError(404, 'NOT_FOUND', 'Not found');

/**
 * A console whose only factor is the email method, so the Security page offers
 * the two shared enroll forms (`TotpEnrollForm` via "Set up", `EmailEnrollForm`
 * via "Change") rather than the enabled-method rows.
 */
const emailOnlyStatus = {
  setupRequired: false,
  totpEnabled: false,
  totpPending: false,
  emailEnabled: true,
  twoFactorEmail: 'codes@bettertrack.test',
  recoveryCodesRemaining: 8,
};

const totpEnrollment: TwoFactorEnrollResponse = {
  otpauthUri: 'otpauth://totp/BetterTrack:rootadmin?secret=JBSWY3DPEHPK3PXP&issuer=BetterTrack',
  secret: 'JBSWY3DPEHPK3PXP',
};

/**
 * The console reduced to what this suite is about: the signed-in surface, the
 * login screen the route guard falls back to, and the raw status so a trap that
 * is NOT a sign-out (the mandatory-2FA wizard) stays distinguishable from one
 * that is. Mirrors `AdminShell`'s own status → screen mapping.
 */
function Console({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  return (
    <>
      <span data-testid="status">{status}</span>
      {status === 'authenticated' ? children : null}
      {status === 'anonymous' ? <LoginPage /> : null}
    </>
  );
}

function renderConsole(children: ReactNode, locale: 'en' | 'de' = 'en') {
  return render(
    <I18nProvider initialLocale={locale}>
      <MemoryRouter>
        <AuthProvider>
          <Console>{children}</Console>
        </AuthProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

/** The login screen is up AND says why — not a bare bounce, not a save banner. */
async function expectExpiryScreen(locale: 'en' | 'de' = 'en') {
  expect(
    await screen.findByText(message(locale, 'auth.adminLogin.sessionExpired')),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: message(locale, 'auth.login.submit') })).toBeVisible();
}

beforeEach(() => {
  // `resetAllMocks`, not `clearAllMocks`: a reset also drains queued `…Once`
  // values, so one failing test cannot hand leftovers to the next.
  vi.resetAllMocks();
  vi.mocked(api.getMe).mockResolvedValue(admin);
  vi.mocked(api.getTwoFactorStatus).mockResolvedValue({
    setupRequired: false,
    totpEnabled: true,
    totpPending: false,
    emailEnabled: false,
    twoFactorEmail: null,
    recoveryCodesRemaining: 8,
  });
  vi.mocked(api.getVersion).mockRejectedValue(new Error('no version marker in tests'));
  // The deadline reads answer by default; the timer tests override them.
  vi.mocked(api.getSessionPolicy).mockResolvedValue(sessionPolicy);
  vi.mocked(api.listOwnSessions).mockResolvedValue([currentSession]);
});

describe('an expired admin session signs the console out from every hand-rolled write', () => {
  test('Settings — the beta toggle save', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings);
    vi.mocked(api.updateSettings).mockRejectedValue(expiredAdminSession());
    const user = userEvent.setup();
    renderConsole(<SettingsPage />);

    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    await expectExpiryScreen();
    // The defect this replaces: a red banner on a console that can no longer save.
    expect(screen.queryByText(message('en', 'admin.settings.saveError'))).not.toBeInTheDocument();
  });

  test('Registration — the mode save, the same PATCH /admin/settings route', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings);
    vi.mocked(api.listRegistrationTokens).mockResolvedValue({
      tokens: [],
      page: { total: 0, limit: 25, offset: 0 },
    });
    vi.mocked(api.listRegistrationRequests).mockResolvedValue({
      requests: [],
      page: { total: 0, limit: 25, offset: 0 },
    });
    vi.mocked(api.updateSettings).mockRejectedValue(expiredAdminSession());
    const user = userEvent.setup();
    renderConsole(<RegistrationPage />);

    await user.click(await screen.findByRole('radio', { name: /^Open/ }));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    await expectExpiryScreen();
    expect(
      screen.queryByText(message('en', 'admin.registration.modeSaveError')),
    ).not.toBeInTheDocument();
  });

  test('Security — the P13c session-policy card itself', async () => {
    vi.mocked(api.updateSessionPolicy).mockRejectedValue(expiredAdminSession());
    const user = userEvent.setup();
    renderConsole(<SecuritySettingsPage />);

    const hours = await screen.findByLabelText(
      message('en', 'admin.security.sessionPolicy.hoursLabel'),
    );
    await user.clear(hours);
    await user.type(hours, '8');
    await user.click(
      screen.getByRole('button', { name: message('en', 'admin.security.sessionPolicy.save') }),
    );

    await expectExpiryScreen();
    expect(
      screen.queryByText(message('en', 'admin.security.sessionPolicy.saveError')),
    ).not.toBeInTheDocument();
  });

  test('Security — regenerating recovery codes, the same page two cards up', async () => {
    vi.mocked(api.regenerateRecoveryCodes).mockRejectedValue(expiredAdminSession());
    const user = userEvent.setup();
    renderConsole(<SecuritySettingsPage />);

    await user.click(
      await screen.findByRole('button', {
        name: message('en', 'admin.twoFactor.recoveryCodes.regenerate'),
      }),
    );

    await expectExpiryScreen();
    // The defect this replaces: the bare `catch` printed "couldn't regenerate"
    // on a console whose every next request would fail identically.
    expect(
      screen.queryByText(message('en', 'admin.twoFactor.recoveryCodes.regenerateError')),
    ).not.toBeInTheDocument();
  });

  test('Security — turning the email method off', async () => {
    vi.mocked(api.getTwoFactorStatus).mockResolvedValue({
      setupRequired: false,
      totpEnabled: true,
      totpPending: false,
      emailEnabled: true,
      twoFactorEmail: 'codes@bettertrack.test',
      recoveryCodesRemaining: 8,
    });
    vi.mocked(api.disableEmailTwoFactor).mockRejectedValue(expiredAdminSession());
    const user = userEvent.setup();
    renderConsole(<SecuritySettingsPage />);

    await user.click(
      await screen.findByRole('button', { name: message('en', 'admin.twoFactor.email.turnOff') }),
    );

    await expectExpiryScreen();
    // Previously the raw English server envelope ("Not found") was rendered under
    // the card — worse than the banner the P13c card two rows below removed.
    expect(screen.queryByText('Not found')).not.toBeInTheDocument();
    expect(
      screen.queryByText(message('en', 'admin.twoFactor.email.disableError')),
    ).not.toBeInTheDocument();
  });

  test('Security — the TOTP disable code field, which keeps its own error mapping', async () => {
    vi.mocked(api.disableTotp).mockRejectedValue(expiredAdminSession());
    const user = userEvent.setup();
    renderConsole(<SecuritySettingsPage />);

    await user.click(
      await screen.findByRole('button', { name: message('en', 'admin.twoFactor.totp.reenroll') }),
    );
    await user.type(
      await screen.findByLabelText(message('en', 'admin.twoFactor.totp.disableCodeLabel')),
      '111111',
    );
    await user.click(
      screen.getByRole('button', {
        name: message('en', 'admin.twoFactor.totp.disableAndContinue'),
      }),
    );

    await expectExpiryScreen();
    expect(screen.queryByText('Not found')).not.toBeInTheDocument();
  });

  test('Security — starting a TOTP re-enrollment, on the shared enroll form', async () => {
    vi.mocked(api.getTwoFactorStatus).mockResolvedValue(emailOnlyStatus);
    vi.mocked(api.enrollTotp).mockRejectedValue(expiredAdminSession());
    const user = userEvent.setup();
    renderConsole(<SecuritySettingsPage />);

    await user.click(
      await screen.findByRole('button', { name: message('en', 'admin.twoFactor.totp.setup') }),
    );

    await expectExpiryScreen();
    // The defect this replaces: "couldn't start enrollment", inviting a retry
    // that cannot succeed on a console that is no longer an admin.
    expect(
      screen.queryByText(message('en', 'admin.twoFactor.totp.enrollError')),
    ).not.toBeInTheDocument();
  });

  test('Security — confirming the authenticator code, on the shared enroll form', async () => {
    vi.mocked(api.getTwoFactorStatus).mockResolvedValue(emailOnlyStatus);
    vi.mocked(api.enrollTotp).mockResolvedValue(totpEnrollment);
    vi.mocked(api.confirmTotp).mockRejectedValue(expiredAdminSession());
    const user = userEvent.setup();
    renderConsole(<SecuritySettingsPage />);

    await user.click(
      await screen.findByRole('button', { name: message('en', 'admin.twoFactor.totp.setup') }),
    );
    await user.type(
      await screen.findByLabelText(message('en', 'admin.twoFactor.totp.confirmationCodeLabel')),
      '123456',
    );
    await user.click(
      screen.getByRole('button', { name: message('en', 'admin.twoFactor.confirmAndEnable') }),
    );

    await expectExpiryScreen();
    // `twoFactorErrorMessage` used to print the raw English envelope under the
    // code field, untranslated, on a dead console.
    expect(screen.queryByText('Not found')).not.toBeInTheDocument();
  });

  test('Security — requesting the 2FA email code, on the shared enroll form', async () => {
    vi.mocked(api.getTwoFactorStatus).mockResolvedValue(emailOnlyStatus);
    vi.mocked(api.startEmailTwoFactor).mockRejectedValue(expiredAdminSession());
    const user = userEvent.setup();
    renderConsole(<SecuritySettingsPage />);

    await user.click(
      await screen.findByRole('button', { name: message('en', 'admin.twoFactor.email.change') }),
    );
    await user.type(
      await screen.findByLabelText(message('en', 'admin.twoFactor.email.proofLabel')),
      '123456',
    );
    await user.click(
      screen.getByRole('button', { name: message('en', 'admin.twoFactor.email.sendCode') }),
    );

    await expectExpiryScreen();
    expect(screen.queryByText('Not found')).not.toBeInTheDocument();
  });

  test('Security — confirming the emailed code, on the shared enroll form', async () => {
    vi.mocked(api.getTwoFactorStatus).mockResolvedValue(emailOnlyStatus);
    vi.mocked(api.startEmailTwoFactor).mockResolvedValue(undefined);
    vi.mocked(api.confirmEmailTwoFactor).mockRejectedValue(expiredAdminSession());
    const user = userEvent.setup();
    renderConsole(<SecuritySettingsPage />);

    await user.click(
      await screen.findByRole('button', { name: message('en', 'admin.twoFactor.email.change') }),
    );
    await user.type(
      await screen.findByLabelText(message('en', 'admin.twoFactor.email.proofLabel')),
      '123456',
    );
    await user.click(
      screen.getByRole('button', { name: message('en', 'admin.twoFactor.email.sendCode') }),
    );
    await user.type(
      await screen.findByLabelText(message('en', 'admin.twoFactor.email.codeLabel')),
      '123456',
    );
    await user.click(
      screen.getByRole('button', { name: message('en', 'admin.twoFactor.confirmAndEnable') }),
    );

    await expectExpiryScreen();
    expect(screen.queryByText('Not found')).not.toBeInTheDocument();
  });

  test('Feature flags — a kill-switch toggle', async () => {
    vi.mocked(api.getFeatureFlags).mockResolvedValue(featureFlags);
    vi.mocked(api.setFeatureFlag).mockRejectedValue(expiredAdminSession());
    const user = userEvent.setup();
    renderConsole(<FeatureFlagsPage />);

    const buttons = await screen.findAllByRole('button', {
      name: message('en', 'admin.featureFlags.disable'),
    });
    await user.click(buttons[0]!);

    await expectExpiryScreen();
    expect(
      screen.queryByText(message('en', 'admin.featureFlags.actionError')),
    ).not.toBeInTheDocument();
  });

  test('AI settings — the provider save', async () => {
    vi.mocked(api.getAiSettings).mockResolvedValue(aiSettings);
    vi.mocked(api.updateAiSettings).mockRejectedValue(expiredAdminSession());
    const user = userEvent.setup();
    renderConsole(<AiSettingsPage />);

    await user.click(
      await screen.findByRole('button', { name: message('en', 'admin.ai.saveButton') }),
    );

    await expectExpiryScreen();
    expect(screen.queryByText(message('en', 'admin.ai.saveError'))).not.toBeInTheDocument();
  });

  test('Account defaults — the defaults save, in DE', async () => {
    vi.mocked(api.getAccountDefaults).mockResolvedValue(accountDefaults);
    vi.mocked(api.updateAccountDefaults).mockRejectedValue(expiredAdminSession());
    const user = userEvent.setup();
    renderConsole(<AccountDefaultsPage />, 'de');

    await user.click(
      await screen.findByRole('button', { name: message('de', 'admin.accountDefaults.save') }),
    );

    // The notice is catalog copy in both locales — no hardcoded English.
    await expectExpiryScreen('de');
    expect(screen.queryByText(message('de', 'common.genericError'))).not.toBeInTheDocument();
  });
});

test('a rejected TOTP code is a rejected code, not an expired session', async () => {
  // `POST /admin/security/2fa/totp/disable` answers 401 TWO_FACTOR_INVALID_CODE
  // for a mistyped code — which is exactly why this one control keeps its own
  // mapping instead of moving to the write seam, whose 401 is auth loss. A typo
  // must never sign the operator out.
  vi.mocked(api.disableTotp).mockRejectedValue(
    new ApiError(401, 'TWO_FACTOR_INVALID_CODE', 'That two-factor code is incorrect.'),
  );
  const user = userEvent.setup();
  renderConsole(<SecuritySettingsPage />);

  await user.click(
    await screen.findByRole('button', { name: message('en', 'admin.twoFactor.totp.reenroll') }),
  );
  await user.type(
    await screen.findByLabelText(message('en', 'admin.twoFactor.totp.disableCodeLabel')),
    '111111',
  );
  await user.click(
    screen.getByRole('button', { name: message('en', 'admin.twoFactor.totp.disableAndContinue') }),
  );

  expect(await screen.findByText('That two-factor code is incorrect.')).toBeInTheDocument();
  expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
});

test('a rejected enrollment code is a rejected code, not an expired session', async () => {
  // Same split on the shared enroll form: only the bare 404 is the window
  // closing. The confirm step's own refusal keeps the server's own text and
  // leaves the operator where they were, mid-enrollment.
  vi.mocked(api.getTwoFactorStatus).mockResolvedValue(emailOnlyStatus);
  vi.mocked(api.enrollTotp).mockResolvedValue(totpEnrollment);
  vi.mocked(api.confirmTotp).mockRejectedValue(
    new ApiError(400, 'TWO_FACTOR_INVALID_CODE', 'That code is incorrect or has expired.'),
  );
  const user = userEvent.setup();
  renderConsole(<SecuritySettingsPage />);

  await user.click(
    await screen.findByRole('button', { name: message('en', 'admin.twoFactor.totp.setup') }),
  );
  await user.type(
    await screen.findByLabelText(message('en', 'admin.twoFactor.totp.confirmationCodeLabel')),
    '123456',
  );
  await user.click(
    screen.getByRole('button', { name: message('en', 'admin.twoFactor.confirmAndEnable') }),
  );

  expect(await screen.findByText('That code is incorrect or has expired.')).toBeInTheDocument();
  expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
});

describe("useAdminMutation's 404 disposition", () => {
  function MutationProbe({ notFound }: { notFound: 'session' | 'surface' }) {
    const mutation = useAdminMutation(() => api.updateSettings({ betaMode: true }), {
      errorKey: 'admin.settings.saveError',
      notFound,
    });
    return (
      <div>
        <button type="button" onClick={() => void mutation.run()}>
          Run
        </button>
        {mutation.error ? <p>{mutation.error}</p> : null}
      </div>
    );
  }

  test('a row-scoped write still surfaces "row gone" and keeps the session', async () => {
    vi.mocked(api.updateSettings).mockRejectedValue(expiredAdminSession());
    const user = userEvent.setup();
    renderConsole(<MutationProbe notFound="surface" />);

    await user.click(await screen.findByRole('button', { name: 'Run' }));

    expect(await screen.findByText(message('en', 'admin.settings.saveError'))).toBeInTheDocument();
    expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
  });

  test('a no-row-id write treats the 404 as auth loss', async () => {
    vi.mocked(api.updateSettings).mockRejectedValue(expiredAdminSession());
    const user = userEvent.setup();
    renderConsole(<MutationProbe notFound="session" />);

    await user.click(await screen.findByRole('button', { name: 'Run' }));

    await expectExpiryScreen();
  });

  test('a 401 is auth loss under either disposition', async () => {
    vi.mocked(api.updateSettings).mockRejectedValue(
      new ApiError(401, 'UNAUTHENTICATED', 'Authentication required.'),
    );
    const user = userEvent.setup();
    renderConsole(<MutationProbe notFound="surface" />);

    await user.click(await screen.findByRole('button', { name: 'Run' }));

    await expectExpiryScreen();
  });
});

test('a 403 ADMIN_2FA_SETUP_REQUIRED is not collapsed into the expiry', async () => {
  vi.mocked(api.updateSessionPolicy).mockRejectedValue(
    new ApiError(403, ADMIN_2FA_SETUP_REQUIRED, 'Admin two-factor setup required.'),
  );
  const user = userEvent.setup();
  renderConsole(<SecuritySettingsPage />);

  const hours = await screen.findByLabelText(
    message('en', 'admin.security.sessionPolicy.hoursLabel'),
  );
  await user.clear(hours);
  await user.type(hours, '8');
  await user.click(
    screen.getByRole('button', { name: message('en', 'admin.security.sessionPolicy.save') }),
  );

  // The forced-enrollment trap (#400) — which `AdminShell` maps to the wizard —
  // NOT the anonymous sign-out, and no expiry notice anywhere.
  await waitFor(() =>
    expect(screen.getByTestId('status')).toHaveTextContent('two-factor-setup-required'),
  );
  expect(
    screen.queryByText(message('en', 'auth.adminLogin.sessionExpired')),
  ).not.toBeInTheDocument();
});

describe('the read path keeps its own 401-or-404 sign-out', () => {
  function ResourceProbe() {
    const resource = useResource(() => api.getSettings(), []);
    return <p>{resource.data ? 'loaded' : 'no data'}</p>;
  }

  test.each([
    [401, 'UNAUTHENTICATED'],
    [404, 'NOT_FOUND'],
  ])('a %i on a read signs the console out and names the expiry', async (status, code) => {
    vi.mocked(api.getSettings).mockRejectedValue(new ApiError(status, code, 'refused'));
    renderConsole(<ResourceProbe />);

    await expectExpiryScreen();
    // Auth loss, so the sign-out is also a revoke (#1833) — harmless here, since
    // the cookie the server just refused is already dead.
    await waitFor(() => expect(api.logout).toHaveBeenCalledTimes(1));
  });

  test('a domain 404 still ends the surface, but claims no expiry and revokes nothing', async () => {
    // `GET /admin/users/:id` answers USER_NOT_FOUND for an account another admin
    // just deleted. The structural sign-out is pre-existing; what must not happen
    // is the login screen asserting that THIS admin's session window closed —
    // nor, since #1833 added the revoke, DESTROYING a session the server is still
    // perfectly happy with. That row is gone; the session is not, and re-entering
    // password + TOTP because a row went missing is not a sign-out policy.
    vi.mocked(api.getSettings).mockRejectedValue(
      new ApiError(404, 'USER_NOT_FOUND', 'User not found.'),
    );
    renderConsole(<ResourceProbe />);

    expect(
      await screen.findByRole('button', { name: message('en', 'auth.login.submit') }),
    ).toBeVisible();
    expect(
      screen.queryByText(message('en', 'auth.adminLogin.sessionExpired')),
    ).not.toBeInTheDocument();
    expect(api.logout).not.toHaveBeenCalled();
  });
});

describe('the client-held deadline (V5-P13c)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(SESSION_CREATED_AT_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('an idle console reaches the login screen when the window passes, unclicked', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings);
    renderConsole(<SettingsPage />);

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    await waitFor(() => expect(api.listOwnSessions).toHaveBeenCalled());

    // One hour short of the 12 h window: nothing has happened, and the console is
    // still live. No request was made in between — this is the parked console.
    await vi.advanceTimersByTimeAsync(11 * 60 * 60 * 1000);
    expect(screen.getByTestId('status')).toHaveTextContent('authenticated');

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    await expectExpiryScreen();
  });

  test('lowering the lifetime shortens the deadline on the next policy read', async () => {
    const sixHours = { ...sessionPolicy, sessionLifetimeHours: 6 };
    vi.mocked(api.getSettings).mockResolvedValue(settings);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderConsole(<SecuritySettingsPage />);

    const hours = await screen.findByLabelText(
      message('en', 'admin.security.sessionPolicy.hoursLabel'),
    );
    // The console has already computed its deadline off the stored 12 h.
    await waitFor(() => expect(api.listOwnSessions).toHaveBeenCalled());

    // The admin writes the 6 h floor; every later policy read answers 6.
    vi.mocked(api.updateSessionPolicy).mockResolvedValue(sixHours);
    vi.mocked(api.getSessionPolicy).mockResolvedValue(sixHours);
    await user.clear(hours);
    await user.type(hours, '6');
    await user.click(
      screen.getByRole('button', { name: message('en', 'admin.security.sessionPolicy.save') }),
    );
    // The write re-reads the window, so the deadline is now 6 h from `createdAt`.
    expect(
      await screen.findByText(message('en', 'admin.security.sessionPolicy.saved')),
    ).toBeInTheDocument();

    // Seven hours in: past the new window, well inside the old one.
    await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000);

    await expectExpiryScreen();
  });

  test.each([
    // Clock BEHIND the server: the deadline lands further out than the session's
    // own window could reach.
    ['behind by more than a window', SESSION_CREATED_AT_MS - 40 * 60 * 60 * 1000],
    // Clock AHEAD of the server: the deadline is already in the past on the very
    // first evaluation after a successful login. Unguarded, this signed the admin
    // straight back out with "your session expired" and they could never get in.
    ['ahead by more than any window', SESSION_CREATED_AT_MS + 40 * 60 * 60 * 1000],
    // The case a 24 h-wide screen let through: with the 12 h lifetime configured
    // here, a clock 18 h ahead still puts the deadline in the past — but only 6 h
    // in the past, which a band measured against the 24 h policy MAXIMUM accepted.
    // That is the login → "your admin session expired" → login loop.
    ['ahead by less than the widest policy window', SESSION_CREATED_AT_MS + 18 * 60 * 60 * 1000],
  ])('a browser clock %s the server never manufactures a sign-out', async (_direction, now) => {
    vi.setSystemTime(now);
    vi.mocked(api.getSettings).mockResolvedValue(settings);
    renderConsole(<SettingsPage />);

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    await waitFor(() => expect(api.listOwnSessions).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(60 * 1000);

    // The server is the authority in both directions: an unusable deadline is
    // unknown, and the seams still sign out on the next 401/404.
    expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
  });

  test('a 24 h install still arms its deadline when the clock is slightly behind', async () => {
    // The mirror of the screen above: measuring the band against the 24 h policy
    // MAXIMUM meant that on a 24 h-configured install any clock even a little
    // behind the server pushed the deadline past the band, and the courtesy
    // sign-out silently never armed. The band is the session's OWN window plus a
    // tolerance, so a ten-minute clock error still expires the console.
    vi.setSystemTime(SESSION_CREATED_AT_MS - 10 * 60 * 1000);
    vi.mocked(api.getSessionPolicy).mockResolvedValue({
      ...sessionPolicy,
      sessionLifetimeHours: 24,
    });
    vi.mocked(api.getSettings).mockResolvedValue(settings);
    renderConsole(<SettingsPage />);

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    await waitFor(() => expect(api.listOwnSessions).toHaveBeenCalled());

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 11 * 60 * 1000);

    await expectExpiryScreen();
  });

  test('an unreadable window never manufactures a sign-out', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings);
    vi.mocked(api.listOwnSessions).mockRejectedValue(new ApiError(500, 'UNKNOWN', 'unavailable'));
    renderConsole(<SettingsPage />);

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000);

    // The server is the authority; an unknown deadline leaves the console alone
    // and the write/read seams still sign out on the next 401/404.
    expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
  });
  test.each([
    ['a 404 NOT_FOUND from the policy read', 'getSessionPolicy' as const],
    ['a 401 from the session list', 'listOwnSessions' as const],
  ])('%s ends the console session instead of keeping the old deadline', async (_label, call) => {
    // Both reads answer this way the moment the window closes: §6.12 makes the
    // admin route 404, and `GET /auth/sessions` 401s without a session. Swallowed,
    // they left the console `authenticated` with the OLD deadline armed.
    vi.mocked(api[call]).mockRejectedValue(
      call === 'getSessionPolicy'
        ? expiredAdminSession()
        : new ApiError(401, 'UNAUTHENTICATED', 'refused'),
    );
    vi.mocked(api.getSettings).mockResolvedValue(settings);
    renderConsole(<SettingsPage />);

    await expectExpiryScreen();
    // And it is a real sign-out, not just a local one.
    await waitFor(() => expect(api.logout).toHaveBeenCalled());
  });

  test('lowering the lifetime below this session\u2019s age lands on the expiry screen, not a success toast', async () => {
    // The card's own flow, seven hours into a 12 h window: the PATCH succeeds
    // against the pre-write value, and every read after it 404s because the new
    // 6 h window is already behind this session's age. Before #1833 that painted
    // a green "Session lifetime updated." over a dead session, left a full page
    // of admin data rendered, and kept the timer armed for the old 12 h.
    vi.setSystemTime(SESSION_CREATED_AT_MS + 7 * 60 * 60 * 1000);
    vi.mocked(api.getSettings).mockResolvedValue(settings);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderConsole(<SecuritySettingsPage />);

    const hours = await screen.findByLabelText(
      message('en', 'admin.security.sessionPolicy.hoursLabel'),
    );
    await waitFor(() => expect(api.listOwnSessions).toHaveBeenCalled());

    vi.mocked(api.updateSessionPolicy).mockResolvedValue({
      ...sessionPolicy,
      sessionLifetimeHours: 6,
    });
    vi.mocked(api.getSessionPolicy).mockRejectedValue(expiredAdminSession());
    vi.mocked(api.listOwnSessions).mockRejectedValue(expiredAdminSession());
    await user.clear(hours);
    await user.type(hours, '6');
    await user.click(
      screen.getByRole('button', { name: message('en', 'admin.security.sessionPolicy.save') }),
    );

    // Immediately — no timer advance. The old behaviour only bounced at 12 h.
    await expectExpiryScreen();
    expect(
      screen.queryByText(message('en', 'admin.security.sessionPolicy.saved')),
    ).not.toBeInTheDocument();
  });

  test('the courtesy sign-out revokes the session instead of leaving it live', async () => {
    // The deadline may fire up to CLOCK_TOLERANCE_MS early on a browser clock
    // running ahead. Without a revoke the operator was shown "your admin session
    // expired" while the cookie and the Redis session were both intact, and a
    // single reload re-bootstrapped straight back into the console.
    vi.mocked(api.getSettings).mockResolvedValue(settings);
    renderConsole(<SettingsPage />);

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    await waitFor(() => expect(api.listOwnSessions).toHaveBeenCalled());
    expect(api.logout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
    await expectExpiryScreen();
    // The revoke itself is the claim: `POST /auth/logout` destroys the session
    // record, so a reload has nothing left to bootstrap from. What the server
    // then answers `GET /me` with is the server's own contract, verified in the
    // API suite — mocking it here would only assert the mock.
    await waitFor(() => expect(api.logout).toHaveBeenCalledTimes(1));
  });
});
