import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { MIN_PASSWORD_LENGTH, type RegistrationMode } from '@bettertrack/contracts';

import { useI18n, useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { ApiError, classifyApiError, isApiOutage } from '../../lib/apiClient';
import * as api from '../../lib/userApi';
import { useAuth } from '../AuthContext';
import { legalUrl } from '../legal';
import { type AttributedError, useFieldErrors } from '../components/fieldErrors';
import { Alert, AuthCard, Button, OrDivider, Spinner, TextField } from '../components/ui';
import { GoogleButton } from './GoogleButton';
import {
  OAUTH_RETURN_TO_PARAM,
  safeAuthorizeContinuation,
  withoutScreenHint,
} from './oauthContinuation';

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

/**
 * Google-assisted registration state (owner order 2026-07-16). `off` — a plain
 * visit; `loading` — resolving the pending ticket after the OAuth round-trip;
 * `connected` — the ticket resolved, so the form shows the "Connected to Google"
 * state (email locked); `expired` — the ticket is gone, so the form falls back to
 * plain registration with a notice; `unavailable` — the ticket could not be
 * checked because the backend is unreachable, so the flow holds for a retry.
 */
type GoogleConnectState =
  | { phase: 'off' }
  | { phase: 'loading' }
  | { phase: 'connected'; email: string; name: string | null }
  | { phase: 'unavailable' }
  | { phase: 'expired' };

/**
 * Seed the username field from a Google display name, sanitized to the username
 * charset (§6.1). Returns '' when nothing usable remains — the field then stays
 * blank for the user to fill. Purely a prefill; the field is always editable.
 */
function usernameFromName(name: string | null): string {
  if (!name) return '';
  const cleaned = name.replace(/[^a-zA-Z0-9_.-]/g, '');
  return cleaned.length >= 3 ? cleaned.slice(0, 40) : '';
}

/** The controls a registration failure can be attributed to. */
type RegisterField = 'inviteToken' | 'email' | 'username' | 'password';

/**
 * Friendly message for the failure codes `POST /auth/register` can return, with
 * the field that owns it. A taken name, a taken address, a rejected password and
 * a bad access token each point at their own box; a closed instance, an expired
 * Google ticket, a rate limit and an outage belong to the submission.
 *
 * `emailLocked` (the Google-assisted form) keeps a taken address form-level:
 * the field is read-only there, so blaming it would point at a box the user
 * cannot edit.
 *
 * `tokenFieldShown` does the same for the access-token box, which only exists
 * in `invite_token` mode: the token codes are exactly what a mode that flipped
 * after the page loaded returns, and blaming an unmounted field would leave the
 * failure with nowhere to render.
 */
function registerErrorMessage(
  t: TranslateFn,
  err: unknown,
  { emailLocked, tokenFieldShown }: { emailLocked: boolean; tokenFieldShown: boolean },
): AttributedError<RegisterField> {
  const tokenField = tokenFieldShown ? 'inviteToken' : null;
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'USERNAME_TAKEN':
        return { field: 'username', message: t('auth.register.usernameTaken') };
      case 'EMAIL_TAKEN':
        return { field: emailLocked ? null : 'email', message: t('auth.register.emailTaken') };
      case 'WEAK_PASSWORD':
        return { field: 'password', message: err.message };
      case 'REGISTRATION_TOKEN_REQUIRED':
        return { field: tokenField, message: t('auth.register.tokenRequired') };
      case 'INVALID_REGISTRATION_TOKEN':
        return { field: tokenField, message: t('auth.register.invalidToken') };
      case 'REGISTRATION_CLOSED':
        return { field: null, message: t('auth.register.closedMessage') };
      case 'GOOGLE_REGISTER_TICKET_INVALID':
        return { field: null, message: t('auth.register.google.ticketExpired') };
      default:
        if (err.status === 429) return { field: null, message: t('auth.register.rateLimited') };
        if (isApiOutage(err)) return { field: null, message: t('common.genericError') };
    }
  }
  return { field: null, message: t('auth.register.failed') };
}

/**
 * Public self-serve registration (PROJECTPLAN.md §6.12, §13.4 V4-P4a). Reads the
 * active registration mode and reflects it: `closed` shows a closed notice;
 * `invite_token` adds an access-token field (prefilled from `?token=`); `open`
 * and `invite_token` sign the new account straight in; `approval` confirms the
 * request is queued for an admin (no session). The mode is discovered from the
 * public `GET /auth/registration-info`, so the surface never guesses.
 *
 * **OAuth continuation (owner directive 2026-08-07).** A `?returnTo=` pointing
 * at the pending `/oauth/authorize` request (and nothing else — see
 * `oauthContinuation.ts`) turns this into the app-native signup surface: a
 * created account (201) continues STRAIGHT into that authorize request →
 * consent → the app's `redirect_uri`, never via the webapp home; first-run
 * setup then happens inside the app. The other modes degrade rather than
 * continue: `approval` stops at the pending state (there is no session to
 * authorize with), `invite_token` asks for the token as usual, `closed`
 * explains itself. Every "back to sign in" path leads to the authorize request
 * instead of a bare `/login`, so the OAuth flow survives every dead end.
 * Without the parameter this page behaves exactly as it always has.
 */
export function RegisterPage() {
  const t = useT();
  const { locale } = useI18n();
  const navigate = useNavigate();
  const { register, googleRegister } = useAuth();
  const [searchParams] = useSearchParams();

  // The pending OAuth authorize request to continue into after a successful
  // registration, or null for an ordinary web signup. Validated fail-closed:
  // an absent, foreign or non-authorize `returnTo` is simply ignored, which
  // leaves the ordinary flow byte-identical.
  const continuation = safeAuthorizeContinuation(searchParams.get(OAUTH_RETURN_TO_PARAM));
  // Where every "back to sign in" affordance points. Inside the OAuth flow it
  // is the authorize request itself: `RequireUser` bounces an anonymous visitor
  // to /login carrying it, so signing in lands on consent. The `screen` hint is
  // stripped (it would bounce right back here — an endless loop).
  const signInHref = continuation === null ? '/login' : withoutScreenHint(continuation);

  const [state, setState] = useState<ModeState>({ phase: 'loading' });
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteToken, setInviteToken] = useState(() => searchParams.get('token') ?? '');
  const { formRef, alertRef, fieldError, formError, fail, clear } = useFieldErrors<RegisterField>();
  const [submitting, setSubmitting] = useState(false);
  // Set once an approval-mode request has been accepted — swaps the form for the
  // "awaiting approval" confirmation.
  const [pending, setPending] = useState(false);
  // Whether "Continue with Google" is offered (§13.4 V4-P4b) — env-gated server-side.
  const [googleEnabled, setGoogleEnabled] = useState(false);
  // Google-assisted registration (owner order 2026-07-16). A `?google=connected`
  // visit resolves the pending ticket; everything else stays `off`. Never
  // inside an OAuth continuation: the Google round-trip returns through the API
  // to a bare `/register?google=connected`, which drops the continuation — the
  // exact stranding this flow exists to fix. The button is hidden there, so
  // this only ever disarms a hand-built URL.
  const [google, setGoogle] = useState<GoogleConnectState>(() =>
    searchParams.get('google') === 'connected' && continuation === null
      ? { phase: 'loading' }
      : { phase: 'off' },
  );
  const [googleTicketAttempt, setGoogleTicketAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const info = await api.getRegistrationInfo(controller.signal);
        setState({ phase: 'ready', mode: info.mode });
        setGoogleEnabled(info.googleEnabled);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setState({ phase: 'error' });
      }
    })();
    return () => controller.abort();
  }, []);

  // Resolve the pending Google ticket on a `?google=connected` landing. The
  // verified email is prefilled + locked; the display name seeds the username.
  // A missing/expired ticket falls back to a plain form with a notice.
  useEffect(() => {
    if (searchParams.get('google') !== 'connected') return;
    if (safeAuthorizeContinuation(searchParams.get(OAUTH_RETURN_TO_PARAM)) !== null) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const ticket = await api.getGoogleRegisterTicket(controller.signal);
        setEmail(ticket.email);
        setUsername((current) => (current.length > 0 ? current : usernameFromName(ticket.name)));
        setGoogle({ phase: 'connected', email: ticket.email, name: ticket.name });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setGoogle({
          phase:
            classifyApiError(err, ['GOOGLE_REGISTER_TICKET_INVALID']) === 'confirmed-domain-outcome'
              ? 'expired'
              : 'unavailable',
        });
      }
    })();
    return () => controller.abort();
  }, [searchParams, googleTicketAttempt]);

  const retryGoogleTicket = () => {
    setGoogle({ phase: 'loading' });
    setGoogleTicketAttempt((attempt) => attempt + 1);
  };

  if (state.phase === 'loading') {
    return (
      <div className="bt-app grid place-items-center">
        <Spinner label={t('auth.register.loading')} />
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <AuthCard subtitle={t('auth.register.subtitle')}>
        <div className="flex flex-col gap-4">
          <Alert tone="error">{t('common.genericError')}</Alert>
          <Link to={signInHref} className="bt-link text-center text-sm font-medium">
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
        <div className="flex flex-col gap-4">
          <Alert tone="info">{t('auth.register.closedMessage')}</Alert>
          <Link to={signInHref} className="bt-link text-center text-sm font-medium">
            {t('auth.register.goToSignIn')}
          </Link>
        </div>
      </AuthCard>
    );
  }

  if (pending) {
    return (
      <AuthCard subtitle={t('auth.register.pendingSubtitle')}>
        <div className="flex flex-col gap-4">
          <Alert tone="success">{t('auth.register.pendingMessage')}</Alert>
          {/* Approval mode NEVER continues into OAuth: 202 mints no session, so
              there is nothing to authorize with. Say so here, in the same
              surface, and let them come back through the app once approved. */}
          {continuation ? (
            <p className="bt-muted text-sm">{t('auth.register.pendingOauthHint')}</p>
          ) : null}
          <Link to={signInHref} className="bt-link text-center text-sm font-medium">
            {t('auth.register.goToSignIn')}
          </Link>
        </div>
      </AuthCard>
    );
  }

  // Still resolving the Google ticket — hold the connecting spinner rather than
  // flashing the plain form before the connected state lands.
  if (google.phase === 'loading') {
    return (
      <div className="bt-app grid place-items-center">
        <Spinner label={t('auth.register.google.connecting')} />
      </div>
    );
  }

  if (google.phase === 'unavailable') {
    return (
      <AuthCard subtitle={t('auth.register.subtitle')}>
        <div className="flex flex-col gap-4">
          <Alert tone="info">{t('auth.register.google.ticketUnavailable')}</Alert>
          <Button onClick={retryGoogleTicket}>{t('common.retry')}</Button>
        </div>
      </AuthCard>
    );
  }

  const connected = google.phase === 'connected' ? google : null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    clear();
    setSubmitting(true);
    try {
      // The connected form submits against the server-side ticket (email + the
      // subject to link come from there, never this payload); a plain form uses
      // the ordinary register path.
      const outcome = connected
        ? await googleRegister({
            username,
            password,
            ...(mode === 'invite_token' ? { inviteToken: inviteToken.trim() } : {}),
            locale,
          })
        : await register({
            email,
            username,
            password,
            // Only meaningful in invite-token mode; the server ignores it otherwise.
            ...(mode === 'invite_token' ? { inviteToken: inviteToken.trim() } : {}),
            // Record the form language so an approval decision email localizes.
            locale,
            // Registering inside an OAuth authorize flow: ask the server for an
            // EPHEMERAL session, exactly like a PIN-less OAuth login (§16, §399
            // §A). A Custom-Tab browser shares cookies with the phone's
            // browser, so a brand-new account must not leave a persistent web
            // session behind. The server is authoritative — this only asks.
            ...(continuation ? { oauthRegistration: true } : {}),
          });
      if (outcome.status === 'pending') {
        setPending(true);
        return;
      }
      // Inside an OAuth flow: continue into the ORIGINAL authorize request, so
      // the user goes account-created → consent → back into the app that sent
      // them (owner directive 2026-08-07). `FirstRunGate` exempts the authorize
      // path, so setup is not interposed — it happens in the app.
      if (continuation) {
        navigate(continuation, { replace: true });
        return;
      }
      // Land the app; `FirstRunGate` diverts a never-set-up account to /welcome.
      // Deliberately NOT a direct navigate to /welcome: the trigger belongs in
      // one place for every registration mode (§6.12) — an admin-created user or
      // an approved applicant never passes through this form at all.
      navigate('/', { replace: true });
    } catch (err) {
      const attributed = registerErrorMessage(t, err, {
        emailLocked: connected !== null,
        tokenFieldShown: mode === 'invite_token',
      });
      fail(attributed.field, attributed.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard subtitle={t('auth.register.subtitle')}>
      {/* Final layout (owner 2026-07-17, V5-P0 arc (a)): mirrors the login page —
          "Continue with Google" on top, the register form in the middle, an OR
          divider, and a prominent "Have an account? → Sign in" box at the very
          bottom. Google is hidden once connected (the OAuth round-trip is done
          and the account is a submit away) — and inside an OAuth continuation,
          where the Google round-trip would drop it and strand the user in the
          webapp (owner 2026-08-07). */}
      {googleEnabled && !connected && !continuation ? (
        <div className="mb-5">
          <GoogleButton />
        </div>
      ) : null}
      <form onSubmit={onSubmit} className="flex flex-col gap-4" ref={formRef}>
        {formError ? (
          <div ref={alertRef} tabIndex={-1}>
            <Alert tone="error">{formError}</Alert>
          </div>
        ) : null}
        {google.phase === 'expired' ? (
          <Alert tone="error">{t('auth.register.google.ticketExpired')}</Alert>
        ) : null}
        {connected ? (
          <Alert tone="success">
            {t('auth.register.google.connectedAs', { email: connected.email })}
          </Alert>
        ) : null}
        {mode === 'approval' ? (
          <p className="bt-muted text-sm">{t('auth.register.approvalHint')}</p>
        ) : null}
        {mode === 'invite_token' ? (
          <TextField
            error={fieldError('inviteToken')}
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
          error={fieldError('email')}
          label={t('auth.register.emailLabel')}
          name="email"
          type="email"
          autoComplete="email"
          autoFocus={mode !== 'invite_token' && !connected}
          value={connected ? connected.email : email}
          onChange={(e) => setEmail(e.target.value)}
          required
          // Google-assisted: the verified email is locked to the ticket's value.
          readOnly={Boolean(connected)}
          disabled={Boolean(connected)}
          hint={connected ? t('auth.register.google.emailLockedHint') : undefined}
        />
        <TextField
          error={fieldError('username')}
          label={t('auth.register.usernameLabel')}
          name="username"
          autoComplete="username"
          autoFocus={Boolean(connected)}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          minLength={3}
          required
          hint={t('auth.register.usernameHint')}
        />
        <TextField
          error={fieldError('password')}
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
        <p className="bt-muted text-xs leading-relaxed">
          {interpolateNodes(t('auth.register.legalConsent'), {
            terms: (
              <a
                key="terms"
                href={legalUrl('terms', locale)}
                target="_blank"
                rel="noreferrer"
                className="bt-link font-medium"
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
                className="bt-link font-medium"
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
                className="bt-link font-medium"
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
                className="bt-link font-medium"
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
      </form>
      {/* Mirrored "Have an account? → Sign in" bottom box — styled like the login
          page's sign-up box so both surfaces read uniform (V5-P0 arc (a)). */}
      <div className="mt-5 flex flex-col gap-4">
        <OrDivider label={t('common.or')} />
        <div className="bt-panel bt-panel--soft flex flex-col gap-3 p-4">
          <p className="bt-label text-center">{t('auth.register.haveAccountHeading')}</p>
          <Link to={signInHref} className="bt-btn w-full">
            {t('auth.register.signIn')}
          </Link>
        </div>
      </div>
    </AuthCard>
  );
}
