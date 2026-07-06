import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';

import type { TwoFactorChallengeResponse } from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import { AdminAccountError, useAuth } from '../AuthContext';
import { Alert, AuthCard, Button, Spinner, TextField } from '../components/ui';

/** Where to land after a successful sign-in: the intended route, else home. */
function intendedPath(state: unknown): string {
  if (state && typeof state === 'object' && 'from' in state) {
    const from = (state as { from?: unknown }).from;
    if (typeof from === 'string' && from.startsWith('/') && !from.startsWith('//')) return from;
  }
  return '/';
}

/**
 * Public sign-in (PROJECTPLAN.md §6.1, §7.2). Email-or-username + password; a
 * single generic error on failure (no user enumeration); returns the user to
 * the route they were headed for. The session is established by the cookie the
 * API sets on success. When the account has 2FA enabled the password step hands
 * back a challenge instead of a session (§13.2 V2-P5); {@link TwoFactorStep}
 * collects the second factor before the app opens.
 */
export function LoginPage() {
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = intendedPath(location.state);

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Non-null once the password step returns a 2FA challenge: swaps the password
  // form for the second-factor step.
  const [challenge, setChallenge] = useState<TwoFactorChallengeResponse | null>(null);

  if (status === 'loading') {
    return (
      <div className="grid min-h-screen place-items-center bg-[#0b0e14]">
        <Spinner label="Checking session…" />
      </div>
    );
  }
  if (status === 'authenticated') return <Navigate to={from} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const outcome = await login({ identifier, password });
      if (outcome.status === 'two_factor_required') {
        // Password verified but 2FA is on — collect the second factor next.
        setChallenge(outcome.challenge);
        return;
      }
      // On a forced-change account the app traps into the change screen
      // regardless of this navigation; for a normal account we land on `from`.
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        // Rate-limited: show a dedicated message distinct from bad-credentials (§6.1).
        const wait = err.retryAfterSeconds
          ? ` Please wait ${err.retryAfterSeconds} second${err.retryAfterSeconds === 1 ? '' : 's'} and try again.`
          : ' Please wait a moment and try again.';
        setError(`Too many login attempts.${wait}`);
      } else if (err instanceof AdminAccountError) {
        // Admin credentials on the user app: point them at the admin area (§10).
        setError(err.message);
      } else if (err instanceof ApiError && err.status === 403 && err.code === 'ACCOUNT_DISABLED') {
        // Correct password but the account is suspended: a distinct message,
        // separate from bad-credentials and the rate-limit notice (§6.1, §16).
        setError('This account has been suspended. Please contact the administrator.');
      } else if (err instanceof ApiError && err.status >= 500) {
        setError('Something went wrong. Please try again.');
      } else {
        // Never distinguish "no such user" from "wrong password" (§6.1).
        setError('Incorrect email/username or password.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (challenge) {
    return (
      <TwoFactorStep
        challenge={challenge}
        onVerified={() => navigate(from, { replace: true })}
        onCancel={() => {
          // Bail back to the password form — the pending challenge simply lapses.
          setChallenge(null);
          setPassword('');
          setError(null);
        }}
      />
    );
  }

  return (
    <AuthCard subtitle="Sign in to your account">
      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6"
      >
        {error ? <Alert tone="error">{error}</Alert> : null}
        <TextField
          label="Email or username"
          name="identifier"
          autoComplete="username"
          autoFocus
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          required
        />
        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </Button>
        <Link
          to="/forgot-password"
          className="text-center text-sm font-medium text-sky-400 hover:text-sky-300"
        >
          Forgot password?
        </Link>
      </form>
    </AuthCard>
  );
}

/**
 * Login-time 2FA challenge step (§6.1, §13.2 V2-P5). Enter the authenticator
 * (TOTP) code or an emailed code, request an email code, or switch to a recovery
 * code. A valid factor promotes the pending challenge to a full session and the
 * app opens.
 */
export function TwoFactorStep({
  challenge,
  onVerified,
  onCancel,
  cancelLabel = 'Back to sign in',
}: {
  challenge: TwoFactorChallengeResponse;
  onVerified: () => void;
  onCancel: () => void;
  cancelLabel?: string;
}) {
  const { verifyTwoFactor, requestTwoFactorEmailCode } = useAuth();
  const totpAvailable = challenge.channels.includes('totp');
  const emailAvailable = challenge.channels.includes('email');
  const recoveryAvailable = challenge.channels.includes('recovery');

  // Tailor the prompt to the methods this account actually enabled (#298).
  const codePrompt = totpAvailable
    ? emailAvailable
      ? 'Enter the 6-digit code from your authenticator app, or request an emailed code below.'
      : 'Enter the 6-digit code from your authenticator app.'
    : 'Enter the 6-digit code we emailed you.';

  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setSubmitting(true);
    try {
      await verifyTwoFactor(
        useRecovery
          ? { pendingToken: challenge.pendingToken, recoveryCode: value.trim() }
          : { pendingToken: challenge.pendingToken, code: value.trim() },
      );
      onVerified();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError('Too many incorrect codes. Please wait a moment and try again.');
      } else if (err instanceof ApiError && err.code === 'TWO_FACTOR_PENDING_INVALID') {
        setError('Your verification session expired. Please sign in again.');
      } else {
        setError('That code is incorrect or has expired.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function onEmailCode() {
    setError(null);
    setInfo(null);
    setSendingCode(true);
    try {
      await requestTwoFactorEmailCode({ pendingToken: challenge.pendingToken });
      setInfo('If email is configured, a sign-in code is on its way. Enter it below.');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TWO_FACTOR_PENDING_INVALID') {
        setError('Your verification session expired. Please sign in again.');
      } else {
        setError('Could not send an email code. Try your authenticator or a recovery code.');
      }
    } finally {
      setSendingCode(false);
    }
  }

  return (
    <AuthCard subtitle="Two-factor authentication">
      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6"
      >
        {error ? <Alert tone="error">{error}</Alert> : null}
        {info ? <Alert tone="info">{info}</Alert> : null}
        <p className="text-sm text-neutral-400">
          {useRecovery ? 'Enter one of your recovery codes.' : codePrompt}
        </p>
        <TextField
          label={useRecovery ? 'Recovery code' : 'Verification code'}
          name={useRecovery ? 'recoveryCode' : 'code'}
          autoComplete="one-time-code"
          inputMode={useRecovery ? 'text' : 'numeric'}
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
        />
        <Button type="submit" disabled={submitting || value.trim().length === 0}>
          {submitting ? 'Verifying…' : 'Verify'}
        </Button>
        {emailAvailable && !useRecovery ? (
          <Button type="button" variant="secondary" onClick={onEmailCode} disabled={sendingCode}>
            {sendingCode ? 'Sending…' : 'Email me a code'}
          </Button>
        ) : null}
        {recoveryAvailable ? (
          <button
            type="button"
            className="text-center text-sm font-medium text-sky-400 hover:text-sky-300"
            onClick={() => {
              setUseRecovery((v) => !v);
              setValue('');
              setError(null);
              setInfo(null);
            }}
          >
            {useRecovery ? 'Use an authenticator or email code' : 'Use a recovery code'}
          </button>
        ) : null}
        <button
          type="button"
          className="text-center text-sm font-medium text-neutral-400 hover:text-neutral-200"
          onClick={onCancel}
        >
          {cancelLabel}
        </button>
      </form>
    </AuthCard>
  );
}
