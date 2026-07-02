import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { LoginRequest, MeResponse } from '@bettertrack/contracts';

import { ApiError } from '../lib/apiClient';
import * as api from '../lib/adminApi';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

/** Thrown by {@link AuthContextValue.login} when valid creds belong to a non-admin. */
export class NotAdminError extends Error {
  constructor() {
    super('This is a user account, not an administrator — please sign in through the main app.');
    this.name = 'NotAdminError';
  }
}

/** Thrown when the admin must change their password before using the area (§6.1). */
export class PasswordChangeRequiredError extends Error {
  constructor() {
    super('This account must change its password before accessing the admin area.');
    this.name = 'PasswordChangeRequiredError';
  }
}

interface AuthContextValue {
  status: AuthStatus;
  /** The current admin, or null when anonymous / still loading. */
  user: MeResponse | null;
  login: (credentials: LoginRequest) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * Drop the in-memory session without an API round-trip. Pages call this when
   * a request comes back 401/404 mid-use (expired cookie, account disabled) so
   * the guard bounces back to the login screen.
   */
  clearSession: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Decides whether a resolved session may use the admin area. */
function assertAdminUsable(me: MeResponse): void {
  if (me.role !== 'admin') throw new NotAdminError();
  if (me.mustChangePassword) throw new PasswordChangeRequiredError();
}

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
        if (me.role === 'admin' && !me.mustChangePassword) {
          setUser(me);
          setStatus('authenticated');
        } else {
          setUser(null);
          setStatus('anonymous');
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setUser(null);
        setStatus('anonymous');
      }
    })();
    return () => controller.abort();
  }, []);

  const login = useCallback(async (credentials: LoginRequest) => {
    const me = await api.login(credentials);
    try {
      assertAdminUsable(me);
    } catch (err) {
      // A non-admin (or forced-change) login still created a session — drop it
      // so we never leave a half-authenticated cookie behind.
      await api.logout().catch(() => undefined);
      throw err;
    }
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
    () => ({ status, user, login, logout, clearSession }),
    [status, user, login, logout, clearSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider.');
  return ctx;
}
