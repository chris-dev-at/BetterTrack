import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import {
  ADMIN_2FA_SETUP_REQUIRED,
  ADMIN_SESSION_LIFETIME_MAX_HOURS,
  type ChangePasswordRequest,
  type LoginRequest,
  type MeResponse,
  type TwoFactorChallengeResponse,
} from '@bettertrack/contracts';

import { ApiError, isConfirmedUnauthorized } from '../lib/apiClient';
import * as api from '../lib/adminApi';

/**
 * `password-change-required` — a live admin session whose account was reset and
 * still carries `mustChangePassword` (§6.1). The admin area traps into its own
 * forced-change screen until the change clears the flag, so a reset admin can
 * recover the account here instead of being bricked (#248 item 6).
 *
 * `two-factor-required` — the password step returned a login 2FA challenge for an
 * enrolled admin (no session cookie yet, §6.12 / #400). The area traps into the
 * verify screen ({@link twoFactorChallenge} holds the token + offered channels)
 * until a second factor promotes it to a real session.
 *
 * `two-factor-setup-required` — a live admin session with NO confirmed 2FA method.
 * Two-factor is mandatory for every admin (#400), so every data route answers 403
 * `ADMIN_2FA_SETUP_REQUIRED` and the area traps into the forced-enrollment wizard
 * until a method is confirmed. Mirrors the forced-change trap.
 */
type AuthStatus =
  | 'loading'
  | 'session-unavailable'
  | 'authenticated'
  | 'anonymous'
  | 'password-change-required'
  | 'two-factor-required'
  | 'two-factor-setup-required';

/** Thrown by {@link AuthContextValue.login} when valid creds belong to a non-admin. */
export class NotAdminError extends Error {
  constructor() {
    super('This is a user account, not an administrator — please sign in through the main app.');
    this.name = 'NotAdminError';
  }
}

/** True for the 403 the setup gate returns while a logged-in admin has no 2FA method (#400). */
export const isAdminTwoFactorSetupRequired = (err: unknown): boolean =>
  err instanceof ApiError && err.status === 403 && err.code === ADMIN_2FA_SETUP_REQUIRED;

/**
 * Why the console dropped a live session by itself (V5-P13c, §6.12).
 *
 * `expired` — the admin's absolute session window closed. Either the deadline
 * this provider holds passed while the console sat idle, or a request came back
 * 401/404 because the server had already retired the session. The login screen
 * says so, instead of leaving the operator with a save that "failed".
 *
 * An operator-initiated `logout()` and the 2FA challenge's own cancel carry no
 * reason — nothing expired there, so nothing is announced.
 */
export type AdminSignOutReason = 'expired';

/** One hour in ms — the unit the 6–24 h admin session policy is expressed in. */
const HOUR_MS = 3_600_000;

/**
 * How far this browser's clock may disagree with the server's before the derived
 * deadline is discarded as unusable (V5-P13c).
 *
 * The screen it feeds is measured against THIS session's configured window, not
 * the 24 h policy maximum: at a configured 24 h lifetime a maximum-width band
 * would reject any clock even slightly behind the server, silently disabling the
 * courtesy sign-out on every such install. One hour of slack keeps a normal
 * clock error inside the band; the only cost of tolerating it is a courtesy
 * timer that fires up to an hour late, and the server was never waiting for it.
 */
const CLOCK_TOLERANCE_MS = HOUR_MS;

interface AuthContextValue {
  status: AuthStatus;
  /** The current admin. Null while anonymous/loading, and while a reset admin is
   *  in the forced-change trap or an admin is in the 2FA challenge/setup traps
   *  (the identity isn't used until the trap clears). */
  user: MeResponse | null;
  /** Retry a bootstrap whose outcome is unknown because the backend was unreachable. */
  retrySession: () => void;
  /** The pending login 2FA challenge while `status === 'two-factor-required'`. */
  twoFactorChallenge: TwoFactorChallengeResponse | null;
  login: (credentials: LoginRequest) => Promise<void>;
  /**
   * Complete the pending login 2FA challenge with exactly one of a code (TOTP or
   * emailed) or a recovery code (§6.12, #400). On success the admin/mustChange/2FA
   * resolution runs, dropping the caller into the console, the forced-change trap,
   * or the enrollment wizard.
   */
  verifyTwoFactor: (body: { code?: string; recoveryCode?: string }) => Promise<void>;
  /** Send a one-time email login code for the pending challenge (§6.12, #400). */
  requestTwoFactorEmailCode: () => Promise<void>;
  /**
   * Complete a forced password change for the reset admin session, releasing the
   * trap (§6.1, #248 item 6). No current password is required — the temp-password
   * login is the proof (#248 item 7). Re-runs the 2FA resolution afterward, so a
   * reset admin who also lacks 2FA lands in the enrollment wizard next.
   */
  changePassword: (body: ChangePasswordRequest) => Promise<void>;
  /**
   * Re-resolve the session after the enrollment wizard confirms a method — flips
   * `two-factor-setup-required` to `authenticated` once the setup gate clears (#400).
   */
  completeTwoFactorSetup: () => Promise<void>;
  logout: () => Promise<void>;
  /**
   * Drop the in-memory session without an API round-trip. Pages call this when
   * a request comes back 401/404 mid-use (expired cookie, account disabled) so
   * the guard bounces back to the login screen. Pass `'expired'` when the cause
   * is the V5-P13c session window, so the login screen can say what happened.
   */
  clearSession: (reason?: AdminSignOutReason) => void;
  /**
   * Why the console signed itself out, for the login screen's notice. Null for
   * a plain anonymous bootstrap and for an operator-initiated sign-out.
   */
  signedOutReason: AdminSignOutReason | null;
  /**
   * Re-read the admin session window and recompute the local deadline. The
   * session-policy card calls this after a successful write so lowering the
   * lifetime shortens THIS console's deadline immediately, matching the
   * server's already-absolute, always-re-read enforcement.
   */
  refreshSessionDeadline: () => void;
  /**
   * Trap into the forced-enrollment wizard. The resource/error paths call this when
   * an admin request comes back 403 `ADMIN_2FA_SETUP_REQUIRED` mid-use (e.g. a
   * break-glass reset removed the last method), mirroring {@link clearSession} for
   * the 401/404 case (#400).
   */
  requireTwoFactorSetup: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<MeResponse | null>(null);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [twoFactorChallenge, setTwoFactorChallenge] = useState<TwoFactorChallengeResponse | null>(
    null,
  );
  const [signedOutReason, setSignedOutReason] = useState<AdminSignOutReason | null>(null);
  // Epoch ms at which this admin session's absolute window closes, or null while
  // it is unknown (not signed in, or the two reads behind it have not answered).
  const [sessionDeadline, setSessionDeadline] = useState<number | null>(null);
  const [sessionPolicyAttempt, setSessionPolicyAttempt] = useState(0);

  // Resolve an authenticated admin into the right screen: the forced-change trap,
  // the mandatory-2FA enrollment wizard, or the open console. The 2FA status
  // endpoint is EXEMPT from the setup gate, so it always answers for a live admin.
  const applyAdminSession = useCallback(
    async (me: MeResponse, signal?: AbortSignal): Promise<void> => {
      if (me.mustChangePassword) {
        setUser(null);
        setStatus('password-change-required');
        return;
      }
      let setupRequired = false;
      try {
        const twoFactor = await api.getTwoFactorStatus(signal);
        if (signal?.aborted) return;
        setupRequired = twoFactor.setupRequired;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (signal?.aborted) return;
        // The exempt status endpoint failed (network/5xx). Don't brick sign-in:
        // open the console optimistically. The API still returns 403
        // ADMIN_2FA_SETUP_REQUIRED on every other admin route when unenrolled,
        // and the resource paths trap that into the wizard reactively — so an
        // unenrolled admin can never actually reach protected data this way.
      }
      if (setupRequired) {
        setUser(null);
        setStatus('two-factor-setup-required');
        return;
      }
      setTwoFactorChallenge(null);
      setUser(me);
      setStatus('authenticated');
    },
    [],
  );

  const retrySession = useCallback(() => {
    setStatus('loading');
    setBootstrapAttempt((attempt) => attempt + 1);
  }, []);

  // Bootstrap from the session cookie. Anonymous, non-admin, and a confirmed
  // 401 resolve to "anonymous" — no route detail is surfaced. An
  // authenticated admin is routed through the same forced-change / 2FA resolution
  // as a fresh login, so a reload never skips the mandatory-2FA gate. An outage
  // holds a distinct retryable gate and never manufactures a signed-out state.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const me = await api.getMe(controller.signal);
        if (me.role !== 'admin') {
          setUser(null);
          setStatus('anonymous');
          return;
        }
        await applyAdminSession(me, controller.signal);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // A reset session is blocked from /auth/me by the forced-change guard
        // (403). Keep the admin in the trap so a reload doesn't bounce them out
        // mid-recovery (§6.1, #248 item 6).
        if (
          err instanceof ApiError &&
          err.status === 403 &&
          err.code === 'PASSWORD_CHANGE_REQUIRED'
        ) {
          setUser(null);
          setStatus('password-change-required');
        } else if (isConfirmedUnauthorized(err)) {
          setUser(null);
          setStatus('anonymous');
        } else {
          setStatus('session-unavailable');
        }
      }
    })();
    return () => controller.abort();
  }, [applyAdminSession, bootstrapAttempt]);

  const login = useCallback(
    async (credentials: LoginRequest) => {
      // A fresh sign-in answers the expiry notice — clear it before the attempt
      // so a failed one does not leave a stale "your session expired" beside a
      // credentials error.
      setSignedOutReason(null);
      const result = await api.login(credentials);
      // Enrolled admin: the password verified but no session was minted — hand
      // the challenge to the verify screen to collect a second factor (#400).
      if ('twoFactorRequired' in result) {
        setUser(null);
        setTwoFactorChallenge(result);
        setStatus('two-factor-required');
        return;
      }
      const me = result;
      if (me.role !== 'admin') {
        // A non-admin login still created a session — drop it so we never leave a
        // half-authenticated cookie behind, then point them at the main app.
        await api.logout().catch(() => undefined);
        throw new NotAdminError();
      }
      await applyAdminSession(me);
    },
    [applyAdminSession],
  );

  const verifyTwoFactor = useCallback(
    async (body: { code?: string; recoveryCode?: string }) => {
      if (!twoFactorChallenge) throw new Error('No pending two-factor challenge.');
      const me = await api.verifyTwoFactor(
        body.recoveryCode
          ? { pendingToken: twoFactorChallenge.pendingToken, recoveryCode: body.recoveryCode }
          : { pendingToken: twoFactorChallenge.pendingToken, code: body.code },
      );
      if (me.role !== 'admin') {
        await api.logout().catch(() => undefined);
        throw new NotAdminError();
      }
      await applyAdminSession(me);
    },
    [twoFactorChallenge, applyAdminSession],
  );

  const requestTwoFactorEmailCode = useCallback(async () => {
    if (!twoFactorChallenge) throw new Error('No pending two-factor challenge.');
    await api.requestTwoFactorEmailCode({ pendingToken: twoFactorChallenge.pendingToken });
  }, [twoFactorChallenge]);

  const changePassword = useCallback(
    async (body: ChangePasswordRequest) => {
      const me = await api.changePassword(body);
      if (me.role !== 'admin') {
        // A non-admin completed a forced change on the admin origin — they have no
        // admin area; drop the session and send them out.
        await api.logout().catch(() => undefined);
        setUser(null);
        setStatus('anonymous');
        throw new NotAdminError();
      }
      // Flag cleared and the session is still live — re-resolve, so a reset admin
      // who also lacks 2FA lands in the enrollment wizard rather than the console.
      await applyAdminSession(me);
    },
    [applyAdminSession],
  );

  const completeTwoFactorSetup = useCallback(async () => {
    // The wizard just confirmed a method; the session cookie is already live, so
    // re-read the identity and re-resolve — the setup gate is now clear.
    const me = await api.getMe();
    if (me.role !== 'admin') {
      setUser(null);
      setStatus('anonymous');
      return;
    }
    await applyAdminSession(me);
  }, [applyAdminSession]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
    } finally {
      setUser(null);
      setTwoFactorChallenge(null);
      setStatus('anonymous');
    }
  }, []);

  const clearSession = useCallback((reason?: AdminSignOutReason) => {
    setUser(null);
    setTwoFactorChallenge(null);
    setSessionDeadline(null);
    setSignedOutReason(reason ?? null);
    setStatus('anonymous');
  }, []);

  const refreshSessionDeadline = useCallback(
    () => setSessionPolicyAttempt((attempt) => attempt + 1),
    [],
  );

  /**
   * Hold the admin session's absolute deadline client-side (§13.5 V5-P13c).
   *
   * The server enforces the window on its own — it re-reads the configured
   * lifetime out of `app_settings` on every `resolveSession` and measures it from
   * the session's `createdAt`, so this provider is a courtesy, never the
   * authority. The courtesy matters because expiry is otherwise LAZY: a console
   * parked on a page with no live refresh keeps rendering fully-populated admin
   * data long after the session is dead, and the operator only discovers it by
   * clicking.
   *
   * Both halves of the deadline have to come off the wire. The lifetime is the
   * policy read; the anchor is this session's own `createdAt`, which
   * `GET /auth/sessions` marks as `current` — deriving it from "when this tab
   * loaded" instead would hand a console reloaded 11 h into a 12 h window a
   * fresh 12 h. A failure in either read leaves the deadline unknown rather than
   * guessed: the write and read seams still sign out on the next 401/404.
   */
  useEffect(() => {
    if (status !== 'authenticated') {
      setSessionDeadline(null);
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const [policy, sessions] = await Promise.all([
          api.getSessionPolicy(controller.signal),
          api.listOwnSessions(controller.signal),
        ]);
        if (controller.signal.aborted) return;
        const current = sessions.find((session) => session.current);
        // No `current` row, or a malformed timestamp (NaN would arm a zero-delay
        // timer and sign a working admin out instantly): the derivation produced
        // nothing usable, so drop any deadline it produced before. "Unknown stays
        // unknown" has to include forgetting a previous answer, or a re-read that
        // came back empty would leave the older, differently-derived deadline armed.
        if (!current) {
          setSessionDeadline(null);
          return;
        }
        const sessionWindow = policy.sessionLifetimeHours * HOUR_MS;
        const deadline = new Date(current.createdAt).getTime() + sessionWindow;
        if (!Number.isFinite(deadline)) {
          setSessionDeadline(null);
          return;
        }
        // Clock-disagreement screen, applied HERE because this is the one moment
        // the session is provably alive: the server just answered both reads on
        // this very cookie, and it re-reads the lifetime on every resolution. So
        // the session's true remaining time is inside `(0, sessionWindow]` — a
        // computed value outside that band is this browser's clock disagreeing
        // with the server's, in one direction or the other, and unknown is the
        // safe state (the write/read seams still sign out on the next 401/404).
        //
        // Both directions matter, for different reasons. A clock running AHEAD
        // lands `remaining <= 0` here, and accepting it would sign the admin out
        // on the very first evaluation after every successful login — an endless
        // login → "your session expired" loop. A clock running BEHIND pushes the
        // deadline past the window, and accepting it would arm a timer later than
        // the truth. Screening both leaves at most `skew` of premature courtesy
        // sign-out for a clock ahead by less than the window, which is a timer of
        // positive length, never an instant bounce.
        const remaining = deadline - Date.now();
        if (remaining <= 0 || remaining > sessionWindow + CLOCK_TOLERANCE_MS) {
          setSessionDeadline(null);
          return;
        }
        setSessionDeadline(deadline);
      } catch {
        // Unreadable window — see above. Never manufacture a sign-out from it.
      }
    })();
    return () => controller.abort();
  }, [status, sessionPolicyAttempt]);

  // Sign out the moment the window closes, without waiting for a click.
  useEffect(() => {
    if (status !== 'authenticated' || sessionDeadline === null) return;
    const remaining = sessionDeadline - Date.now();
    // A stored deadline was in the future when it was derived (see the screen
    // above), so reaching zero here means time actually passed: either the
    // console sat parked through the window, or a policy write shortened it. Both
    // are real expiries, not a browser clock running ahead.
    if (remaining <= 0) {
      clearSession('expired');
      return;
    }
    // Defence in depth for the same screen: never arm a timer further out than
    // the widest window the policy allows, plus the skew the screen tolerates.
    if (remaining > ADMIN_SESSION_LIFETIME_MAX_HOURS * HOUR_MS + CLOCK_TOLERANCE_MS) return;
    const timer = setTimeout(() => clearSession('expired'), remaining);
    return () => clearTimeout(timer);
  }, [status, sessionDeadline, clearSession]);

  const requireTwoFactorSetup = useCallback(() => {
    setUser(null);
    setTwoFactorChallenge(null);
    setStatus('two-factor-setup-required');
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      retrySession,
      twoFactorChallenge,
      login,
      verifyTwoFactor,
      requestTwoFactorEmailCode,
      changePassword,
      completeTwoFactorSetup,
      logout,
      clearSession,
      signedOutReason,
      refreshSessionDeadline,
      requireTwoFactorSetup,
    }),
    [
      status,
      user,
      retrySession,
      twoFactorChallenge,
      login,
      verifyTwoFactor,
      requestTwoFactorEmailCode,
      changePassword,
      completeTwoFactorSetup,
      logout,
      clearSession,
      signedOutReason,
      refreshSessionDeadline,
      requireTwoFactorSetup,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider.');
  return ctx;
}
