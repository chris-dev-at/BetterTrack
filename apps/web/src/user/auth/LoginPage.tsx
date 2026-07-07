import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';

import type { TwoFactorChallengeResponse } from '@bettertrack/contracts';

import { useT } from '../../i18n';
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
  const t = useT();
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
        <Spinner label={t('auth.common.checkingSession')} />
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
          ? t(
              err.retryAfterSeconds === 1
                ? 'auth.common.waitSecondsOne'
                : 'auth.common.waitSecondsOther',
              {
                count: err.retryAfterSeconds,
              },
            )
          : t('auth.common.waitMoment');
        setError(`${t('auth.login.rateLimited')}${wait}`);
      } else if (err instanceof AdminAccountError) {
        // Admin credentials on the user app: point them at the admin area (§10).
        setError(err.message);
      } else if (err instanceof ApiError && err.status === 403 && err.code === 'ACCOUNT_DISABLED') {
        // Correct password but the account is suspended: a distinct message,
        // separate from bad-credentials and the rate-limit notice (§6.1, §16).
        setError(t('auth.login.accountDisabled'));
      } else if (err instanceof ApiError && err.status >= 500) {
        setError(t('common.genericError'));
      } else {
        // Never distinguish "no such user" from "wrong password" (§6.1).
        setError(t('auth.login.invalidCredentials'));
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
    <AuthCard subtitle={t('auth.login.subtitle')}>
      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6"
      >
        {error ? <Alert tone="error">{error}</Alert> : null}
        <TextField
          label={t('auth.login.identifierLabel')}
          name="identifier"
          autoComplete="username"
          autoFocus
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          required
        />
        <TextField
          label={t('auth.login.passwordLabel')}
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <Button type="submit" disabled={submitting}>
          {submitting ? t('auth.login.submitting') : t('auth.login.submit')}
        </Button>
        <Link
          to="/forgot-password"
          className="text-center text-sm font-medium text-sky-400 hover:text-sky-300"
        >
          {t('auth.login.forgotPassword')}
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
  cancelLabel,
}: {
  challenge: TwoFactorChallengeResponse;
  onVerified: () => void;
  onCancel: () => void;
  cancelLabel?: string;
}) {
  const t = useT();
  const { verifyTwoFactor, requestTwoFactorEmailCode } = useAuth();
  const totpAvailable = challenge.channels.includes('totp');
  const emailAvailable = challenge.channels.includes('email');
  const recoveryAvailable = challenge.channels.includes('recovery');
  const resolvedCancelLabel = cancelLabel ?? t('auth.twoFactor.backToSignIn');

  // Tailor the prompt to the methods this account actually enabled (#298).
  const codePrompt = totpAvailable
    ? emailAvailable
      ? t('auth.twoFactor.promptTotpAndEmail')
      : t('auth.twoFactor.promptTotpOnly')
    : t('auth.twoFactor.promptEmailOnly');

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
        setError(t('auth.twoFactor.tooManyCodes'));
      } else if (err instanceof ApiError && err.code === 'TWO_FACTOR_PENDING_INVALID') {
        setError(t('auth.twoFactor.sessionExpired'));
      } else {
        setError(t('auth.twoFactor.invalidCode'));
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
      setInfo(t('auth.twoFactor.emailCodeSent'));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TWO_FACTOR_PENDING_INVALID') {
        setError(t('auth.twoFactor.sessionExpired'));
      } else {
        setError(t('auth.twoFactor.emailCodeFailed'));
      }
    } finally {
      setSendingCode(false);
    }
  }

  return (
    <AuthCard subtitle={t('auth.twoFactor.subtitle')}>
      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6"
      >
        {error ? <Alert tone="error">{error}</Alert> : null}
        {info ? <Alert tone="info">{info}</Alert> : null}
        <p className="text-sm text-neutral-400">
          {useRecovery ? t('auth.twoFactor.recoveryPrompt') : codePrompt}
        </p>
        <TextField
          label={
            useRecovery
              ? t('auth.twoFactor.recoveryCodeLabel')
              : t('auth.twoFactor.verificationCodeLabel')
          }
          name={useRecovery ? 'recoveryCode' : 'code'}
          autoComplete="one-time-code"
          inputMode={useRecovery ? 'text' : 'numeric'}
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
        />
        <Button type="submit" disabled={submitting || value.trim().length === 0}>
          {submitting ? t('auth.twoFactor.verifying') : t('auth.twoFactor.verify')}
        </Button>
        {emailAvailable && !useRecovery ? (
          <Button type="button" variant="secondary" onClick={onEmailCode} disabled={sendingCode}>
            {sendingCode ? t('auth.twoFactor.sendingEmailCode') : t('auth.twoFactor.emailMeACode')}
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
            {useRecovery
              ? t('auth.twoFactor.useAuthenticatorOrEmail')
              : t('auth.twoFactor.useRecoveryCode')}
          </button>
        ) : null}
        <button
          type="button"
          className="text-center text-sm font-medium text-neutral-400 hover:text-neutral-200"
          onClick={onCancel}
        >
          {resolvedCancelLabel}
        </button>
      </form>
    </AuthCard>
  );
}
