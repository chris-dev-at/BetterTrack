import { render, screen, waitFor } from '@testing-library/react';
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
  // Anonymous to start: the bootstrap /auth/me rejects, so the app shows /login.
  vi.mocked(api.getMe).mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'nope'));
  vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
});

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
