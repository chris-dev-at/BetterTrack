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
 *     never turned into a sign-out.
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
    vi.mocked(api.listRegistrationTokens).mockResolvedValue({ tokens: [] });
    vi.mocked(api.listRegistrationRequests).mockResolvedValue({ requests: [] });
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
  });

  test('a domain 404 still ends the surface, but claims no expiry', async () => {
    // `GET /admin/users/:id` answers USER_NOT_FOUND for an account another admin
    // just deleted. The structural sign-out is pre-existing; what must not happen
    // is the login screen asserting that THIS admin's session window closed.
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
    // Clock BEHIND the server: the deadline lands further out than any policy
    // window could reach. Already guarded.
    ['behind', SESSION_CREATED_AT_MS - 40 * 60 * 60 * 1000],
    // Clock AHEAD of the server: the deadline is already in the past on the very
    // first evaluation after a successful login. Unguarded, this signed the admin
    // straight back out with "your session expired" and they could never get in.
    ['ahead', SESSION_CREATED_AT_MS + 40 * 60 * 60 * 1000],
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
});
