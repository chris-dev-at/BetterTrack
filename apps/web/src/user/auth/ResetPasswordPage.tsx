import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';

import { MIN_PASSWORD_LENGTH } from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import { useAuth } from '../AuthContext';
import { Alert, AuthCard, Button, Spinner, TextField } from '../components/ui';

/** Friendly message for the failure codes `POST /auth/password-reset/complete` returns. */
function completeErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      const wait = err.retryAfterSeconds
        ? ` Please wait ${err.retryAfterSeconds} second${err.retryAfterSeconds === 1 ? '' : 's'} and try again.`
        : ' Please wait a moment and try again.';
      return `Too many attempts.${wait}`;
    }
    switch (err.code) {
      case 'WEAK_PASSWORD':
        return err.message;
      case 'INVALID_RESET':
        return 'This reset link is invalid or has expired. Request a new one to continue.';
      default:
        if (err.status >= 500) return 'Something went wrong. Please try again.';
    }
  }
  return 'Could not reset your password. Please try again.';
}

/**
 * Self-service password reset — set-new-password step (PROJECTPLAN.md §6.1, §14,
 * §13.2 V2-P4). Reads the emailed token from the path, lets the user pick a new
 * password, and on success lands them signed-in on `/` — the API mints a fresh
 * session so there is no redundant sign-in prompt (#268).
 */
export function ResetPasswordPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const { status, completePasswordReset } = useAuth();

  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === 'loading') {
    return (
      <div className="grid min-h-screen place-items-center bg-[#0b0e14]">
        <Spinner label="Checking session…" />
      </div>
    );
  }
  if (status === 'authenticated') return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await completePasswordReset({ token, newPassword: password });
      navigate('/', { replace: true });
    } catch (err) {
      setError(completeErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard subtitle="Choose a new password">
      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6"
      >
        {error ? <Alert tone="error">{error}</Alert> : null}
        <TextField
          label="New password"
          name="password"
          type="password"
          autoComplete="new-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={MIN_PASSWORD_LENGTH}
          required
          hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
        />
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Set new password'}
        </Button>
        <Link
          to="/forgot-password"
          className="text-center text-sm font-medium text-sky-400 hover:text-sky-300"
        >
          Request a new link
        </Link>
      </form>
    </AuthCard>
  );
}
