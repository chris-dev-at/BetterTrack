import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import { useQueryClient } from '@tanstack/react-query';

import type {
  AcceptInviteRequest,
  ChangePasswordRequest,
  LoginRequest,
  MeResponse,
  PasswordResetComplete,
  PinVerifyRequest,
  TwoFactorChallengeResponse,
  TwoFactorEmailCodeRequest,
  TwoFactorVerifyRequest,
} from '@bettertrack/contracts';
import { DEFAULT_PIN_WINDOW_MINUTES } from '@bettertrack/contracts';

import { ApiError, setAuthResponsePolicy } from '../lib/apiClient';
import * as api from '../lib/userApi';

/**
 * `loading` — bootstrapping from the session cookie.
 * `anonymous` — no usable session; the guard sends `user` routes to `/login`.
 * `authenticated` — a normal session the app can use.
 * `password-change-required` — a live session whose user must change their
 *   password before reaching anything else (§6.1). The app traps every route
 *   into the forced-change screen until it clears.
 * `pin-required` — a live session whose account has the PIN gate on, opened in
 *   a browsing session that hasn't entered the PIN yet (§6.1). The app traps
 *   every route into the PIN gate until a correct PIN (or sign-out) clears it.
 */
export type AuthStatus =
  | 'loading'
  | 'anonymous'
  | 'authenticated'
  | 'password-change-required'
  | 'pin-required';

/**
 * The app-lock as an **unlock-window (TTL) model** (§6.1, §13.2 V2-P2; owner
 * directive #288). With a PIN enabled, every successful unlock — a password login
 * *or* entering the PIN at the gate — opens a fixed window (the user's configured
 * minutes, default {@link DEFAULT_PIN_WINDOW_MINUTES}). Inside that window nothing
 * ever prompts: reloads, navigation and new tabs on the same session all pass.
 * When the window elapses the gate re-engages — in place while the app sits open,
 * or before any data on the next open/refresh.
 *
 * The window is an **absolute expiry timestamp persisted in `localStorage`**,
 * scoped to the user id. That is the whole point of the redesign and why the old
 * timer was dead (see below): the source of truth is a timestamp read on every
 * render/reload, not an in-memory flag (which #259 lost on reload) nor an
 * activity-reset countdown fed by AuthContext's private `user` state (which a
 * Settings change never refreshed, so the timer stayed disarmed all session).
 *
 * Persisting an *expiry* is not the #248 §2 bug (which persisted a permanent
 * "unlocked=true" so a reload skipped the gate forever): once the timestamp is in
 * the past the gate returns. The httpOnly session lifetime is untouched — the
 * lock gates the UI, not the session.
 */

/** `localStorage` key holding the current unlock window's absolute expiry. */
const PIN_UNLOCK_STORAGE_KEY = 'bettertrack.pinUnlock';

interface StoredUnlock {
  /** User id the window belongs to — a different account never inherits it. */
  u: string;
  /** Absolute expiry, epoch ms. */
  e: number;
}

/** Read the unlock-window expiry for this user, or null if none/other user. */
function readUnlockExpiry(userId: string): number | null {
  try {
    const raw = localStorage.getItem(PIN_UNLOCK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredUnlock>;
    if (parsed.u !== userId || typeof parsed.e !== 'number') return null;
    return parsed.e;
  } catch {
    // Storage unavailable/corrupt → treat as locked; the gate is the safe default.
    return null;
  }
}

/** Open a fresh unlock window for `me`, sized by their configured minutes. */
function startUnlockWindow(me: MeResponse): void {
  const minutes = me.pinLockIdleMinutes ?? DEFAULT_PIN_WINDOW_MINUTES;
  const expiresAt = Date.now() + minutes * 60_000;
  try {
    localStorage.setItem(PIN_UNLOCK_STORAGE_KEY, JSON.stringify({ u: me.id, e: expiresAt }));
  } catch {
    // No persistence available — the app-open still succeeds; the window then
    // simply can't outlive this JS context (a reload re-gates), which is safe.
  }
}

/** Drop any unlock window (sign-out / session end). */
function clearUnlockWindow(): void {
  try {
    localStorage.removeItem(PIN_UNLOCK_STORAGE_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

/** Whether `me` is inside a still-valid unlock window right now. */
function isWithinUnlockWindow(me: MeResponse): boolean {
  const expiry = readUnlockExpiry(me.id);
  return expiry != null && expiry > Date.now();
}

/**
 * Result of a password login (§6.1, §13.2 V2-P5). A no-2FA account lands
 * `authenticated` (the context is already updated); a 2FA account lands
 * `two_factor_required` with the challenge the caller must complete via
 * {@link AuthContextValue.verifyTwoFactor} before a session exists.
 */
export type LoginOutcome =
  | { status: 'authenticated' }
  | { status: 'two_factor_required'; challenge: TwoFactorChallengeResponse };

interface AuthContextValue {
  status: AuthStatus;
  /** The current user. Null while anonymous/loading, and may be null in the
   *  forced-change state when we only learned of the lock from a `403` (the
   *  identity isn't disclosed until the password is changed). */
  user: MeResponse | null;
  login: (credentials: LoginRequest) => Promise<LoginOutcome>;
  /** Complete a login 2FA challenge; on success the app lands authenticated. */
  verifyTwoFactor: (body: TwoFactorVerifyRequest) => Promise<void>;
  /** Request a one-time email login code for a pending 2FA challenge. */
  requestTwoFactorEmailCode: (body: TwoFactorEmailCodeRequest) => Promise<void>;
  acceptInvite: (body: AcceptInviteRequest) => Promise<void>;
  /** Complete a self-service password reset; the API signs the user straight in. */
  completePasswordReset: (body: PasswordResetComplete) => Promise<void>;
  changePassword: (body: ChangePasswordRequest) => Promise<void>;
  /** Verify the PIN for the current session, releasing the `pin-required` trap. */
  verifyPin: (body: PinVerifyRequest) => Promise<void>;
  logout: () => Promise<void>;
  /** Non-null while a 429 toast should be visible. Cleared on dismiss. */
  rateLimitBanner: string | null;
  clearRateLimitBanner: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Thrown by {@link AuthContextValue.login} when the credentials belong to an
 * administrator account. Account kinds are disjoint (§3, §5.5, §10): admins
 * have no user-app workspace, so the login is rejected here and the message
 * points them at the admin area.
 */
export class AdminAccountError extends Error {
  constructor() {
    super('This is an administrator account. Please sign in through the admin area.');
    this.name = 'AdminAccountError';
  }
}

const isPasswordChangeRequired = (err: unknown): boolean =>
  err instanceof ApiError && err.status === 403 && err.code === 'PASSWORD_CHANGE_REQUIRED';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<MeResponse | null>(null);
  const [rateLimitBanner, setRateLimitBanner] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // Apply a resolved /auth/me-or-login user to local state, routing a
  // forced-change account into its trap, and a PIN-gated account whose unlock
  // window has lapsed (or never opened) into the PIN gate. Note this only *reads*
  // the window — a reload/refetch must never extend it; only an actual unlock
  // (login / PIN entry) calls startUnlockWindow.
  const applyUser = useCallback((me: MeResponse) => {
    setUser(me);
    if (me.mustChangePassword) {
      setStatus('password-change-required');
    } else if (me.pinEnabled && !isWithinUnlockWindow(me)) {
      setStatus('pin-required');
    } else {
      setStatus('authenticated');
    }
  }, []);

  // Drops every trace of the signed-out user: the unlock window, the auth state
  // itself, and the entire TanStack Query cache. Without the cache clear a
  // subsequent login as a *different* account could briefly (or, for queries
  // with a nonzero staleTime, not-so-briefly) render the previous user's
  // cached name/email/portfolio/notifications before a refetch overwrote it.
  const clearSession = useCallback(() => {
    clearUnlockWindow();
    setUser(null);
    setStatus('anonymous');
    queryClient.clear();
  }, [queryClient]);

  // Latest clearSession, so the (mount-once) global policy never goes stale.
  const clearSessionRef = useRef(clearSession);
  clearSessionRef.current = clearSession;

  // Register the app-wide auth/redirect/toast policy once, for as long as the
  // user app is mounted (the admin world, mounted on a disjoint route, never
  // sets one). A `401` from any application call drops the session so the
  // guard bounces to `/login`; a `403 PASSWORD_CHANGE_REQUIRED` springs the
  // trap; a `429` surfaces a dismissable banner (§7.4).
  // The auth endpoints themselves opt out of this (see userApi).
  useEffect(() => {
    return setAuthResponsePolicy({
      onUnauthorized: () => clearSessionRef.current(),
      onPasswordChangeRequired: () => setStatus('password-change-required'),
      onRateLimited: (seconds?: number) => {
        const wait =
          seconds && seconds > 0
            ? ` Please wait ${seconds} second${seconds === 1 ? '' : 's'} and try again.`
            : ' Please slow down.';
        setRateLimitBanner(`You're doing that too fast.${wait}`);
      },
    });
  }, []);

  // Bootstrap from the session cookie. 401 → anonymous; a forced-change session
  // (403, or a stray must-change me) → the trap; anything else → anonymous.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const me = await api.getMe(controller.signal);
        // An admin who still holds a session (e.g. arrived from the admin area)
        // has no user-app workspace — treat as anonymous rather than admitting
        // them here (§3, §5.5, §10).
        if (me.role === 'admin') {
          setUser(null);
          setStatus('anonymous');
          return;
        }
        applyUser(me);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (isPasswordChangeRequired(err)) {
          setUser(null);
          setStatus('password-change-required');
        } else {
          setUser(null);
          setStatus('anonymous');
        }
      }
    })();
    return () => controller.abort();
  }, [applyUser]);

  // Engage the gate the moment the unlock window expires while the app sits open
  // (§6.1, §13.2 V2-P2; #288). The window is absolute — set once at unlock, never
  // extended by activity — so this is a single timer to its stored expiry, not an
  // activity-reset countdown. Entering the PIN opens a new window, flips status
  // back to `authenticated`, and re-runs this effect to arm the next timer.
  const pinEnabled = user?.pinEnabled ?? false;
  const userId = user?.id ?? null;
  useEffect(() => {
    if (status !== 'authenticated' || !pinEnabled || userId == null) return;
    const expiry = readUnlockExpiry(userId);
    if (expiry == null) return;
    const lock = () => setStatus('pin-required');
    const remaining = expiry - Date.now();
    if (remaining <= 0) {
      lock();
      return;
    }
    const timer = setTimeout(lock, remaining);
    return () => clearTimeout(timer);
  }, [status, pinEnabled, userId]);

  const login = useCallback(
    async (credentials: LoginRequest): Promise<LoginOutcome> => {
      const result = await api.login(credentials);
      // 2FA on: no session was minted — hand the challenge back so the login
      // screen can collect a second factor (§6.1, §13.2 V2-P5).
      if ('twoFactorRequired' in result) {
        return { status: 'two_factor_required', challenge: result };
      }
      const me = result;
      if (me.role === 'admin') {
        // A valid admin login still minted a session cookie — drop it so no
        // half-authenticated admin session lingers on the user origin.
        await api.logout().catch(() => undefined);
        throw new AdminAccountError();
      }
      // A fresh password login is a stronger factor than the PIN — open a fresh
      // unlock window so the user isn't gated again in the same breath.
      startUnlockWindow(me);
      applyUser(me);
      return { status: 'authenticated' };
    },
    [applyUser],
  );

  const verifyTwoFactor = useCallback(
    async (body: TwoFactorVerifyRequest) => {
      const me = await api.verifyTwoFactor(body);
      if (me.role === 'admin') {
        // Defensive: admin-kind 2FA is out of scope, but never admit an admin
        // to the user app if one ever reaches here.
        await api.logout().catch(() => undefined);
        throw new AdminAccountError();
      }
      // Verifying a second factor completed a fresh login — opens a fresh window.
      startUnlockWindow(me);
      applyUser(me);
    },
    [applyUser],
  );

  const requestTwoFactorEmailCode = useCallback(
    (body: TwoFactorEmailCodeRequest) => api.requestTwoFactorEmailCode(body),
    [],
  );

  const acceptInvite = useCallback(
    async (body: AcceptInviteRequest) => {
      // A fresh invite account is created active with no forced change, so this
      // lands authenticated; applyUser keeps it correct either way.
      const me = await api.acceptInvite(body);
      startUnlockWindow(me);
      applyUser(me);
    },
    [applyUser],
  );

  const completePasswordReset = useCallback(
    async (body: PasswordResetComplete) => {
      // The reset mints a fresh session server-side and returns the usable user,
      // so this lands authenticated; a fresh credential opens a fresh window.
      const me = await api.completePasswordReset(body);
      startUnlockWindow(me);
      applyUser(me);
    },
    [applyUser],
  );

  const changePassword = useCallback(
    async (body: ChangePasswordRequest) => {
      // Success rotates the session and clears the flag — the response is a
      // fresh, usable user, releasing the forced-change trap and opening a window.
      const me = await api.changePassword(body);
      startUnlockWindow(me);
      applyUser(me);
    },
    [applyUser],
  );

  const verifyPin = useCallback(
    async (body: PinVerifyRequest) => {
      try {
        const me = await api.verifyPin(body);
        // A correct PIN opens the next unlock window.
        startUnlockWindow(me);
        applyUser(me);
      } catch (err) {
        // Too many wrong PINs: the server dropped the session, so fall all the
        // way back to anonymous → the guard routes to the login screen.
        if (err instanceof ApiError && err.code === 'PIN_FALLBACK_LOGIN') {
          clearSession();
        }
        throw err;
      }
    },
    [applyUser, clearSession],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
    } finally {
      clearSession();
    }
  }, [clearSession]);

  const clearRateLimitBanner = useCallback(() => setRateLimitBanner(null), []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      login,
      verifyTwoFactor,
      requestTwoFactorEmailCode,
      acceptInvite,
      completePasswordReset,
      changePassword,
      verifyPin,
      logout,
      rateLimitBanner,
      clearRateLimitBanner,
    }),
    [
      status,
      user,
      login,
      verifyTwoFactor,
      requestTwoFactorEmailCode,
      acceptInvite,
      completePasswordReset,
      changePassword,
      verifyPin,
      logout,
      rateLimitBanner,
      clearRateLimitBanner,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider.');
  return ctx;
}
