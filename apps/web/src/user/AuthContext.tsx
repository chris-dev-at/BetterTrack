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
  GoogleRegisterRequest,
  LoginRequest,
  MeResponse,
  PasswordResetComplete,
  PinQuickAuthRequest,
  PinVerifyRequest,
  RegisterRequest,
  TwoFactorChallengeResponse,
  TwoFactorEmailCodeRequest,
  TwoFactorVerifyRequest,
} from '@bettertrack/contracts';
import { DEFAULT_PIN_WINDOW_MINUTES } from '@bettertrack/contracts';

import { ApiError, setAuthResponsePolicy } from '../lib/apiClient';
import { setMoneyCurrency } from '../lib/format';
import * as api from '../lib/userApi';
import { clearRememberedAccount, writeRememberedAccount } from './auth/rememberedAccount';

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
 * The app-lock as a **client-side idle model** (§6.1, §13.2 V2-P2; owner
 * directive #304). The PIN gate is a privacy curtain against shoulder-surfing —
 * it keeps a passer-by from reading your balances on a screen you walked away
 * from — not a security boundary. The session (httpOnly cookie, §6.1) is the
 * boundary and is untouched here; there is deliberately **no** server-timed
 * deauth and no API-level PIN challenge. It can be chill and live entirely on the
 * client.
 *
 * So the lock is driven purely by **user inactivity**. With the PIN on, real
 * activity in the tab — pointer moves/presses, keys, scrolls, touches, and a tab
 * regaining visibility — continually pushes back a deadline; the gate engages
 * only after the configured minutes ({@link DEFAULT_PIN_WINDOW_MINUTES} by
 * default) with **zero** activity. An app in active use therefore never locks, no
 * matter how long the session runs. Background auto-refetches are not activity —
 * only DOM interaction is — so polling never keeps the gate open or drives it.
 *
 * The source of truth is a single **`lastActivityAt` timestamp persisted in
 * `localStorage`**, scoped to the user id. A reload/reopen reads it and re-gates
 * only when `now − lastActivityAt` exceeds the window, so a reload mid-use never
 * prompts while a reopen after a long idle gates before any data renders. Because
 * it lives in `localStorage`, activity in one tab (via storage events) keeps
 * every other tab of the same account unlocked too.
 */

/** `localStorage` key holding this user's most-recent activity timestamp. */
const PIN_ACTIVITY_STORAGE_KEY = 'bettertrack.pinActivity';

/**
 * Persisting `lastActivityAt` on every pointer move would thrash storage (and
 * spam other tabs with storage events), so writes are throttled to at most once
 * per this interval. The in-tab deadline still resets on *every* event — this
 * only bounds how stale the persisted value (used by reloads/other tabs) can be,
 * which is negligible against a minutes-long window.
 */
const ACTIVITY_PERSIST_THROTTLE_MS = 10_000;

/** DOM events that count as the user actively using the app. */
const ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'scroll', 'touchstart'] as const;

interface StoredActivity {
  /** User id the timestamp belongs to — a different account never inherits it. */
  u: string;
  /** Last activity, epoch ms. */
  t: number;
}

/** The idle window for `me`, in ms — their configured minutes or the default. */
function idleWindowMs(me: Pick<MeResponse, 'pinLockIdleMinutes'>): number {
  return (me.pinLockIdleMinutes ?? DEFAULT_PIN_WINDOW_MINUTES) * 60_000;
}

/** Read this user's last-activity timestamp, or null if none/other user. */
function readLastActivity(userId: string): number | null {
  try {
    const raw = localStorage.getItem(PIN_ACTIVITY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredActivity>;
    if (parsed.u !== userId || typeof parsed.t !== 'number') return null;
    return parsed.t;
  } catch {
    // Storage unavailable/corrupt → treat as idle; the gate is the safe default.
    return null;
  }
}

/** Record activity for `userId` now — the fresh idle window after any unlock. */
function recordActivity(userId: string, at: number = Date.now()): void {
  try {
    localStorage.setItem(PIN_ACTIVITY_STORAGE_KEY, JSON.stringify({ u: userId, t: at }));
  } catch {
    // No persistence available — the app-open still succeeds; the deadline then
    // simply can't outlive this JS context (a reload re-gates), which is safe.
  }
}

/** Drop any recorded activity (sign-out / session end). */
function clearActivity(): void {
  try {
    localStorage.removeItem(PIN_ACTIVITY_STORAGE_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

/**
 * Whether `me`'s PIN gate should be up right now: the PIN is on and the app has
 * been idle past the window (or never recorded activity — a first open). A
 * missing timestamp is treated as expired, so a fresh open always gates.
 */
function isPinLocked(me: MeResponse): boolean {
  if (!me.pinEnabled) return false;
  const last = readLastActivity(me.id);
  if (last == null) return true;
  return Date.now() - last > idleWindowMs(me);
}

/**
 * Result of a password login (§6.1, §13.2 V2-P5). A no-2FA account lands
 * `authenticated` (the context is already updated); a 2FA account lands
 * `two_factor_required` with the challenge the caller must complete via
 * {@link AuthContextValue.verifyTwoFactor} before a session exists.
 */
export type LoginOutcome =
  | {
      status: 'authenticated';
      /**
       * The signed-in user. For a normal login the context is already updated
       * (applied); for an OAuth-flow login it is deferred so the login screen
       * can offer the post-credential-entry "stay signed in" choice before the
       * app opens — call {@link AuthContextValue.adoptUser} once decided (V4-P2b).
       */
      me: MeResponse;
    }
  | { status: 'two_factor_required'; challenge: TwoFactorChallengeResponse };

/**
 * Result of an OAuth PIN quick re-auth (§16, owner spec #399 §B, V4-P2b).
 * `authenticated` means the device's remembered PIN user signed in (session set,
 * context applied); `pin_required` means the probe found a closed ~15-min window,
 * so the chooser must collect the PIN and call {@link AuthContextValue.quickAuth}
 * again with it.
 */
export type QuickAuthOutcome =
  | { status: 'authenticated'; me: MeResponse }
  | { status: 'pin_required' };

/**
 * Result of a self-serve registration (§13.4 V4-P4a). `authenticated` means the
 * account was created and the app is now signed in; `pending` means the request
 * is queued for admin approval and no session exists yet.
 */
export type RegisterOutcome = { status: 'authenticated'; me: MeResponse } | { status: 'pending' };

interface AuthContextValue {
  status: AuthStatus;
  /** The current user. Null while anonymous/loading, and may be null in the
   *  forced-change state when we only learned of the lock from a `403` (the
   *  identity isn't disclosed until the password is changed). */
  user: MeResponse | null;
  login: (credentials: LoginRequest) => Promise<LoginOutcome>;
  /**
   * Complete a login 2FA challenge. On success the app lands authenticated,
   * UNLESS `deferApply` is set (the OAuth flow) — then the resolved user is
   * returned unapplied so the caller can offer the "stay signed in" choice and
   * apply it via {@link adoptUser} (V4-P2b).
   */
  verifyTwoFactor: (body: TwoFactorVerifyRequest, deferApply?: boolean) => Promise<MeResponse>;
  /**
   * Apply a user resolved by a deferred (OAuth-flow) login/verify — flips the
   * app to authenticated and opens a fresh PIN window (V4-P2b).
   */
  adoptUser: (me: MeResponse) => void;
  /**
   * Promote the current session to persistent — the OAuth-login "stay signed in
   * — your PIN protects this" choice (V4-P2b, §399 §A). PIN-gated server-side.
   */
  persistSession: () => Promise<void>;
  /** Request a one-time email login code for a pending 2FA challenge. */
  requestTwoFactorEmailCode: (body: TwoFactorEmailCodeRequest) => Promise<void>;
  acceptInvite: (body: AcceptInviteRequest) => Promise<void>;
  /**
   * Public self-serve registration (§13.4 V4-P4a). In open / invite-token modes
   * the account is created and the app lands authenticated; in approval mode the
   * result is `{ pending: true }` and NO session — the caller shows the pending
   * confirmation. Closed mode / bad token / taken email reject with an ApiError.
   */
  register: (body: RegisterRequest) => Promise<RegisterOutcome>;
  /**
   * Submit the connected Google register form (owner order 2026-07-16). The email
   * + the subject to link come from the server-side ticket, never `body`. Mirrors
   * {@link register}: open / invite-token lands authenticated, approval pending.
   */
  googleRegister: (body: GoogleRegisterRequest) => Promise<RegisterOutcome>;
  /**
   * Complete a self-service password reset. A no-2FA account is signed straight
   * in (lands `authenticated`); a 2FA account lands `two_factor_required` with a
   * challenge the caller completes via {@link verifyTwoFactor} first (§6.1).
   */
  completePasswordReset: (body: PasswordResetComplete) => Promise<LoginOutcome>;
  changePassword: (body: ChangePasswordRequest) => Promise<void>;
  /** Verify the PIN for the current session, releasing the `pin-required` trap. */
  verifyPin: (body: PinVerifyRequest) => Promise<void>;
  /**
   * OAuth PIN quick re-auth for the remembered device (§399 §B, V4-P2b). Omit
   * `pin` to probe the ~15-min window; pass it to verify. On `authenticated` the
   * context is already applied (session set + fresh PIN window). The identity is
   * bound to the `bt_rdid` cookie server-side — never passed from the client.
   */
  quickAuth: (body: PinQuickAuthRequest) => Promise<QuickAuthOutcome>;
  /**
   * Remember-me opt-in: bind this device to the current PIN user server-side
   * (sets the `bt_rdid` cookie) and store the client-side chooser record
   * (username + avatar + user id only). PIN users only (§399 §B).
   */
  rememberThisDevice: () => Promise<void>;
  /**
   * "Another account" / explicit forget: clear the remembered identity —
   * server binding + `bt_rdid` cookie AND the local chooser record — so the next
   * OAuth open shows a blank login (§399 §B).
   */
  forgetRememberedAccount: () => Promise<void>;
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
  // forced-change account into its trap, and a PIN account that has sat idle past
  // its window (or never recorded activity) into the PIN gate. Note this only
  // *reads* the activity timestamp — a reload/refetch must never count as
  // activity; only real DOM interaction or an actual unlock records it.
  const applyUser = useCallback((me: MeResponse) => {
    setUser(me);
    // Drive the display layer's default money currency from the session user's
    // base currency (§5.4, V3-P10d) — every converted figure the API returns
    // is denominated in it, so the omitted-currency formatMoney default must
    // match before the first money paint.
    setMoneyCurrency(me.baseCurrency);
    if (me.mustChangePassword) {
      setStatus('password-change-required');
    } else if (isPinLocked(me)) {
      setStatus('pin-required');
    } else {
      setStatus('authenticated');
    }
  }, []);

  // Drops every trace of the signed-out user: the recorded activity, the auth
  // state itself, and the entire TanStack Query cache. Without the cache clear a
  // subsequent login as a *different* account could briefly (or, for queries
  // with a nonzero staleTime, not-so-briefly) render the previous user's
  // cached name/email/portfolio/notifications before a refetch overwrote it.
  const clearSession = useCallback(() => {
    clearActivity();
    setUser(null);
    setStatus('anonymous');
    // Back to the EUR default so the next account never inherits the previous
    // user's base currency (mirrors the query-cache clear below).
    setMoneyCurrency('EUR');
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
  // (403, or a stray must-change me) → the trap; 429 → hold the splash and retry
  // after `Retry-After` rather than mistaking a transient rate-limit for a
  // dropped session (the burst limiter can trip on a rapid multi-navigation
  // flurry, e.g. an e2e spec that hard-reloads `/social/friends` several times
  // in a few seconds — falling through to anonymous would bounce the caller to
  // `/login`); anything else → anonymous.
  useEffect(() => {
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const tryBootstrap = async () => {
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
        } else if (err instanceof ApiError && err.status === 429) {
          const seconds = err.retryAfterSeconds;
          const wait =
            seconds && seconds > 0
              ? ` Please wait ${seconds} second${seconds === 1 ? '' : 's'} and try again.`
              : ' Please slow down.';
          setRateLimitBanner(`You're doing that too fast.${wait}`);
          const delayMs = Math.max(1_000, (seconds ?? 1) * 1_000);
          retryTimer = setTimeout(() => {
            void tryBootstrap();
          }, delayMs);
        } else {
          setUser(null);
          setStatus('anonymous');
        }
      }
    };
    void tryBootstrap();
    return () => {
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [applyUser]);

  // Idle-lock timing (§6.1, §13.2 V2-P2; owner directive #304). While a PIN
  // account is authenticated, watch for real DOM activity and engage the gate
  // only after `idleMinutes` with none. Every activity event resets an in-tab
  // deadline (precise) and, throttled, persists `lastActivityAt` so reloads and
  // other tabs stay in sync. Storage events (another tab's activity) reset our
  // deadline too, without re-persisting — so activity anywhere keeps us unlocked.
  // Entering the PIN records activity and flips status back to `authenticated`,
  // re-running this effect to arm a fresh window.
  const pinEnabled = user?.pinEnabled ?? false;
  const userId = user?.id ?? null;
  const idleMinutes = user?.pinLockIdleMinutes ?? null;
  useEffect(() => {
    if (status !== 'authenticated' || !pinEnabled || userId == null) return;

    const windowMs = (idleMinutes ?? DEFAULT_PIN_WINDOW_MINUTES) * 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastPersistAt = 0;

    const lock = () => setStatus('pin-required');

    // Re-arm the deadline from the persisted timestamp (used on mount and when
    // another tab records activity) — locks immediately if it's already stale.
    const arm = () => {
      if (timer) clearTimeout(timer);
      const last = readLastActivity(userId) ?? Date.now();
      const remaining = windowMs - (Date.now() - last);
      if (remaining <= 0) {
        lock();
        return;
      }
      timer = setTimeout(lock, remaining);
    };

    // Real activity in this tab: reset the deadline to a full window and, at most
    // once per throttle interval, persist it for reloads and other tabs.
    const onActivity = () => {
      const now = Date.now();
      if (now - lastPersistAt >= ACTIVITY_PERSIST_THROTTLE_MS) {
        lastPersistAt = now;
        recordActivity(userId, now);
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(lock, windowMs);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') onActivity();
    };

    // Another tab recorded activity: re-arm from the freshly-written timestamp.
    // Never re-persist here or two tabs would echo storage events forever.
    const onStorage = (e: StorageEvent) => {
      if (e.key === PIN_ACTIVITY_STORAGE_KEY) arm();
    };

    for (const type of ACTIVITY_EVENTS) {
      window.addEventListener(type, onActivity, { capture: true, passive: true });
    }
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('storage', onStorage);
    arm();

    return () => {
      if (timer) clearTimeout(timer);
      for (const type of ACTIVITY_EVENTS) {
        window.removeEventListener(type, onActivity, { capture: true });
      }
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('storage', onStorage);
    };
  }, [status, pinEnabled, userId, idleMinutes]);

  // Flip the app to authenticated for a user resolved by a deferred (OAuth-flow)
  // login/verify, opening a fresh PIN window (a fresh login is a stronger factor
  // than the PIN, so the user isn't re-gated in the same breath).
  const adoptUser = useCallback(
    (me: MeResponse) => {
      recordActivity(me.id);
      applyUser(me);
    },
    [applyUser],
  );

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
      // OAuth-flow login (V4-P2b): defer applying the user so the login screen
      // can present the post-credential-entry "stay signed in" choice (which
      // depends on whether the account has a PIN) before the app opens. The
      // caller applies it via adoptUser once decided.
      if (credentials.oauthLogin) {
        return { status: 'authenticated', me };
      }
      adoptUser(me);
      return { status: 'authenticated', me };
    },
    [adoptUser],
  );

  const verifyTwoFactor = useCallback(
    async (body: TwoFactorVerifyRequest, deferApply = false): Promise<MeResponse> => {
      const me = await api.verifyTwoFactor(body);
      if (me.role === 'admin') {
        // Defensive: admin-kind 2FA is out of scope, but never admit an admin
        // to the user app if one ever reaches here.
        await api.logout().catch(() => undefined);
        throw new AdminAccountError();
      }
      // The OAuth flow defers applying so it can offer the "stay signed in"
      // choice first (V4-P2b); everything else lands authenticated immediately.
      if (!deferApply) adoptUser(me);
      return me;
    },
    [adoptUser],
  );

  const persistSession = useCallback(() => api.persistSession(), []);

  const requestTwoFactorEmailCode = useCallback(
    (body: TwoFactorEmailCodeRequest) => api.requestTwoFactorEmailCode(body),
    [],
  );

  const acceptInvite = useCallback(
    async (body: AcceptInviteRequest) => {
      // A fresh invite account is created active with no forced change, so this
      // lands authenticated; applyUser keeps it correct either way.
      const me = await api.acceptInvite(body);
      recordActivity(me.id);
      applyUser(me);
    },
    [applyUser],
  );

  const register = useCallback(
    async (body: RegisterRequest): Promise<RegisterOutcome> => {
      const res = await api.register(body);
      // Approval mode: no session was minted — the applicant waits for an admin.
      if ('pending' in res) return { status: 'pending' };
      // Open / invite-token: a session cookie was set and a usable user returned,
      // so this lands authenticated with a fresh window.
      recordActivity(res.id);
      applyUser(res);
      return { status: 'authenticated', me: res };
    },
    [applyUser],
  );

  const googleRegister = useCallback(
    async (body: GoogleRegisterRequest): Promise<RegisterOutcome> => {
      const res = await api.googleRegister(body);
      // Approval mode: no session was minted — the applicant waits for an admin.
      if ('pending' in res) return { status: 'pending' };
      // Open / invite-token: a session cookie was set and a usable user returned.
      recordActivity(res.id);
      applyUser(res);
      return { status: 'authenticated', me: res };
    },
    [applyUser],
  );

  const completePasswordReset = useCallback(
    async (body: PasswordResetComplete): Promise<LoginOutcome> => {
      const result = await api.completePasswordReset(body);
      // 2FA on: the reset changed the password but withheld the session — a
      // mailbox alone must not defeat the second factor (§6.1). Hand the
      // challenge back so the reset screen can collect it before the app opens.
      if ('twoFactorRequired' in result) {
        return { status: 'two_factor_required', challenge: result };
      }
      // No 2FA: the API minted a fresh session and returned the usable user, so
      // this lands authenticated; a fresh credential opens a fresh window.
      recordActivity(result.id);
      applyUser(result);
      return { status: 'authenticated', me: result };
    },
    [applyUser],
  );

  const changePassword = useCallback(
    async (body: ChangePasswordRequest) => {
      // Success rotates the session and clears the flag — the response is a
      // fresh, usable user, releasing the forced-change trap and opening a window.
      const me = await api.changePassword(body);
      recordActivity(me.id);
      applyUser(me);
    },
    [applyUser],
  );

  const verifyPin = useCallback(
    async (body: PinVerifyRequest) => {
      try {
        const me = await api.verifyPin(body);
        // A correct PIN opens the next unlock window.
        recordActivity(me.id);
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

  const quickAuth = useCallback(
    async (body: PinQuickAuthRequest): Promise<QuickAuthOutcome> => {
      const result = await api.quickAuthPin(body);
      // Probe found a closed ~15-min window: the chooser must collect the PIN
      // and call again with it. No session was minted, nothing to apply.
      if ('pinRequired' in result) return { status: 'pin_required' };
      const me = result;
      if (me.role === 'admin') {
        // Defensive: a remembered device should only ever bind a user-kind
        // account, but never admit an admin to the user app (mirrors login).
        await api.logout().catch(() => undefined);
        throw new AdminAccountError();
      }
      // Quick re-auth already minted the (ephemeral) session cookie; a correct
      // PIN — or an in-window auto-pass — opens a fresh unlock window, so land
      // straight in rather than re-gating on the PIN we just proved.
      adoptUser(me);
      return { status: 'authenticated', me };
    },
    [adoptUser],
  );

  const rememberThisDevice = useCallback(async () => {
    // The server mints the `bt_rdid` binding + cookie and hands back exactly the
    // record we may store (user id + username + avatar — never a token).
    const record = await api.rememberDevice();
    writeRememberedAccount(record);
  }, []);

  const forgetRememberedAccount = useCallback(async () => {
    // Clear the LOCAL record first so the chooser drops immediately and a
    // close-then-reopen shows a blank login even if the network call is slow or
    // fails (owner: "immediately clears the remembered user"). Then best-effort
    // clear the server binding + cookie.
    clearRememberedAccount();
    await api.forgetRememberedDevice().catch(() => undefined);
  }, []);

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
      adoptUser,
      persistSession,
      requestTwoFactorEmailCode,
      acceptInvite,
      register,
      googleRegister,
      completePasswordReset,
      changePassword,
      verifyPin,
      quickAuth,
      rememberThisDevice,
      forgetRememberedAccount,
      logout,
      rateLimitBanner,
      clearRateLimitBanner,
    }),
    [
      status,
      user,
      login,
      verifyTwoFactor,
      adoptUser,
      persistSession,
      requestTwoFactorEmailCode,
      acceptInvite,
      register,
      googleRegister,
      completePasswordReset,
      changePassword,
      verifyPin,
      quickAuth,
      rememberThisDevice,
      forgetRememberedAccount,
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

/**
 * Like {@link useAuth} but returns `null` outside an `AuthProvider` instead of
 * throwing — for controls that render on both authenticated and public
 * (maybe-logged-out) surfaces, e.g. the follow button on a public profile (#438).
 */
export function useOptionalAuth(): AuthContextValue | null {
  return useContext(AuthContext);
}
