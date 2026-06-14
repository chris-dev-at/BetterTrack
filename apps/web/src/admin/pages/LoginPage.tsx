import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { ApiError } from '../../lib/apiClient';
import { NotAdminError, PasswordChangeRequiredError, useAuth } from '../AuthContext';
import { Alert, Button, Spinner, TextField } from '../components/ui';

/**
 * Admin sign-in. Its own minimal, app-shell-free screen (PROJECTPLAN.md §6.12).
 * Already-authenticated admins are bounced straight to the users page.
 */
export function LoginPage() {
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === 'loading') {
    return (
      <div className="grid min-h-screen place-items-center bg-neutral-950">
        <Spinner label="Checking session…" />
      </div>
    );
  }
  if (status === 'authenticated') return <Navigate to="/admin/users" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login({ identifier, password });
      navigate('/admin/users', { replace: true });
    } catch (err) {
      if (err instanceof NotAdminError || err instanceof PasswordChangeRequiredError) {
        setError(err.message);
      } else if (err instanceof ApiError) {
        // The API returns a deliberately generic, non-enumerating message.
        setError(err.message);
      } else {
        setError('Unable to sign in. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-neutral-950 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">BetterTrack</h1>
          <p className="mt-1 text-sm text-neutral-500">Admin console</p>
        </div>
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
      </div>
    </div>
  );
}
