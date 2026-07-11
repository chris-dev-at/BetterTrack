import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';

import type { MeResponse, TwoFactorChallengeResponse } from '@bettertrack/contracts';

import { useT } from '../../i18n';
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
 * API sets on success. When the account has 2FA enabled the password step hands
 * back a challenge instead of a session (§13.2 V2-P5); {@link TwoFactorStep}
 * collects the second factor before the app opens.
 */
export function LoginPage() {
  const t = useT();
  const { status, login, adoptUser, persistSession } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = intendedPath(location.state);
  // An OAuth authorize flow bounces an anonymous visitor here with the full
  // `/oauth/authorize?…` URL stashed in `from` (see ConsentPage). Such a login
  // is special (V4-P2b, §399 §A): no "stay signed in" checkbox up front, and a
  // PIN-less account is never persisted — the checkbox appears only afterwards,
  // once the account is known to have a PIN.
  const oauthContext = from.startsWith('/oauth/authorize');

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Ticked by default: a normal login is persistent (§399 §A). Not shown in the
  // OAuth flow — the choice is deferred to the PIN-gated step below.
  const [staySignedIn, setStaySignedIn] = useState(true);
  // Non-null once the password step returns a 2FA challenge: swaps the password
  // form for the second-factor step.
  const [challenge, setChallenge] = useState<TwoFactorChallengeResponse | null>(null);
  // Non-null when an OAuth login on a PIN account must offer the "stay signed in
  // — your PIN protects this" choice before the app opens (V4-P2b).
  const [persistChoice, setPersistChoice] = useState<MeResponse | null>(null);

  if (status === 'loading') {
    return (
      <div className="grid min-h-screen place-items-center bg-[#0b0e14]">
        <Spinner label={t('auth.common.checkingSession')} />
      </div>
    );
  }
  // While the OAuth persist choice is up, the login is deliberately deferred
  // (status stays anonymous), so this guard doesn't fire mid-choice.
  if (status === 'authenticated') return <Navigate to={from} replace />;

  // Land an authenticated user. An OAuth login on a PIN account pauses on the
  // "stay signed in" step; everyone else proceeds. A normal login is already
  // applied by `login`, so only a deferred (OAuth) login needs adopting here.
  function landAuthenticated(me: MeResponse) {
    if (oauthContext && me.pinEnabled) {
      setPersistChoice(me);
      return;
    }
    if (oauthContext) adoptUser(me);
    navigate(from, { replace: true });
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const outcome = await login({
        identifier,
        password,
        // OAuth logins default to ephemeral; the persist step upgrades a PIN
        // account if the user opts in (§399 §A).
        staySignedIn: oauthContext ? false : staySignedIn,
        oauthLogin: oauthContext,
      });
      if (outcome.status === 'two_factor_required') {
        // Password verified but 2FA is on — collect the second factor next.
        setChallenge(outcome.challenge);
        return;
      }
      // On a forced-change account the app traps into the change screen
      // regardless of this navigation; for a normal account we land on `from`.
      landAuthenticated(outcome.me);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        // Rate-limited: show a dedicated message distinct from bad-credentials (§6.1).
        const wait = err.retryAfterSeconds
          ? t(
              err.retryAfterSeconds === 1
                ? 'auth.common.waitSecondsOne'
                : 'auth.common.waitSecondsOther',
              {
                count: err.retryAfterSeconds,
              },
            )
          : t('auth.common.waitMoment');
        setError(`${t('auth.login.rateLimited')}${wait}`);
      } else if (err instanceof AdminAccountError) {
        // Admin credentials on the user app: point them at the admin area (§10).
        setError(err.message);
      } else if (err instanceof ApiError && err.status === 403 && err.code === 'ACCOUNT_DISABLED') {
        // Correct password but the account is suspended: a distinct message,
        // separate from bad-credentials and the rate-limit notice (§6.1, §16).
        setError(t('auth.login.accountDisabled'));
      } else if (err instanceof ApiError && err.status >= 500) {
        setError(t('common.genericError'));
      } else {
        // Never distinguish "no such user" from "wrong password" (§6.1).
        setError(t('auth.login.invalidCredentials'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  // Checked before `challenge`: a 2FA OAuth login sets both, and the persist
  // choice takes precedence once the second factor has verified.
  if (persistChoice) {
    return (
      <OAuthStaySignedInStep
        onContinue={async (stay) => {
          // Opting in promotes the just-minted ephemeral session to persistent
          // (PIN-gated server-side); either way we then open the app (V4-P2b).
          if (stay) await persistSession();
          adoptUser(persistChoice);
          navigate(from, { replace: true });
        }}
      />
    );
  }

  if (challenge) {
    return (
      <TwoFactorStep
        challenge={challenge}
        deferApply={oauthContext}
        onVerified={(me) => landAuthenticated(me)}
        onCancel={() => {
          // Bail back to the password form — the pending challenge simply lapses.
          setChallenge(null);
          setPassword('');
          setError(null);
        }}
      />
    );
  }

  return (
    <AuthCard subtitle={t('auth.login.subtitle')}>
      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6"
      >
        {error ? <Alert tone="error">{error}</Alert> : null}
        <TextField
          label={t('auth.login.identifierLabel')}
          name="identifier"
          autoComplete="username"
          autoFocus
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          required
        />
        <TextField
          label={t('auth.login.passwordLabel')}
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {/* No "stay signed in" checkbox in the OAuth flow — the PIN-dependent
            choice appears post-credential-entry instead (§399 §A). */}
        {oauthContext ? null : (
          <label className="flex items-center gap-2.5">
            <input
              type="checkbox"
              name="staySignedIn"
              checked={staySignedIn}
              onChange={(e) => setStaySignedIn(e.target.checked)}
              className="h-4 w-4 rounded border-neutral-600 bg-neutral-950 text-sky-500 focus:ring-sky-500"
            />
            <span className="text-sm text-neutral-300">{t('auth.login.staySignedIn')}</span>
          </label>
        )}
        <Button type="submit" disabled={submitting}>
          {submitting ? t('auth.login.submitting') : t('auth.login.submit')}
        </Button>
        <Link
          to="/forgot-password"
          className="text-center text-sm font-medium text-sky-400 hover:text-sky-300"
        >
          {t('auth.login.forgotPassword')}
        </Link>
      </form>
    </AuthCard>
  );
}

/**
 * Login-time 2FA challenge step (§6.1, §13.2 V2-P5). Enter the authenticator
 * (TOTP) code or an emailed code, request an email code, or switch to a recovery
 * code. A valid factor promotes the pending challenge to a full session and the
 * app opens.
 */
export function TwoFactorStep({
  challenge,
  onVerified,
  onCancel,
  cancelLabel,
  deferApply = false,
}: {
  challenge: TwoFactorChallengeResponse;
  /** Receives the resolved user; the OAuth flow uses it to offer the persist choice. */
  onVerified: (me: MeResponse) => void;
  onCancel: () => void;
  cancelLabel?: string;
  /** Defer applying the session (OAuth flow) so a persist choice can precede it (V4-P2b). */
  deferApply?: boolean;
}) {
  const t = useT();
  const { verifyTwoFactor, requestTwoFactorEmailCode } = useAuth();
  const totpAvailable = challenge.channels.includes('totp');
  const emailAvailable = challenge.channels.includes('email');
  const recoveryAvailable = challenge.channels.includes('recovery');
  const resolvedCancelLabel = cancelLabel ?? t('auth.twoFactor.backToSignIn');

  // Tailor the prompt to the methods this account actually enabled (#298).
  const codePrompt = totpAvailable
    ? emailAvailable
      ? t('auth.twoFactor.promptTotpAndEmail')
      : t('auth.twoFactor.promptTotpOnly')
    : t('auth.twoFactor.promptEmailOnly');

  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setSubmitting(true);
    try {
      const me = await verifyTwoFactor(
        useRecovery
          ? { pendingToken: challenge.pendingToken, recoveryCode: value.trim() }
          : { pendingToken: challenge.pendingToken, code: value.trim() },
        deferApply,
      );
      onVerified(me);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError(t('auth.twoFactor.tooManyCodes'));
      } else if (err instanceof ApiError && err.code === 'TWO_FACTOR_PENDING_INVALID') {
        setError(t('auth.twoFactor.sessionExpired'));
      } else {
        setError(t('auth.twoFactor.invalidCode'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function onEmailCode() {
    setError(null);
    setInfo(null);
    setSendingCode(true);
    try {
      await requestTwoFactorEmailCode({ pendingToken: challenge.pendingToken });
      setInfo(t('auth.twoFactor.emailCodeSent'));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TWO_FACTOR_PENDING_INVALID') {
        setError(t('auth.twoFactor.sessionExpired'));
      } else {
        setError(t('auth.twoFactor.emailCodeFailed'));
      }
    } finally {
      setSendingCode(false);
    }
  }

  return (
    <AuthCard subtitle={t('auth.twoFactor.subtitle')}>
      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6"
      >
        {error ? <Alert tone="error">{error}</Alert> : null}
        {info ? <Alert tone="info">{info}</Alert> : null}
        <p className="text-sm text-neutral-400">
          {useRecovery ? t('auth.twoFactor.recoveryPrompt') : codePrompt}
        </p>
        <TextField
          label={
            useRecovery
              ? t('auth.twoFactor.recoveryCodeLabel')
              : t('auth.twoFactor.verificationCodeLabel')
          }
          name={useRecovery ? 'recoveryCode' : 'code'}
          autoComplete="one-time-code"
          inputMode={useRecovery ? 'text' : 'numeric'}
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
        />
        <Button type="submit" disabled={submitting || value.trim().length === 0}>
          {submitting ? t('auth.twoFactor.verifying') : t('auth.twoFactor.verify')}
        </Button>
        {emailAvailable && !useRecovery ? (
          <Button type="button" variant="secondary" onClick={onEmailCode} disabled={sendingCode}>
            {sendingCode ? t('auth.twoFactor.sendingEmailCode') : t('auth.twoFactor.emailMeACode')}
          </Button>
        ) : null}
        {recoveryAvailable ? (
          <button
            type="button"
            className="text-center text-sm font-medium text-sky-400 hover:text-sky-300"
            onClick={() => {
              setUseRecovery((v) => !v);
              setValue('');
              setError(null);
              setInfo(null);
            }}
          >
            {useRecovery
              ? t('auth.twoFactor.useAuthenticatorOrEmail')
              : t('auth.twoFactor.useRecoveryCode')}
          </button>
        ) : null}
        <button
          type="button"
          className="text-center text-sm font-medium text-neutral-400 hover:text-neutral-200"
          onClick={onCancel}
        >
          {resolvedCancelLabel}
        </button>
      </form>
    </AuthCard>
  );
}

/**
 * Post-credential-entry "stay signed in" choice for an OAuth authorize login on
 * an account WITH a PIN (PROJECTPLAN.md §16; owner spec #399 §A). The session is
 * already minted (ephemeral); ticking this promotes it to persistent —
 * acceptable here precisely because the PIN gates access. A PIN-less OAuth
 * account never reaches this step, so it can never persist a browser session.
 */
function OAuthStaySignedInStep({ onContinue }: { onContinue: (stay: boolean) => Promise<void> }) {
  const t = useT();
  const [stay, setStay] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleContinue() {
    setError(null);
    setSubmitting(true);
    try {
      await onContinue(stay);
    } catch {
      // Promotion failed — surface it and let them retry; the (ephemeral)
      // session is live regardless.
      setError(t('common.genericError'));
      setSubmitting(false);
    }
  }

  return (
    <AuthCard subtitle={t('auth.oauthStay.subtitle')}>
      <div className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6">
        {error ? <Alert tone="error">{error}</Alert> : null}
        <p className="text-sm text-neutral-400">{t('auth.oauthStay.description')}</p>
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            name="staySignedIn"
            checked={stay}
            onChange={(e) => setStay(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-neutral-600 bg-neutral-950 text-sky-500 focus:ring-sky-500"
          />
          <span className="text-sm text-neutral-300">
            {t('auth.oauthStay.checkboxLabel')}
            <span className="block text-xs text-neutral-500">
              {t('auth.oauthStay.checkboxHint')}
            </span>
          </span>
        </label>
        <Button type="button" onClick={handleContinue} disabled={submitting}>
          {submitting ? t('auth.oauthStay.continuing') : t('auth.oauthStay.continue')}
        </Button>
      </div>
    </AuthCard>
  );
}
