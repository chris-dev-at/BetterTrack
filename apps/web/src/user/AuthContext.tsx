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

import type {
  AcceptInviteRequest,
  ChangePasswordRequest,
  LoginRequest,
  MeResponse,
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
 */
export type AuthStatus = 'loading' | 'anonymous' | 'authenticated' | 'password-change-required';

interface AuthContextValue {
  status: AuthStatus;
  /** The current user. Null while anonymous/loading, and may be null in the
   *  forced-change state when we only learned of the lock from a `403` (the
   *  identity isn't disclosed until the password is changed). */
  user: MeResponse | null;
  login: (credentials: LoginRequest) => Promise<void>;
  acceptInvite: (body: AcceptInviteRequest) => Promise<void>;
  changePassword: (body: ChangePasswordRequest) => Promise<void>;
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

  // Apply a resolved /auth/me-or-login user to local state, routing a
  // forced-change account into the trap rather than the app.
  const applyUser = useCallback((me: MeResponse) => {
    if (me.mustChangePassword) {
      setUser(me);
      setStatus('password-change-required');
    } else {
      setUser(me);
      setStatus('authenticated');
    }
  }, []);

  const clearSession = useCallback(() => {
    setUser(null);
    setStatus('anonymous');
  }, []);

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

  const login = useCallback(
    async (credentials: LoginRequest) => {
      const me = await api.login(credentials);
      if (me.role === 'admin') {
        // A valid admin login still minted a session cookie — drop it so no
        // half-authenticated admin session lingers on the user origin.
        await api.logout().catch(() => undefined);
        throw new AdminAccountError();
      }
      applyUser(me);
    },
    [applyUser],
  );

  const acceptInvite = useCallback(
    async (body: AcceptInviteRequest) => {
      // A fresh invite account is created active with no forced change, so this
      // lands authenticated; applyUser keeps it correct either way.
      applyUser(await api.acceptInvite(body));
    },
    [applyUser],
  );

  const changePassword = useCallback(
    async (body: ChangePasswordRequest) => {
      // Success rotates the session and clears the flag — the response is a
      // fresh, usable user, releasing the forced-change trap.
      applyUser(await api.changePassword(body));
    },
    [applyUser],
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
      changePassword,
      logout,
      rateLimitBanner,
      clearRateLimitBanner,
    }),
    [
      status,
      user,
      login,
      acceptInvite,
      changePassword,
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
