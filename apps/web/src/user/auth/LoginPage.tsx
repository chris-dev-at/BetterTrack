import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

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
 * API sets on success.
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
      await login({ identifier, password });
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
      </form>
    </AuthCard>
  );
}
