import { useCallback, useEffect, useRef, useState } from 'react';

import { localizedMessage, useI18n } from '../i18n';
import { ApiError } from '../lib/apiClient';
import { isAdminTwoFactorSetupRequired, useAuth } from './AuthContext';

/**
 * What a 404 means for this particular write.
 *
 * `apiClient`'s `isNotAuthorized` is `401 || 404`, because the admin API answers
 * 404 to non-admins on purpose (§6.12 — no information leak). For a READ that
 * conflation is right: a 404 from an admin route means the caller is no longer an
 * admin. For a row-scoped WRITE it is not: `POST /admin/registration-requests/:id/approve`
 * 404s when that one application is already gone, which is a benign delete race —
 * two tabs, or a colleague acting first. Treating it as auth loss would log a
 * working admin out through the 2FA trap over a stale row.
 *
 *  - `surface` (default) — show the error banner, keep the session. Correct for
 *    anything addressed by an id that another actor can remove.
 *  - `session` — treat it as auth loss, exactly as reads do. Only for writes
 *    against a route with no row id, where a 404 really can only mean "you are
 *    not an admin here any more".
 */
export type AdminMutationNotFoundPolicy = 'surface' | 'session';

interface AdminMutationOptions {
  /**
   * Catalog key for the banner shown when the call fails. Server envelopes are
   * authored in English and are not locale-aware, so displayable failures always
   * use catalog copy — the same rule `useResource` follows for reads.
   */
  errorKey: string;
  /** Run after a successful call — typically a `useResource` reload. */
  onSuccess?: () => void;
  /** How to read a 404. Defaults to `surface`; see the type's docs. */
  notFound?: AdminMutationNotFoundPolicy;
  /**
   * Catalog key for the banner when a `surface` 404 says the row is gone. Falls
   * back to `errorKey` when a call site has nothing more specific to say.
   */
  notFoundErrorKey?: string;
}

interface AdminMutation<TArgs extends readonly unknown[]> {
  /** Fire the mutation. Resolves to `true` when it succeeded. */
  run: (...args: TArgs) => Promise<boolean>;
  /** Fire it against one row, so only that row's control shows progress. */
  runFor: (key: string, ...args: TArgs) => Promise<boolean>;
  /**
   * The keyless call is in flight (`true`), or nothing is (`false`). Row-scoped
   * calls do NOT show up here — ask {@link isPending} instead, so two rows in
   * flight at once each keep their own progress.
   */
  pending: boolean;
  /** Whether this specific row key is in flight. */
  isPending: (key: string) => boolean;
  /** Whether anything at all is in flight. */
  busy: boolean;
  /** Localized failure banner, or `null`. */
  error: string | null;
  /** Clear the banner (e.g. when the operator edits the form again). */
  clearError: () => void;
}

/** Sentinel for the keyless `run()`, so it shares one pending registry with rows. */
const KEYLESS = Symbol('admin-mutation-keyless');
type PendingKey = string | typeof KEYLESS;

/**
 * The shared admin write seam (#1406 W1). Every admin page hand-rolled its own
 * `busy` flag, `try/catch` and error string; the six-workspace rebuild fans a lot
 * more actions out, so the pending state, the localized failure banner and the
 * post-write reload live here once.
 *
 * Session outcomes keep the structural handling `useResource` applies — a 401
 * mid-session clears the session so the route guard returns the admin to the
 * login screen without leaking which resource was involved (§6.12), and a 403
 * `ADMIN_2FA_SETUP_REQUIRED` traps into the forced-enrollment wizard (#400) —
 * except for 404, which is a per-call decision (see {@link AdminMutationNotFoundPolicy}).
 *
 * Pending state is tracked as a SET of in-flight keys. A list may legitimately
 * have two rows working at once, and the first to finish must never re-enable the
 * other one's control.
 */
export function useAdminMutation<TArgs extends readonly unknown[]>(
  action: (...args: TArgs) => Promise<unknown>,
  options: AdminMutationOptions,
): AdminMutation<TArgs> {
  const { locale } = useI18n();
  const { clearSession, requireTwoFactorSetup } = useAuth();
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<PendingKey>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  // Call sites pass an inline closure and an inline options object every render.
  // Holding both in refs keeps the returned callbacks stable — a consumer may put
  // them in a dependency array — while each call still runs the latest code.
  const actionRef = useRef(action);
  const optionsRef = useRef(options);
  useEffect(() => {
    actionRef.current = action;
    optionsRef.current = options;
  });

  const localeRef = useRef(locale);
  useEffect(() => {
    localeRef.current = locale;
  }, [locale]);

  const clearError = useCallback(() => setError(null), []);

  const execute = useCallback(
    async (key: PendingKey, args: TArgs): Promise<boolean> => {
      const { errorKey, notFound = 'surface', notFoundErrorKey, onSuccess } = optionsRef.current;
      setPendingKeys((current) => new Set(current).add(key));
      setError(null);
      try {
        await actionRef.current(...args);
        onSuccess?.();
        return true;
      } catch (err) {
        const status = err instanceof ApiError ? err.status : null;
        const authLoss = status === 401 || (status === 404 && notFound === 'session');
        if (authLoss) {
          clearSession();
          return false;
        }
        if (isAdminTwoFactorSetupRequired(err)) {
          requireTwoFactorSetup();
          return false;
        }
        const key404 = status === 404 ? (notFoundErrorKey ?? errorKey) : errorKey;
        setError(localizedMessage(localeRef.current, key404));
        return false;
      } finally {
        // Release only this call's own key.
        setPendingKeys((current) => {
          if (!current.has(key)) return current;
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [clearSession, requireTwoFactorSetup],
  );

  const run = useCallback((...args: TArgs) => execute(KEYLESS, args), [execute]);
  const runFor = useCallback((key: string, ...args: TArgs) => execute(key, args), [execute]);
  const isPending = useCallback((key: string) => pendingKeys.has(key), [pendingKeys]);

  return {
    run,
    runFor,
    pending: pendingKeys.has(KEYLESS),
    isPending,
    busy: pendingKeys.size > 0,
    error,
    clearError,
  };
}
