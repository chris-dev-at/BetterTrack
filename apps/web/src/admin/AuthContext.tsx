import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import {
  ADMIN_2FA_SETUP_REQUIRED,
  type ChangePasswordRequest,
  type LoginRequest,
  type MeResponse,
  type TwoFactorChallengeResponse,
} from '@bettertrack/contracts';

import { ApiError } from '../lib/apiClient';
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

interface AuthContextValue {
  status: AuthStatus;
  /** The current admin. Null while anonymous/loading, and while a reset admin is
   *  in the forced-change trap or an admin is in the 2FA challenge/setup traps
   *  (the identity isn't used until the trap clears). */
  user: MeResponse | null;
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
   * the guard bounces back to the login screen.
   */
  clearSession: () => void;
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
  const [twoFactorChallenge, setTwoFactorChallenge] = useState<TwoFactorChallengeResponse | null>(
    null,
  );

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

  // Bootstrap from the session cookie. Anonymous, non-admin, and 401/404
  // responses all resolve to "anonymous" — no route detail is surfaced. An
  // authenticated admin is routed through the same forced-change / 2FA resolution
  // as a fresh login, so a reload never skips the mandatory-2FA gate.
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
        } else {
          setUser(null);
          setStatus('anonymous');
        }
      }
    })();
    return () => controller.abort();
  }, [applyAdminSession]);

  const login = useCallback(
    async (credentials: LoginRequest) => {
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

  const clearSession = useCallback(() => {
    setUser(null);
    setTwoFactorChallenge(null);
    setStatus('anonymous');
  }, []);

  const requireTwoFactorSetup = useCallback(() => {
    setUser(null);
    setTwoFactorChallenge(null);
    setStatus('two-factor-setup-required');
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      twoFactorChallenge,
      login,
      verifyTwoFactor,
      requestTwoFactorEmailCode,
      changePassword,
      completeTwoFactorSetup,
      logout,
      clearSession,
      requireTwoFactorSetup,
    }),
    [
      status,
      user,
      twoFactorChallenge,
      login,
      verifyTwoFactor,
      requestTwoFactorEmailCode,
      changePassword,
      completeTwoFactorSetup,
      logout,
      clearSession,
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
