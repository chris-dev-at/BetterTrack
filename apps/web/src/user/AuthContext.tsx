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
} from '@bettertrack/contracts';

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
 * The WhatsApp-style app-lock (§6.1, §13.2 V2-P2): with a PIN enabled the SPA
 * must show the PIN screen every time the app is (re)opened, and optionally
 * after an idle timeout. "Unlocked" is therefore deliberately **in-memory only**
 * — it lives for the lifetime of *this* mounted `AuthProvider* and nothing else.
 * A page (re)load starts a fresh JS context in which this is `false`, so the
 * gate reappears before any data renders; a fresh password login (a stronger
 * factor) marks it satisfied so the user isn't gated twice in one breath. It is
 * never persisted to storage — persisting it is exactly the bug (#248 §2) where
 * a reload silently skipped the gate. The httpOnly session lifetime is untouched
 * by all of this: the lock gates the UI, not the session.
 */

/** Default idle events that count as "activity" and reset the AFK auto-lock timer. */
const AFK_ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'] as const;

interface AuthContextValue {
  status: AuthStatus;
  /** The current user. Null while anonymous/loading, and may be null in the
   *  forced-change state when we only learned of the lock from a `403` (the
   *  identity isn't disclosed until the password is changed). */
  user: MeResponse | null;
  login: (credentials: LoginRequest) => Promise<void>;
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

  // Whether the PIN app-lock has been satisfied for this app-open (see the note
  // above): in-memory only, reset on every fresh mount / reload and on sign-out.
  const pinUnlockedRef = useRef(false);

  // Apply a resolved /auth/me-or-login user to local state, routing a
  // forced-change account into its trap, and a PIN-gated account that hasn't
  // been unlocked this app-open into the PIN gate.
  const applyUser = useCallback((me: MeResponse) => {
    setUser(me);
    if (me.mustChangePassword) {
      setStatus('password-change-required');
    } else if (me.pinEnabled && !pinUnlockedRef.current) {
      setStatus('pin-required');
    } else {
      setStatus('authenticated');
    }
  }, []);

  // Drops every trace of the signed-out user: the PIN-satisfied flag, the auth
  // state itself, and the entire TanStack Query cache. Without the cache clear
  // a subsequent login as a *different* account could briefly (or, for queries
  // with a nonzero staleTime, not-so-briefly) render the previous user's
  // cached name/email/portfolio/notifications before a refetch overwrote it.
  const clearSession = useCallback(() => {
    pinUnlockedRef.current = false;
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

  // AFK auto-lock (§6.1, §13.2 V2-P2). While the app is unlocked and the account
  // has both the PIN on and an idle timeout configured, re-arm the PIN gate
  // after N minutes without user activity. In-memory like the unlock flag above,
  // so it only ever gates the UI — the session is untouched. Disabled (no timer)
  // when the PIN is off or the timeout is null (the opt-in default).
  const idleMinutes = user?.pinLockIdleMinutes ?? null;
  const pinEnabled = user?.pinEnabled ?? false;
  useEffect(() => {
    if (status !== 'authenticated' || !pinEnabled || idleMinutes == null || idleMinutes <= 0) {
      return;
    }
    const idleMs = idleMinutes * 60_000;
    let timer: ReturnType<typeof setTimeout>;
    const lock = () => {
      pinUnlockedRef.current = false;
      setStatus('pin-required');
    };
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(lock, idleMs);
    };
    for (const event of AFK_ACTIVITY_EVENTS) {
      window.addEventListener(event, reset, { passive: true });
    }
    reset();
    return () => {
      clearTimeout(timer);
      for (const event of AFK_ACTIVITY_EVENTS) {
        window.removeEventListener(event, reset);
      }
    };
  }, [status, pinEnabled, idleMinutes]);

  const login = useCallback(
    async (credentials: LoginRequest) => {
      const me = await api.login(credentials);
      if (me.role === 'admin') {
        // A valid admin login still minted a session cookie — drop it so no
        // half-authenticated admin session lingers on the user origin.
        await api.logout().catch(() => undefined);
        throw new AdminAccountError();
      }
      // A fresh password login is a stronger factor than the PIN — don't gate
      // the user again in the same breath.
      pinUnlockedRef.current = true;
      applyUser(me);
    },
    [applyUser],
  );

  const acceptInvite = useCallback(
    async (body: AcceptInviteRequest) => {
      // A fresh invite account is created active with no forced change, so this
      // lands authenticated; applyUser keeps it correct either way.
      pinUnlockedRef.current = true;
      applyUser(await api.acceptInvite(body));
    },
    [applyUser],
  );

  const completePasswordReset = useCallback(
    async (body: PasswordResetComplete) => {
      // The reset mints a fresh session server-side and returns the usable user,
      // so this lands authenticated; a fresh credential outranks the PIN gate.
      pinUnlockedRef.current = true;
      applyUser(await api.completePasswordReset(body));
    },
    [applyUser],
  );

  const changePassword = useCallback(
    async (body: ChangePasswordRequest) => {
      // Success rotates the session and clears the flag — the response is a
      // fresh, usable user, releasing the forced-change trap.
      pinUnlockedRef.current = true;
      applyUser(await api.changePassword(body));
    },
    [applyUser],
  );

  const verifyPin = useCallback(
    async (body: PinVerifyRequest) => {
      try {
        const me = await api.verifyPin(body);
        pinUnlockedRef.current = true;
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
