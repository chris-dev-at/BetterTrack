import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { MeResponse, TwoFactorChallengeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/userApi');
vi.mock('../../lib/portfolioApi');
vi.mock('../../lib/oauthApi');
vi.mock('../../lib/workboardApi', () => ({
  WORKBOARD_QUERY_KEY: ['workboard'],
  listWorkboard: vi.fn(),
  addToWorkboard: vi.fn(),
  removeFromWorkboard: vi.fn(),
  reorderWorkboard: vi.fn(),
}));

import { ApiError } from '../../lib/apiClient';
import * as oauthApi from '../../lib/oauthApi';
import * as api from '../../lib/userApi';
import { listWorkboard } from '../../lib/workboardApi';
import { UserApp } from '../UserApp';

// A representative OAuth authorize URL, as RequireUser stashes it in state.from
// when it bounces an anonymous visitor to /login (V4-P2b, §399 §A).
const OAUTH_FROM =
  '/oauth/authorize?client_id=app&redirect_uri=https%3A%2F%2Fx.example&scope=portfolio%3Aread';

const user: MeResponse = {
  id: 'user-1',
  email: 'jane@bettertrack.test',
  username: 'jane',
  role: 'user',
  status: 'active',
  mustChangePassword: false,
  pinEnabled: false,
  pinLockIdleMinutes: null,
  baseCurrency: 'EUR',
  locale: 'en',
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const challenge: TwoFactorChallengeResponse = {
  twoFactorRequired: true,
  pendingToken: 'pending-token-1',
  channels: ['totp', 'email', 'recovery'],
};

function renderApp() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/*" element={<UserApp />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Render the app landing on `/login` with a stashed `state.from` (e.g. an OAuth URL). */
function renderAppAt(entry: { pathname: string; state?: unknown }) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/*" element={<UserApp />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  // The remember-me record + "asked" flag live in localStorage — isolate them.
  localStorage.clear();
  // Anonymous to start: the bootstrap /auth/me rejects, so the app shows /login.
  vi.mocked(api.getMe).mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'nope'));
  vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
  // The login screen reads the active registration mode to decide whether to
  // offer a "create an account" link (§13.4 V4-P4a) — default to closed.
  vi.mocked(api.getRegistrationInfo).mockResolvedValue({ mode: 'closed', googleEnabled: false });
});

// ── OAuth account memory + PIN quick re-auth: the chooser state ladder (§399 §B) ─

const pinUser: MeResponse = { ...user, pinEnabled: true };
const REMEMBERED_KEY = 'bettertrack.oauthRemembered';
const ASKED_KEY = 'bettertrack.oauthRememberAsked';

/** Seed the device-level remembered identity that drives the chooser. */
function rememberJane() {
  localStorage.setItem(
    REMEMBERED_KEY,
    JSON.stringify({ userId: 'user-1', username: 'jane', avatarUrl: null }),
  );
}

/** Fill the four PIN boxes; the fourth digit auto-submits (no button). */
function typePin(pin: string) {
  const labels = ['PIN', 'PIN digit 2', 'PIN digit 3', 'PIN digit 4'];
  for (let i = 0; i < labels.length; i += 1) {
    fireEvent.change(screen.getByLabelText(labels[i] as string), { target: { value: pin[i] } });
  }
}

async function submitPassword() {
  const u = userEvent.setup();
  renderApp();
  await screen.findByText('Sign in to your account');
  await u.type(screen.getByLabelText('Email or username'), 'jane');
  await u.type(screen.getByLabelText('Password'), 'jane-strong-password-1');
  await u.click(screen.getByRole('button', { name: 'Sign in' }));
  return u;
}

test('a 2FA account is shown the challenge step after the password, then lands in the app', async () => {
  vi.mocked(api.login).mockResolvedValue(challenge);
  vi.mocked(api.verifyTwoFactor).mockResolvedValue(user);

  const u = await submitPassword();

  // The challenge step is up — not the app yet.
  expect(await screen.findByText('Two-factor authentication')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();

  await u.type(screen.getByLabelText('Verification code'), '123456');
  await u.click(screen.getByRole('button', { name: 'Verify' }));

  // A verified factor completes login into the app.
  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(api.verifyTwoFactor).toHaveBeenCalledWith({
    pendingToken: 'pending-token-1',
    code: '123456',
  });
});

test('the challenge step can request an email code', async () => {
  vi.mocked(api.login).mockResolvedValue(challenge);
  vi.mocked(api.requestTwoFactorEmailCode).mockResolvedValue();

  const u = await submitPassword();
  await screen.findByText('Two-factor authentication');

  await u.click(screen.getByRole('button', { name: 'Email me a code' }));

  expect(api.requestTwoFactorEmailCode).toHaveBeenCalledWith({ pendingToken: 'pending-token-1' });
  expect(await screen.findByText(/sign-in code is on its way/i)).toBeInTheDocument();
});

test('the challenge step can switch to a recovery code', async () => {
  vi.mocked(api.login).mockResolvedValue(challenge);
  vi.mocked(api.verifyTwoFactor).mockResolvedValue(user);

  const u = await submitPassword();
  await screen.findByText('Two-factor authentication');

  await u.click(screen.getByRole('button', { name: 'Use a recovery code' }));
  await u.type(screen.getByLabelText('Recovery code'), 'abcd-efgh-ijkl-mnop');
  await u.click(screen.getByRole('button', { name: 'Verify' }));

  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(api.verifyTwoFactor).toHaveBeenCalledWith({
    pendingToken: 'pending-token-1',
    recoveryCode: 'abcd-efgh-ijkl-mnop',
  });
});

test('a wrong code shows an in-form error and stays on the challenge step', async () => {
  vi.mocked(api.login).mockResolvedValue(challenge);
  vi.mocked(api.verifyTwoFactor).mockRejectedValue(
    new ApiError(401, 'TWO_FACTOR_INVALID_CODE', 'nope'),
  );

  const u = await submitPassword();
  await screen.findByText('Two-factor authentication');

  await u.type(screen.getByLabelText('Verification code'), '000000');
  await u.click(screen.getByRole('button', { name: 'Verify' }));

  expect(await screen.findByText(/incorrect or has expired/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();
});

test('an account without 2FA logs straight into the app', async () => {
  vi.mocked(api.login).mockResolvedValue(user);

  await submitPassword();

  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(screen.queryByText('Two-factor authentication')).not.toBeInTheDocument();
});

// ── Stay signed in + OAuth persistence rules (V4-P2b, §399 §A) ────────────────

test('the login form shows a Stay-signed-in checkbox ticked by default; unticking sends staySignedIn:false', async () => {
  vi.mocked(api.login).mockResolvedValue(user);

  const u = userEvent.setup();
  renderApp();
  await screen.findByText('Sign in to your account');

  const stay = screen.getByLabelText('Stay signed in');
  expect(stay).toBeChecked();
  await u.click(stay); // untick → ephemeral

  await u.type(screen.getByLabelText('Email or username'), 'jane');
  await u.type(screen.getByLabelText('Password'), 'jane-strong-password-1');
  await u.click(screen.getByRole('button', { name: 'Sign in' }));

  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(api.login).toHaveBeenCalledWith(
    expect.objectContaining({ staySignedIn: false, oauthLogin: false }),
  );
});

test('an OAuth login shows no stay-signed-in checkbox and, without a PIN, never prompts to persist', async () => {
  vi.mocked(api.login).mockResolvedValue(user); // pinEnabled: false
  // Keep the consent screen loading so we can assert we advanced past login.
  vi.mocked(oauthApi.getAuthorizationDetails).mockReturnValue(new Promise(() => {}));

  const u = userEvent.setup();
  renderAppAt({ pathname: '/login', state: { from: OAUTH_FROM } });
  await screen.findByText('Sign in to your account');

  // No "stay signed in" checkbox on the OAuth login form (PIN unknown yet).
  expect(screen.queryByLabelText('Stay signed in')).not.toBeInTheDocument();

  await u.type(screen.getByLabelText('Email or username'), 'jane');
  await u.type(screen.getByLabelText('Password'), 'jane-strong-password-1');
  await u.click(screen.getByRole('button', { name: 'Sign in' }));

  // A PIN-less OAuth login goes straight on to consent — never a persist prompt.
  expect(await screen.findByText('Loading authorization request…')).toBeInTheDocument();
  expect(api.login).toHaveBeenCalledWith(
    expect.objectContaining({ oauthLogin: true, staySignedIn: false }),
  );
  expect(screen.queryByLabelText(/stay signed in on this browser/i)).not.toBeInTheDocument();
});

test('an OAuth login on a PIN account offers the "stay signed in — your PIN protects this" choice', async () => {
  vi.mocked(api.login).mockResolvedValue({ ...user, pinEnabled: true });

  const u = userEvent.setup();
  renderAppAt({ pathname: '/login', state: { from: OAUTH_FROM } });
  await screen.findByText('Sign in to your account');

  await u.type(screen.getByLabelText('Email or username'), 'jane');
  await u.type(screen.getByLabelText('Password'), 'jane-strong-password-1');
  await u.click(screen.getByRole('button', { name: 'Sign in' }));

  // The PIN-dependent choice appears post-credential-entry, with the messaging.
  expect(await screen.findByLabelText(/stay signed in on this browser/i)).toBeInTheDocument();
  expect(screen.getByText(/your PIN still protects your account/i)).toBeInTheDocument();
  // The app hasn't opened — we're still deciding persistence.
  expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();
});

test('opting into "stay signed in" on the OAuth persist step promotes the session, then proceeds', async () => {
  vi.mocked(api.login).mockResolvedValue({ ...user, pinEnabled: true });
  vi.mocked(api.persistSession).mockResolvedValue();
  vi.mocked(oauthApi.getAuthorizationDetails).mockReturnValue(new Promise(() => {}));

  const u = userEvent.setup();
  renderAppAt({ pathname: '/login', state: { from: OAUTH_FROM } });
  await screen.findByText('Sign in to your account');

  await u.type(screen.getByLabelText('Email or username'), 'jane');
  await u.type(screen.getByLabelText('Password'), 'jane-strong-password-1');
  await u.click(screen.getByRole('button', { name: 'Sign in' }));

  const stay = await screen.findByLabelText(/stay signed in on this browser/i);
  await u.click(stay);
  await u.click(screen.getByRole('button', { name: 'Continue' }));

  await waitFor(() => expect(api.persistSession).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('Loading authorization request…')).toBeInTheDocument();
});

test('a persist failure on the OAuth step does not strand the flow — it proceeds to consent (V4-P2b)', async () => {
  vi.mocked(api.login).mockResolvedValue({ ...user, pinEnabled: true });
  // Promotion rejects — the session is live (ephemeral) regardless, so the
  // authorize flow must fall through to consent rather than block on the step.
  vi.mocked(api.persistSession).mockRejectedValue(new ApiError(500, 'INTERNAL', 'nope'));
  vi.mocked(oauthApi.getAuthorizationDetails).mockReturnValue(new Promise(() => {}));

  const u = userEvent.setup();
  renderAppAt({ pathname: '/login', state: { from: OAUTH_FROM } });
  await screen.findByText('Sign in to your account');

  await u.type(screen.getByLabelText('Email or username'), 'jane');
  await u.type(screen.getByLabelText('Password'), 'jane-strong-password-1');
  await u.click(screen.getByRole('button', { name: 'Sign in' }));

  const stay = await screen.findByLabelText(/stay signed in on this browser/i);
  await u.click(stay);
  await u.click(screen.getByRole('button', { name: 'Continue' }));

  await waitFor(() => expect(api.persistSession).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('Loading authorization request…')).toBeInTheDocument();
});

// ── State ladder (§399 §B, owner refinement 2026-07-10) ──────────────────────

test('state ladder (1): a valid PIN-gated session shows the PIN gate, never the chooser', async () => {
  rememberJane(); // even with a device identity remembered…
  // …a live PIN-gated session wins: UserShell traps at the PIN gate above routing.
  vi.mocked(api.getMe).mockResolvedValue(pinUser);
  render(
    <MemoryRouter initialEntries={[OAUTH_FROM]}>
      <Routes>
        <Route path="/*" element={<UserApp />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(await screen.findByRole('heading', { name: 'Enter your PIN' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /log in as jane/i })).not.toBeInTheDocument();
});

test('state ladder (2): no session + a remembered identity shows the chooser', async () => {
  rememberJane();
  renderAppAt({ pathname: '/login', state: { from: OAUTH_FROM } });
  expect(await screen.findByRole('button', { name: /log in as jane/i })).toBeInTheDocument();
  // Not the blank login form.
  expect(screen.queryByLabelText('Email or username')).not.toBeInTheDocument();
});

test('state ladder (3): nothing remembered shows a blank login', async () => {
  renderAppAt({ pathname: '/login', state: { from: OAUTH_FROM } });
  expect(await screen.findByText('Sign in to your account')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /log in as/i })).not.toBeInTheDocument();
});

test('chooser: "Log in as" → PIN-only entry completes login + authorize, no password', async () => {
  rememberJane();
  vi.mocked(api.quickAuthPin)
    .mockResolvedValueOnce({ pinRequired: true }) // probe: the ~15-min window is closed
    .mockResolvedValueOnce(pinUser); // PIN verify: signed in
  vi.mocked(oauthApi.getAuthorizationDetails).mockReturnValue(new Promise(() => {}));

  const u = userEvent.setup();
  renderAppAt({ pathname: '/login', state: { from: OAUTH_FROM } });
  await u.click(await screen.findByRole('button', { name: /log in as jane/i }));

  // Window closed → the PIN input appears; a password field is never shown.
  await screen.findByLabelText('PIN');
  expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  expect(api.login).not.toHaveBeenCalled();

  typePin('4242');
  expect(await screen.findByText('Loading authorization request…')).toBeInTheDocument();
  expect(api.quickAuthPin).toHaveBeenNthCalledWith(2, { pin: '4242' });
  expect(api.login).not.toHaveBeenCalled();
});

test('chooser: within the ~15-min window, tapping the name auto-logs-in — chooser still shown', async () => {
  rememberJane();
  vi.mocked(api.quickAuthPin).mockResolvedValue(pinUser); // probe auto-passes
  vi.mocked(oauthApi.getAuthorizationDetails).mockReturnValue(new Promise(() => {}));

  const u = userEvent.setup();
  renderAppAt({ pathname: '/login', state: { from: OAUTH_FROM } });
  // The chooser step WAS shown (never auto-skipped) — we must tap the name.
  await u.click(await screen.findByRole('button', { name: /log in as jane/i }));

  // Auto-pass: straight to consent from a PIN-less probe, no PIN input.
  expect(await screen.findByText('Loading authorization request…')).toBeInTheDocument();
  expect(api.quickAuthPin).toHaveBeenCalledWith({});
  expect(screen.queryByLabelText('PIN')).not.toBeInTheDocument();
});

test('chooser: "Another account" forgets the identity and drops to a blank login', async () => {
  rememberJane();
  vi.mocked(api.forgetRememberedDevice).mockResolvedValue();

  const u = userEvent.setup();
  renderAppAt({ pathname: '/login', state: { from: OAUTH_FROM } });
  await u.click(await screen.findByRole('button', { name: 'Another account' }));

  expect(await screen.findByText('Sign in to your account')).toBeInTheDocument();
  expect(api.forgetRememberedDevice).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem(REMEMBERED_KEY)).toBeNull();
  expect(api.quickAuthPin).not.toHaveBeenCalled();
});

// ── Remember-me prompt (§399 §B) ─────────────────────────────────────────────

test('remember-me: an OAuth login on a PIN account offers the one-time remember-me choice', async () => {
  vi.mocked(api.login).mockResolvedValue(pinUser);

  const u = userEvent.setup();
  renderAppAt({ pathname: '/login', state: { from: OAUTH_FROM } });
  await screen.findByText('Sign in to your account');
  await u.type(screen.getByLabelText('Email or username'), 'jane');
  await u.type(screen.getByLabelText('Password'), 'jane-strong-password-1');
  await u.click(screen.getByRole('button', { name: 'Sign in' }));

  // Both the #418 stay-signed-in and the new #419 remember-me choices appear.
  expect(await screen.findByLabelText(/stay signed in on this browser/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/remember me on this device/i)).toBeInTheDocument();
});

test('remember-me: ticking it binds the device and stores the local chooser record', async () => {
  vi.mocked(api.login).mockResolvedValue(pinUser);
  vi.mocked(api.rememberDevice).mockResolvedValue({
    userId: 'user-1',
    username: 'jane',
    avatarUrl: null,
  });
  vi.mocked(oauthApi.getAuthorizationDetails).mockReturnValue(new Promise(() => {}));

  const u = userEvent.setup();
  renderAppAt({ pathname: '/login', state: { from: OAUTH_FROM } });
  await screen.findByText('Sign in to your account');
  await u.type(screen.getByLabelText('Email or username'), 'jane');
  await u.type(screen.getByLabelText('Password'), 'jane-strong-password-1');
  await u.click(screen.getByRole('button', { name: 'Sign in' }));

  await u.click(await screen.findByLabelText(/remember me on this device/i));
  await u.click(screen.getByRole('button', { name: 'Continue' }));

  await waitFor(() => expect(api.rememberDevice).toHaveBeenCalledTimes(1));
  expect(localStorage.getItem(REMEMBERED_KEY)).toContain('jane');
  expect(await screen.findByText('Loading authorization request…')).toBeInTheDocument();
});

test('remember-me: shown once — hidden after this device already asked the user', async () => {
  localStorage.setItem(ASKED_KEY, JSON.stringify(['user-1']));
  vi.mocked(api.login).mockResolvedValue(pinUser);

  const u = userEvent.setup();
  renderAppAt({ pathname: '/login', state: { from: OAUTH_FROM } });
  await screen.findByText('Sign in to your account');
  await u.type(screen.getByLabelText('Email or username'), 'jane');
  await u.type(screen.getByLabelText('Password'), 'jane-strong-password-1');
  await u.click(screen.getByRole('button', { name: 'Sign in' }));

  // The persist step still appears (stay-signed-in), but not the remember-me box.
  expect(await screen.findByLabelText(/stay signed in on this browser/i)).toBeInTheDocument();
  expect(screen.queryByLabelText(/remember me on this device/i)).not.toBeInTheDocument();
});

test('remember-me: a PIN-less OAuth login is never prompted to remember', async () => {
  vi.mocked(api.login).mockResolvedValue(user); // pinEnabled: false
  vi.mocked(oauthApi.getAuthorizationDetails).mockReturnValue(new Promise(() => {}));

  const u = userEvent.setup();
  renderAppAt({ pathname: '/login', state: { from: OAUTH_FROM } });
  await screen.findByText('Sign in to your account');
  await u.type(screen.getByLabelText('Email or username'), 'jane');
  await u.type(screen.getByLabelText('Password'), 'jane-strong-password-1');
  await u.click(screen.getByRole('button', { name: 'Sign in' }));

  // No PIN → straight to consent; never a remember-me (nor stay-signed-in) step.
  expect(await screen.findByText('Loading authorization request…')).toBeInTheDocument();
  expect(screen.queryByLabelText(/remember me on this device/i)).not.toBeInTheDocument();
  expect(api.rememberDevice).not.toHaveBeenCalled();
});

test('chooser: a stale/forgotten server binding falls back to a blank login', async () => {
  rememberJane();
  vi.mocked(api.quickAuthPin).mockRejectedValue(
    new ApiError(401, 'REMEMBER_DEVICE_UNKNOWN', 'This device is not remembered.'),
  );
  vi.mocked(api.forgetRememberedDevice).mockResolvedValue();

  const u = userEvent.setup();
  renderAppAt({ pathname: '/login', state: { from: OAUTH_FROM } });
  await u.click(await screen.findByRole('button', { name: /log in as jane/i }));

  // The dead memory is dropped and the flow falls through to a blank login.
  expect(await screen.findByText('Sign in to your account')).toBeInTheDocument();
  expect(api.forgetRememberedDevice).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem(REMEMBERED_KEY)).toBeNull();
});

test('chooser: a wrong PIN shows an error and stays on the PIN step', async () => {
  rememberJane();
  vi.mocked(api.quickAuthPin)
    .mockResolvedValueOnce({ pinRequired: true })
    .mockRejectedValueOnce(new ApiError(401, 'INVALID_PIN', 'Incorrect PIN.'));

  const u = userEvent.setup();
  renderAppAt({ pathname: '/login', state: { from: OAUTH_FROM } });
  await u.click(await screen.findByRole('button', { name: /log in as jane/i }));
  await screen.findByLabelText('PIN');

  typePin('0000');
  expect(await screen.findByText('Incorrect PIN. Please try again.')).toBeInTheDocument();
  // Still on the PIN step (boxes cleared and remounted), never a password field.
  expect(screen.getByLabelText('PIN')).toBeInTheDocument();
  expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
});

// ── Always-on username memory (V4-P0 (g)) ────────────────────────────────────
const LAST_IDENTIFIER_KEY = 'bettertrack.lastLoginIdentifier';

test('a successful login stores the identifier for prefill on the next visit', async () => {
  vi.mocked(api.login).mockResolvedValue(user);

  const u = userEvent.setup();
  renderApp();
  await screen.findByText('Sign in to your account');

  // The blank login form on a fresh device has NO toggle for username memory —
  // memory is always on (V4-P0 (g) supersedes any prior opt-in control).
  expect(screen.queryByLabelText(/remember me/i)).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/remember username/i)).not.toBeInTheDocument();

  await u.type(screen.getByLabelText('Email or username'), 'jane@bettertrack.test');
  await u.type(screen.getByLabelText('Password'), 'jane-strong-password-1');
  await u.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('button', { name: 'Account menu' });

  // Whatever the user typed is persisted verbatim (email or username).
  expect(localStorage.getItem(LAST_IDENTIFIER_KEY)).toBe('jane@bettertrack.test');
});

test('the identifier prefills from the last successful login on the next visit', async () => {
  localStorage.setItem(LAST_IDENTIFIER_KEY, 'jane@bettertrack.test');

  renderApp();
  const field = (await screen.findByLabelText('Email or username')) as HTMLInputElement;
  expect(field.value).toBe('jane@bettertrack.test');
});

test('a bad password does NOT overwrite the remembered identifier', async () => {
  localStorage.setItem(LAST_IDENTIFIER_KEY, 'previous@bettertrack.test');
  vi.mocked(api.login).mockRejectedValue(
    new ApiError(401, 'INVALID_CREDENTIALS', 'Incorrect email/username or password.'),
  );

  const u = userEvent.setup();
  renderApp();
  const field = (await screen.findByLabelText('Email or username')) as HTMLInputElement;
  // Prefilled from the earlier successful login; the user overwrites it and mistypes.
  await u.clear(field);
  await u.type(field, 'someoneelse@bettertrack.test');
  await u.type(screen.getByLabelText('Password'), 'wrong-password');
  await u.click(screen.getByRole('button', { name: 'Sign in' }));

  await screen.findByText(/incorrect email\/username or password/i);
  // Memory was not clobbered by the failed attempt — the last SUCCESSFUL
  // identifier still wins on the next visit.
  expect(localStorage.getItem(LAST_IDENTIFIER_KEY)).toBe('previous@bettertrack.test');
});

// ── Prominent Sign-up treatment (V4-P0 (f)) ──────────────────────────────────

test('the login screen exposes a designed Sign-up entry alongside the sign-in form', async () => {
  vi.mocked(api.getRegistrationInfo).mockResolvedValue({ mode: 'open', googleEnabled: false });
  renderApp();
  await screen.findByText('Sign in to your account');

  // A prominent "Sign up" link — no more bottom-anchor "Create one" prose.
  const signUp = await screen.findByRole('link', { name: 'Sign up' });
  expect(signUp).toHaveAttribute('href', '/register');
  expect(screen.queryByText(/create one/i)).not.toBeInTheDocument();
});

test('the Sign-up entry is hidden when the instance keeps registration closed', async () => {
  vi.mocked(api.getRegistrationInfo).mockResolvedValue({ mode: 'closed', googleEnabled: false });
  renderApp();
  await screen.findByText('Sign in to your account');

  expect(screen.queryByRole('link', { name: 'Sign up' })).not.toBeInTheDocument();
});
