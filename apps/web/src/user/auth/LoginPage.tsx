import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';

import type {
  MeResponse,
  RegistrationMode,
  TwoFactorChallengeResponse,
} from '@bettertrack/contracts';

import { useT, type TranslateFn } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import * as userApi from '../../lib/userApi';
import { AdminAccountError, useAuth } from '../AuthContext';
import { Alert, AuthCard, Button, Spinner, TextField, cx } from '../components/ui';
import { GoogleButton } from './GoogleButton';
import { OAuthAccountChooser } from './OAuthAccountChooser';
import {
  hasBeenAskedToRemember,
  markAskedToRemember,
  readLastLoginIdentifier,
  readRememberedAccount,
  writeLastLoginIdentifier,
  type RememberedAccount,
} from './rememberedAccount';

/** Where to land after a successful sign-in: the intended route, else home. */
function intendedPath(state: unknown): string {
  if (state && typeof state === 'object' && 'from' in state) {
    const from = (state as { from?: unknown }).from;
    if (typeof from === 'string' && from.startsWith('/') && !from.startsWith('//')) return from;
  }
  return '/';
}

const GOOGLE_ERROR_KEYS: Record<string, string> = {
  google_state: 'auth.google.errorState',
  google_verify: 'auth.google.errorVerify',
  google_registration_closed: 'auth.google.errorRegistrationClosed',
  google_email_taken: 'auth.google.errorEmailTaken',
  google_invite_required: 'auth.google.errorInviteRequired',
  google_account_disabled: 'auth.google.errorAccountDisabled',
  google_admin: 'auth.google.errorAdmin',
  google_already_linked: 'auth.google.errorAlreadyLinked',
};

/**
 * The notice the Google callback bounces back through the URL (§13.4 V4-P4b): an
 * error code (`?error=google_*`) → an error Alert, or `?google=pending` (an
 * approval-mode application) → an info Alert. Anything else → no notice.
 */
function googleNoticeFromSearch(
  search: string,
  t: TranslateFn,
): { tone: 'error' | 'info'; text: string } | null {
  const params = new URLSearchParams(search);
  const error = params.get('error');
  if (error && error.startsWith('google_')) {
    return { tone: 'error', text: t(GOOGLE_ERROR_KEYS[error] ?? 'auth.google.errorGeneric') };
  }
  if (params.get('google') === 'pending') {
    return { tone: 'info', text: t('auth.google.pending') };
  }
  return null;
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
  const { status, login, adoptUser, persistSession, rememberThisDevice, forgetRememberedAccount } =
    useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = intendedPath(location.state);
  // An OAuth authorize flow bounces an anonymous visitor here with the full
  // `/oauth/authorize?…` URL stashed in `from` (see ConsentPage). Such a login
  // is special (V4-P2b, §399 §A): no "stay signed in" checkbox up front, and a
  // PIN-less account is never persisted — the checkbox appears only afterwards,
  // once the account is known to have a PIN.
  const oauthContext = from.startsWith('/oauth/authorize');
  // State-ladder step 2 (§399 §B): a device that remembers a PIN user shows the
  // "Log in as [name]? / Another account" chooser instead of a blank login. Read
  // once; "Another account" clears it (→ blank login). Step 1 (a live PIN-gated
  // session) never reaches here — UserShell shows the PIN gate above routing.
  const [remembered, setRemembered] = useState<RememberedAccount | null>(() =>
    oauthContext ? readRememberedAccount() : null,
  );

  // Always-on username memory (V4-P0 (g)): the identifier prefills from the
  // last successful login — no toggle, no ask. Stays out of the OAuth chooser
  // path, which is driven by the #419 device binding above.
  const [identifier, setIdentifier] = useState(() => readLastLoginIdentifier() ?? '');
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
  // The active registration mode (§13.4 V4-P4a): drives whether a "create an
  // account" link is offered. Best-effort — a fetch failure just hides the link.
  const [registrationMode, setRegistrationMode] = useState<RegistrationMode | null>(null);
  // Whether "Continue with Google" is offered (§13.4 V4-P4b) — env-gated on the
  // server. Best-effort like the mode: a fetch failure just hides the button.
  const [googleEnabled, setGoogleEnabled] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const info = await userApi.getRegistrationInfo(controller.signal);
        setRegistrationMode(info.mode);
        setGoogleEnabled(info.googleEnabled);
      } catch {
        // Best-effort: a fetch failure just hides the "create an account" link.
      }
    })();
    return () => controller.abort();
  }, []);

  // A message bounced back from the Google callback (§13.4 V4-P4b): `?error=…`
  // for a failed sign-in, `?google=pending` for an approval-mode application.
  const googleNotice = googleNoticeFromSearch(location.search, t);

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
      // Password verified (login only returns a session/challenge after a
      // successful password) — remember the identifier for the next visit
      // (V4-P0 (g)). Wrong passwords never reach here, so the memory only
      // ever holds an identifier the server has just recognized.
      writeLastLoginIdentifier(identifier);
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

  // State-ladder step 2 (§399 §B): a remembered PIN user with no session gets
  // the "Log in as [name]? / Another account" chooser instead of a blank login.
  // Always interposed — never skipped — so switching accounts is one tap away.
  // "Another account" clears the memory; the flow drops to the blank form below.
  if (oauthContext && remembered) {
    return (
      <OAuthAccountChooser
        account={remembered}
        // quickAuth (inside the chooser) already adopted the user — just land on
        // the authorize URL; the authenticated guard above is the backstop.
        onAuthenticated={() => navigate(from, { replace: true })}
        onAnotherAccount={() => {
          void forgetRememberedAccount();
          setRemembered(null);
        }}
      />
    );
  }

  // Checked before `challenge`: a 2FA OAuth login sets both, and the persist
  // choice takes precedence once the second factor has verified.
  if (persistChoice) {
    return (
      <OAuthStaySignedInStep
        // The one-time remember-me prompt rides this same PIN-user step (owner:
        // "asked once"). Hidden once this device has already asked this user.
        showRemember={!hasBeenAskedToRemember(persistChoice.id)}
        onContinue={async ({ stay, remember }) => {
          // Opting in promotes the just-minted ephemeral session to persistent
          // (PIN-gated server-side). A promotion failure must NOT strand the
          // OAuth authorize flow — the (ephemeral) session is already live, so
          // we fall through and open the app either way (V4-P2b).
          if (stay) {
            try {
              await persistSession();
            } catch {
              // Non-fatal: proceed as an ephemeral session rather than block.
            }
          }
          // Remember-me opt-in (§399 §B): bind this device so the next OAuth flow
          // is chooser → PIN. Also non-fatal — never strand the authorize flow.
          if (remember) {
            try {
              await rememberThisDevice();
            } catch {
              // Non-fatal: proceed without remembering rather than block.
            }
          }
          // Asked once, whether accepted or declined — don't re-prompt this user.
          markAskedToRemember(persistChoice.id);
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
      {googleNotice ? (
        <div className="mb-4">
          <Alert tone={googleNotice.tone}>{googleNotice.text}</Alert>
        </div>
      ) : null}
      {/* Final layout (owner 2026-07-17, V5-P0 arc (a)): "Continue with Google"
          sits on top; the password form follows; the prominent sign-up box
          returns to the very bottom with an OR divider restored between the
          form and it (partially reverts the #525 addendum ordering). The
          OAuth-authorize flow keeps only the password form (its post-sign-in
          redirect would drop the sign-up / Google context). */}
      {/* (1) Google sign-in (§13.4 V4-P4b). Shown whenever the deployment has
          Google configured (so existing Google-linked users can sign in even in
          `closed` mode), but never inside the OAuth-authorize flow. */}
      {googleEnabled && !oauthContext ? (
        <div className="mb-4">
          <GoogleButton />
        </div>
      ) : null}
      {/* (2) Password login form. */}
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
      {/* (3) Self-serve registration treatment (V4-P0 (f), §13.4): a designed,
          stand-out card, at the very bottom with an OR divider above it. Shown
          only when the instance allows registration and never in the OAuth flow. */}
      {!oauthContext && registrationMode && registrationMode !== 'closed' ? (
        <div className="mt-4 flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-neutral-800" />
            <span className="text-xs uppercase tracking-wide text-neutral-600">
              {t('common.or')}
            </span>
            <span className="h-px flex-1 bg-neutral-800" />
          </div>
          <div className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
            <p className="text-center text-xs font-medium uppercase tracking-wide text-neutral-500">
              {t('auth.login.newHere')}
            </p>
            <Link
              to="/register"
              className={cx(
                'inline-flex w-full items-center justify-center rounded-md px-3 py-2 text-sm font-semibold',
                'border border-sky-700 bg-neutral-950 text-sky-300 transition-colors',
                'hover:border-sky-500 hover:bg-neutral-900 hover:text-sky-200',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
              )}
            >
              {t('auth.login.signUp')}
            </Link>
          </div>
        </div>
      ) : null}
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
 * Post-credential-entry choice for an OAuth authorize login on an account WITH a
 * PIN (PROJECTPLAN.md §16; owner spec #399 §A + §B). Two independent opt-ins on
 * one step (PIN-less accounts never reach it, so neither is ever offered without
 * a PIN):
 *
 *  - **Stay signed in (§A):** the session is already minted (ephemeral); ticking
 *    promotes it to persistent — acceptable precisely because the PIN gates access.
 *  - **Remember me on this device (§B):** binds this device so the next OAuth flow
 *    is "tap your name → enter your PIN". Shown only once per device per user
 *    (`showRemember`), so it does not nag on every login.
 */
function OAuthStaySignedInStep({
  showRemember,
  onContinue,
}: {
  showRemember: boolean;
  onContinue: (opts: { stay: boolean; remember: boolean }) => Promise<void>;
}) {
  const t = useT();
  const [stay, setStay] = useState(false);
  const [remember, setRemember] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleContinue() {
    setError(null);
    setSubmitting(true);
    try {
      await onContinue({ stay, remember: showRemember && remember });
    } catch {
      // Defensive: persist/remember failures are swallowed by the caller
      // (non-fatal), so this only fires on an unexpected error while landing —
      // surface it and let them retry; the (ephemeral) session is live regardless.
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
        {showRemember ? (
          <label className="flex items-start gap-2.5">
            <input
              type="checkbox"
              name="rememberDevice"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-neutral-600 bg-neutral-950 text-sky-500 focus:ring-sky-500"
            />
            <span className="text-sm text-neutral-300">
              {t('auth.oauthRemember.checkboxLabel')}
              <span className="block text-xs text-neutral-500">
                {t('auth.oauthRemember.checkboxHint')}
              </span>
            </span>
          </label>
        ) : null}
        <Button type="button" onClick={handleContinue} disabled={submitting}>
          {submitting ? t('auth.oauthStay.continuing') : t('auth.oauthStay.continue')}
        </Button>
      </div>
    </AuthCard>
  );
}
