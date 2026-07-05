import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { ChangePasswordRequest, LoginRequest, MeResponse } from '@bettertrack/contracts';

import { ApiError } from '../lib/apiClient';
import * as api from '../lib/adminApi';

/**
 * `password-change-required` — a live admin session whose account was reset and
 * still carries `mustChangePassword` (§6.1). The admin area traps into its own
 * forced-change screen until the change clears the flag, so a reset admin can
 * recover the account here instead of being bricked (#248 item 6).
 */
type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'password-change-required';

/** Thrown by {@link AuthContextValue.login} when valid creds belong to a non-admin. */
export class NotAdminError extends Error {
  constructor() {
    super('This is a user account, not an administrator — please sign in through the main app.');
    this.name = 'NotAdminError';
  }
}

interface AuthContextValue {
  status: AuthStatus;
  /** The current admin. Null while anonymous/loading, and while a reset admin is
   *  in the forced-change trap (the identity isn't used until the flag clears). */
  user: MeResponse | null;
  login: (credentials: LoginRequest) => Promise<void>;
  /**
   * Complete a forced password change for the reset admin session, releasing the
   * trap (§6.1, #248 item 6). No current password is required — the temp-password
   * login is the proof (#248 item 7).
   */
  changePassword: (body: ChangePasswordRequest) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * Drop the in-memory session without an API round-trip. Pages call this when
   * a request comes back 401/404 mid-use (expired cookie, account disabled) so
   * the guard bounces back to the login screen.
   */
  clearSession: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<MeResponse | null>(null);

  // Bootstrap from the session cookie. Anonymous, non-admin, and 401/404
  // responses all resolve to "anonymous" — no route detail is surfaced.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const me = await api.getMe(controller.signal);
        if (me.role !== 'admin') {
          setUser(null);
          setStatus('anonymous');
        } else if (me.mustChangePassword) {
          setUser(null);
          setStatus('password-change-required');
        } else {
          setUser(me);
          setStatus('authenticated');
        }
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
  }, []);

  const login = useCallback(async (credentials: LoginRequest) => {
    const me = await api.login(credentials);
    if (me.role !== 'admin') {
      // A non-admin login still created a session — drop it so we never leave a
      // half-authenticated cookie behind, then point them at the main app.
      await api.logout().catch(() => undefined);
      throw new NotAdminError();
    }
    if (me.mustChangePassword) {
      // Reset admin: keep the session and trap into the forced-change screen so
      // the account is recoverable right here, not bricked (§6.1, #248 item 6).
      setUser(null);
      setStatus('password-change-required');
      return;
    }
    setUser(me);
    setStatus('authenticated');
  }, []);

  const changePassword = useCallback(async (body: ChangePasswordRequest) => {
    const me = await api.changePassword(body);
    if (me.role !== 'admin') {
      // A non-admin completed a forced change on the admin origin — they have no
      // admin area; drop the session and send them out.
      await api.logout().catch(() => undefined);
      setUser(null);
      setStatus('anonymous');
      throw new NotAdminError();
    }
    // Flag cleared and the session is still live — the area opens up.
    setUser(me);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
    } finally {
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  const clearSession = useCallback(() => {
    setUser(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, login, changePassword, logout, clearSession }),
    [status, user, login, changePassword, logout, clearSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider.');
  return ctx;
}
