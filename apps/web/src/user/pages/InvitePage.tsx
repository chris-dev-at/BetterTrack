import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { MIN_PASSWORD_LENGTH } from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/userApi';
import { useAuth } from '../AuthContext';
import { Alert, AuthCard, Button, Spinner, TextField } from '../components/ui';

type InviteState = { phase: 'loading' } | { phase: 'invalid' } | { phase: 'valid'; email: string };

/** Friendly message for the failure codes `POST /auth/accept-invite` can return. */
function acceptErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'USERNAME_TAKEN':
        return 'That username is already taken — pick another.';
      case 'WEAK_PASSWORD':
        return err.message;
      case 'EMAIL_TAKEN':
        return 'An account already exists for this email.';
      case 'INVALID_INVITE':
        return 'This invite link is no longer valid. Ask your admin for a new one.';
      default:
        if (err.status >= 500) return 'Something went wrong. Please try again.';
    }
  }
  return 'Could not create your account. Please try again.';
}

/**
 * Public invite-accept screen (PROJECTPLAN.md §6.1, §7.2). Validates the token,
 * shows the invite's fixed email, lets the invitee pick a username + password,
 * and on success creates the account and lands them logged-in on `/`.
 */
export function InvitePage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const { acceptInvite } = useAuth();

  const [invite, setInvite] = useState<InviteState>({ phase: 'loading' });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await api.validateInvite(token, controller.signal);
        setInvite(
          res.valid && res.email ? { phase: 'valid', email: res.email } : { phase: 'invalid' },
        );
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setInvite({ phase: 'invalid' });
      }
    })();
    return () => controller.abort();
  }, [token]);

  if (invite.phase === 'loading') {
    return (
      <div className="grid min-h-screen place-items-center bg-[#0b0e14]">
        <Spinner label="Checking your invite…" />
      </div>
    );
  }

  if (invite.phase === 'invalid') {
    return (
      <AuthCard subtitle="Accept your invite">
        <div className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6">
          <Alert tone="error">
            This invite link is invalid, expired, or has already been used. Ask your administrator
            for a fresh invite.
          </Alert>
          <Link
            to="/login"
            className="text-center text-sm font-medium text-sky-400 hover:text-sky-300"
          >
            Go to sign in
          </Link>
        </div>
      </AuthCard>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await acceptInvite({ token, username, password });
      navigate('/', { replace: true });
    } catch (err) {
      setError(acceptErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard subtitle="Set up your account">
      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6"
      >
        {error ? <Alert tone="error">{error}</Alert> : null}
        <TextField
          label="Email"
          name="email"
          type="email"
          value={invite.email}
          readOnly
          disabled
          hint="Set by your invite and can't be changed."
        />
        <TextField
          label="Username"
          name="username"
          autoComplete="username"
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          minLength={3}
          required
          hint="3–40 characters: letters, numbers, dot, dash or underscore."
        />
        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={MIN_PASSWORD_LENGTH}
          required
          hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
        />
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </AuthCard>
  );
}
