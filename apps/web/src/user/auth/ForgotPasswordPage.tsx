import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';

import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/userApi';
import { useAuth } from '../AuthContext';
import { Alert, AuthCard, Button, Spinner, TextField } from '../components/ui';

/**
 * Self-service password reset — request step (PROJECTPLAN.md §6.1, §14, §13.2
 * V2-P4). The user enters their email and always sees the same generic
 * confirmation, whether or not the address has an account — the response never
 * reveals it (no user enumeration). The tokenized link arrives by email.
 */
export function ForgotPasswordPage() {
  const { status } = useAuth();

  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
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
      await api.requestPasswordReset({ email });
      setSent(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        const wait = err.retryAfterSeconds
          ? ` Please wait ${err.retryAfterSeconds} second${err.retryAfterSeconds === 1 ? '' : 's'} and try again.`
          : ' Please wait a moment and try again.';
        setError(`Too many requests.${wait}`);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <AuthCard subtitle="Reset your password">
        <div className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6">
          <Alert tone="success">
            If an account exists for that email, we&rsquo;ve sent a link to reset your password.
            Check your inbox — the link expires in 1 hour.
          </Alert>
          <Link
            to="/login"
            className="text-center text-sm font-medium text-sky-400 hover:text-sky-300"
          >
            Back to sign in
          </Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard subtitle="Reset your password">
      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6"
      >
        {error ? <Alert tone="error">{error}</Alert> : null}
        <p className="text-sm text-neutral-400">
          Enter the email for your account and we&rsquo;ll send you a link to choose a new password.
        </p>
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Sending…' : 'Send reset link'}
        </Button>
        <Link
          to="/login"
          className="text-center text-sm font-medium text-sky-400 hover:text-sky-300"
        >
          Back to sign in
        </Link>
      </form>
    </AuthCard>
  );
}
