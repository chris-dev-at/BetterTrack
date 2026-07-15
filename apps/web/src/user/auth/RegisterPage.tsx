import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { MIN_PASSWORD_LENGTH, type RegistrationMode } from '@bettertrack/contracts';

import { useI18n, useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/userApi';
import { useAuth } from '../AuthContext';
import { legalUrl } from '../legal';
import { Alert, AuthCard, Button, Spinner, TextField } from '../components/ui';

/**
 * Splice React nodes into an i18n string that carries `{{name}}` placeholders,
 * keeping surrounding punctuation and word order translator-controlled. Used
 * for the register-form legal-consent notice (V4-P0 (e)) where each link's
 * label and URL are supplied by the caller.
 */
function interpolateNodes(template: string, nodes: Record<string, ReactNode>): ReactNode[] {
  const parts: ReactNode[] = [];
  const regex = /\{\{(\w+)\}\}/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(template)) !== null) {
    if (match.index > cursor) parts.push(template.slice(cursor, match.index));
    const name = match[1] as string;
    parts.push(nodes[name] ?? match[0]);
    cursor = regex.lastIndex;
  }
  if (cursor < template.length) parts.push(template.slice(cursor));
  return parts;
}

type ModeState =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'ready'; mode: RegistrationMode };

/** Friendly message for the failure codes `POST /auth/register` can return. */
function registerErrorMessage(t: TranslateFn, err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'USERNAME_TAKEN':
        return t('auth.register.usernameTaken');
      case 'EMAIL_TAKEN':
        return t('auth.register.emailTaken');
      case 'WEAK_PASSWORD':
        return err.message;
      case 'REGISTRATION_TOKEN_REQUIRED':
        return t('auth.register.tokenRequired');
      case 'INVALID_REGISTRATION_TOKEN':
        return t('auth.register.invalidToken');
      case 'REGISTRATION_CLOSED':
        return t('auth.register.closedMessage');
      default:
        if (err.status === 429) return t('auth.register.rateLimited');
        if (err.status >= 500) return t('common.genericError');
    }
  }
  return t('auth.register.failed');
}

/**
 * Public self-serve registration (PROJECTPLAN.md §6.12, §13.4 V4-P4a). Reads the
 * active registration mode and reflects it: `closed` shows a closed notice;
 * `invite_token` adds an access-token field (prefilled from `?token=`); `open`
 * and `invite_token` sign the new account straight in; `approval` confirms the
 * request is queued for an admin (no session). The mode is discovered from the
 * public `GET /auth/registration-info`, so the surface never guesses.
 */
export function RegisterPage() {
  const t = useT();
  const { locale } = useI18n();
  const navigate = useNavigate();
  const { register } = useAuth();
  const [searchParams] = useSearchParams();

  const [state, setState] = useState<ModeState>({ phase: 'loading' });
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteToken, setInviteToken] = useState(() => searchParams.get('token') ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Set once an approval-mode request has been accepted — swaps the form for the
  // "awaiting approval" confirmation.
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const info = await api.getRegistrationInfo(controller.signal);
        setState({ phase: 'ready', mode: info.mode });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setState({ phase: 'error' });
      }
    })();
    return () => controller.abort();
  }, []);

  if (state.phase === 'loading') {
    return (
      <div className="grid min-h-screen place-items-center bg-[#0b0e14]">
        <Spinner label={t('auth.register.loading')} />
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <AuthCard subtitle={t('auth.register.subtitle')}>
        <div className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6">
          <Alert tone="error">{t('common.genericError')}</Alert>
          <Link
            to="/login"
            className="text-center text-sm font-medium text-sky-400 hover:text-sky-300"
          >
            {t('auth.register.goToSignIn')}
          </Link>
        </div>
      </AuthCard>
    );
  }

  const { mode } = state;

  if (mode === 'closed') {
    return (
      <AuthCard subtitle={t('auth.register.closedSubtitle')}>
        <div className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6">
          <Alert tone="info">{t('auth.register.closedMessage')}</Alert>
          <Link
            to="/login"
            className="text-center text-sm font-medium text-sky-400 hover:text-sky-300"
          >
            {t('auth.register.goToSignIn')}
          </Link>
        </div>
      </AuthCard>
    );
  }

  if (pending) {
    return (
      <AuthCard subtitle={t('auth.register.pendingSubtitle')}>
        <div className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6">
          <Alert tone="success">{t('auth.register.pendingMessage')}</Alert>
          <Link
            to="/login"
            className="text-center text-sm font-medium text-sky-400 hover:text-sky-300"
          >
            {t('auth.register.goToSignIn')}
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
      const outcome = await register({
        email,
        username,
        password,
        // Only meaningful in invite-token mode; the server ignores it otherwise.
        ...(mode === 'invite_token' ? { inviteToken: inviteToken.trim() } : {}),
        // Record the form language so an approval decision email localizes.
        locale,
      });
      if (outcome.status === 'pending') {
        setPending(true);
        return;
      }
      navigate('/', { replace: true });
    } catch (err) {
      setError(registerErrorMessage(t, err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard subtitle={t('auth.register.subtitle')}>
      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6"
      >
        {error ? <Alert tone="error">{error}</Alert> : null}
        {mode === 'approval' ? (
          <p className="text-sm text-neutral-400">{t('auth.register.approvalHint')}</p>
        ) : null}
        {mode === 'invite_token' ? (
          <TextField
            label={t('auth.register.tokenLabel')}
            name="inviteToken"
            autoFocus
            value={inviteToken}
            onChange={(e) => setInviteToken(e.target.value)}
            required
            hint={t('auth.register.tokenHint')}
          />
        ) : null}
        <TextField
          label={t('auth.register.emailLabel')}
          name="email"
          type="email"
          autoComplete="email"
          autoFocus={mode !== 'invite_token'}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <TextField
          label={t('auth.register.usernameLabel')}
          name="username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          minLength={3}
          required
          hint={t('auth.register.usernameHint')}
        />
        <TextField
          label={t('auth.register.passwordLabel')}
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={MIN_PASSWORD_LENGTH}
          required
          hint={t('auth.common.minPasswordHint', { count: MIN_PASSWORD_LENGTH })}
        />
        {/* Legal consent notice (V4-P0 (e), §13.4). The versioned re-accept
            flow is V6-5; this ships the up-front notice + links only. */}
        <p className="text-xs leading-relaxed text-neutral-500">
          {interpolateNodes(t('auth.register.legalConsent'), {
            terms: (
              <a
                key="terms"
                href={legalUrl('terms', locale)}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-sky-400 hover:text-sky-300"
              >
                {t('footer.terms')}
              </a>
            ),
            privacy: (
              <a
                key="privacy"
                href={legalUrl('privacy', locale)}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-sky-400 hover:text-sky-300"
              >
                {t('footer.privacy')}
              </a>
            ),
            impressum: (
              <a
                key="impressum"
                href={legalUrl('impressum', locale)}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-sky-400 hover:text-sky-300"
              >
                {t('footer.impressum')}
              </a>
            ),
            cookies: (
              <a
                key="cookies"
                href={legalUrl('cookies', locale)}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-sky-400 hover:text-sky-300"
              >
                {t('footer.cookies')}
              </a>
            ),
          })}
        </p>
        <Button type="submit" disabled={submitting}>
          {submitting
            ? t('auth.register.submitting')
            : mode === 'approval'
              ? t('auth.register.submitApproval')
              : t('auth.register.submit')}
        </Button>
        <Link
          to="/login"
          className="text-center text-sm font-medium text-sky-400 hover:text-sky-300"
        >
          {t('auth.register.haveAccount')}
        </Link>
      </form>
    </AuthCard>
  );
}
