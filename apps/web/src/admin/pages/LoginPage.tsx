import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { Wordmark } from '../../components/Wordmark';
import { ApiError } from '../../lib/apiClient';
import { NotAdminError, useAuth } from '../AuthContext';
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
      // A reset admin lands in the forced-change trap instead (status becomes
      // `password-change-required`); this navigation is a no-op for them.
      navigate('/admin/users', { replace: true });
    } catch (err) {
      if (err instanceof NotAdminError) {
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
          <Wordmark edition="Admin" className="text-2xl" />
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
