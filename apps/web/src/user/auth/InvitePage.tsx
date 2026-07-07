import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { MIN_PASSWORD_LENGTH } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/userApi';
import { useAuth } from '../AuthContext';
import { Alert, AuthCard, Button, Spinner, TextField } from '../components/ui';

type InviteState = { phase: 'loading' } | { phase: 'invalid' } | { phase: 'valid'; email: string };

/** Friendly message for the failure codes `POST /auth/accept-invite` can return. */
function acceptErrorMessage(t: TranslateFn, err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'USERNAME_TAKEN':
        return t('auth.invite.usernameTaken');
      case 'WEAK_PASSWORD':
        return err.message;
      case 'EMAIL_TAKEN':
        return t('auth.invite.emailTaken');
      case 'INVALID_INVITE':
        return t('auth.invite.invalidInvite');
      default:
        if (err.status >= 500) return t('common.genericError');
    }
  }
  return t('auth.invite.acceptFailed');
}

/**
 * Public invite-accept screen (PROJECTPLAN.md §6.1, §7.2). Validates the token,
 * shows the invite's fixed email, lets the invitee pick a username + password,
 * and on success creates the account and lands them logged-in on `/`.
 */
export function InvitePage() {
  const t = useT();
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
        <Spinner label={t('auth.invite.checkingInvite')} />
      </div>
    );
  }

  if (invite.phase === 'invalid') {
    return (
      <AuthCard subtitle={t('auth.invite.invalidSubtitle')}>
        <div className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6">
          <Alert tone="error">{t('auth.invite.invalidMessage')}</Alert>
          <Link
            to="/login"
            className="text-center text-sm font-medium text-sky-400 hover:text-sky-300"
          >
            {t('auth.invite.goToSignIn')}
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
      setError(acceptErrorMessage(t, err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard subtitle={t('auth.invite.subtitle')}>
      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6"
      >
        {error ? <Alert tone="error">{error}</Alert> : null}
        <TextField
          label={t('auth.invite.emailLabel')}
          name="email"
          type="email"
          value={invite.email}
          readOnly
          disabled
          hint={t('auth.invite.emailHint')}
        />
        <TextField
          label={t('auth.invite.usernameLabel')}
          name="username"
          autoComplete="username"
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          minLength={3}
          required
          hint={t('auth.invite.usernameHint')}
        />
        <TextField
          label={t('auth.invite.passwordLabel')}
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={MIN_PASSWORD_LENGTH}
          required
          hint={t('auth.common.minPasswordHint', { count: MIN_PASSWORD_LENGTH })}
        />
        <Button type="submit" disabled={submitting}>
          {submitting ? t('auth.invite.creating') : t('auth.invite.submit')}
        </Button>
      </form>
    </AuthCard>
  );
}
