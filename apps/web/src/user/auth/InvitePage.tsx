import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { MIN_PASSWORD_LENGTH } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { ApiError, classifyApiError, isApiOutage } from '../../lib/apiClient';
import * as api from '../../lib/userApi';
import { useAuth } from '../AuthContext';
import { type AttributedError, useFieldErrors } from '../components/fieldErrors';
import { Alert, AuthCard, Button, Spinner, TextField } from '../components/ui';

type InviteState =
  | { phase: 'loading' }
  | { phase: 'unavailable' }
  | { phase: 'invalid' }
  | { phase: 'valid'; email: string };

/** The controls an accept failure can be attributed to. */
type InviteField = 'username' | 'password';

/**
 * Friendly message for the failure codes `POST /auth/accept-invite` can return,
 * with the field that owns it. A taken username and a rejected password point at
 * their box; a spent invite and an outage belong to the submission — and so does
 * a taken email, whose field is the invite's own read-only address.
 */
function acceptErrorMessage(t: TranslateFn, err: unknown): AttributedError<InviteField> {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'USERNAME_TAKEN':
        return { field: 'username', message: t('auth.invite.usernameTaken') };
      case 'WEAK_PASSWORD':
        return { field: 'password', message: err.message };
      case 'EMAIL_TAKEN':
        return { field: null, message: t('auth.invite.emailTaken') };
      case 'INVALID_INVITE':
        return { field: null, message: t('auth.invite.invalidInvite') };
      default:
        if (isApiOutage(err)) return { field: null, message: t('common.genericError') };
    }
  }
  return { field: null, message: t('auth.invite.acceptFailed') };
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
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const { formRef, alertRef, fieldError, formError, fail, clear } = useFieldErrors<InviteField>();
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
        setInvite({
          phase:
            classifyApiError(err, ['INVALID_INVITE']) === 'confirmed-domain-outcome'
              ? 'invalid'
              : 'unavailable',
        });
      }
    })();
    return () => controller.abort();
  }, [token, loadAttempt]);

  const retryInvite = () => {
    setInvite({ phase: 'loading' });
    setLoadAttempt((attempt) => attempt + 1);
  };

  if (invite.phase === 'loading') {
    return (
      <div className="bt-app grid place-items-center">
        <Spinner label={t('auth.invite.checkingInvite')} />
      </div>
    );
  }

  if (invite.phase === 'invalid') {
    return (
      <AuthCard subtitle={t('auth.invite.invalidSubtitle')}>
        <div className="flex flex-col gap-4">
          <Alert tone="error">{t('auth.invite.invalidMessage')}</Alert>
          <Link to="/login" className="bt-link text-center text-sm font-medium">
            {t('auth.invite.goToSignIn')}
          </Link>
        </div>
      </AuthCard>
    );
  }

  if (invite.phase === 'unavailable') {
    return (
      <AuthCard subtitle={t('auth.invite.unavailableSubtitle')}>
        <div className="flex flex-col gap-4">
          <Alert tone="info">{t('auth.invite.unavailableMessage')}</Alert>
          <Button onClick={retryInvite}>{t('common.retry')}</Button>
        </div>
      </AuthCard>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    clear();
    setSubmitting(true);
    try {
      await acceptInvite({ token, username, password });
      // Land the app; `FirstRunGate` diverts a never-set-up account to /welcome
      // (one trigger for every §6.12 mode — see RegisterPage).
      navigate('/', { replace: true });
    } catch (err) {
      const attributed = acceptErrorMessage(t, err);
      fail(attributed.field, attributed.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard subtitle={t('auth.invite.subtitle')}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4" ref={formRef}>
        {formError ? (
          <div ref={alertRef} tabIndex={-1}>
            <Alert tone="error">{formError}</Alert>
          </div>
        ) : null}
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
          error={fieldError('username')}
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
          error={fieldError('password')}
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
