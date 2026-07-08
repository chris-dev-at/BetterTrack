import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';

import { MIN_PASSWORD_LENGTH, type TwoFactorChallengeResponse } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { useAuth } from '../AuthContext';
import { Alert, AuthCard, Button, Spinner, TextField } from '../components/ui';
import { TwoFactorStep } from './LoginPage';

/** Friendly message for the failure codes `POST /auth/password-reset/complete` returns. */
function completeErrorMessage(t: TranslateFn, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) {
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
      return `${t('auth.resetPassword.rateLimited')}${wait}`;
    }
    switch (err.code) {
      case 'WEAK_PASSWORD':
        return err.message;
      case 'INVALID_RESET':
        return t('auth.resetPassword.invalidReset');
      default:
        if (err.status >= 500) return t('common.genericError');
    }
  }
  return t('auth.resetPassword.failed');
}

/**
 * Self-service password reset — set-new-password step (PROJECTPLAN.md §6.1, §14,
 * §13.2 V2-P4). Reads the emailed token from the path, lets the user pick a new
 * password, and on success lands them signed-in on `/` — the API mints a fresh
 * session so there is no redundant sign-in prompt (#268).
 */
export function ResetPasswordPage() {
  const t = useT();
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const { status, completePasswordReset } = useAuth();

  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Non-null once the reset returns a 2FA challenge: the password was changed but
  // the session is withheld until a second factor verifies (§6.1).
  const [challenge, setChallenge] = useState<TwoFactorChallengeResponse | null>(null);

  if (status === 'loading') {
    return (
      <div className="grid min-h-screen place-items-center bg-[#0b0e14]">
        <Spinner label={t('auth.common.checkingSession')} />
      </div>
    );
  }
  if (status === 'authenticated') return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const outcome = await completePasswordReset({ token, newPassword: password });
      if (outcome.status === 'two_factor_required') {
        // Password reset, but 2FA is on — collect the second factor next.
        setChallenge(outcome.challenge);
        return;
      }
      navigate('/', { replace: true });
    } catch (err) {
      setError(completeErrorMessage(t, err));
    } finally {
      setSubmitting(false);
    }
  }

  if (challenge) {
    return (
      <TwoFactorStep
        challenge={challenge}
        onVerified={() => navigate('/', { replace: true })}
        onCancel={() => navigate('/login', { replace: true })}
        cancelLabel={t('auth.resetPassword.signInInstead')}
      />
    );
  }

  return (
    <AuthCard subtitle={t('auth.resetPassword.subtitle')}>
      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6"
      >
        {error ? <Alert tone="error">{error}</Alert> : null}
        <TextField
          label={t('auth.resetPassword.newPasswordLabel')}
          name="password"
          type="password"
          autoComplete="new-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={MIN_PASSWORD_LENGTH}
          required
          hint={t('auth.common.minPasswordHint', { count: MIN_PASSWORD_LENGTH })}
        />
        <Button type="submit" disabled={submitting}>
          {submitting ? t('auth.resetPassword.saving') : t('auth.resetPassword.submit')}
        </Button>
        <Link
          to="/forgot-password"
          className="text-center text-sm font-medium text-sky-400 hover:text-sky-300"
        >
          {t('auth.resetPassword.requestNewLink')}
        </Link>
      </form>
    </AuthCard>
  );
}
