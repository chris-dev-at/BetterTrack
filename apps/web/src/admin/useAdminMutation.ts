import { useCallback, useState } from 'react';

import { localizedMessage, useI18n } from '../i18n';
import { ApiError } from '../lib/apiClient';
import { isAdminTwoFactorSetupRequired, useAuth } from './AuthContext';

interface AdminMutationOptions {
  /**
   * Catalog key for the banner shown when the call fails. Server envelopes are
   * authored in English and are not locale-aware, so displayable failures always
   * use catalog copy — the same rule `useResource` follows for reads.
   */
  errorKey: string;
  /** Run after a successful call — typically a `useResource` reload. */
  onSuccess?: () => void;
}

interface AdminMutation<TArgs extends readonly unknown[]> {
  /** Fire the mutation. Resolves to `true` when it succeeded. */
  run: (...args: TArgs) => Promise<boolean>;
  /** Key of the row/entity currently in flight, or `true` for a keyless call. */
  pending: string | boolean;
  /** Localized failure banner, or `null`. */
  error: string | null;
  /** Clear the banner (e.g. when the operator edits the form again). */
  clearError: () => void;
}

/**
 * The shared admin write seam (#1406 W1). Every admin page hand-rolled its own
 * `busy` flag, `try/catch` and error string; the six-workspace rebuild fans a lot
 * more actions out, so the pending state, the localized failure banner and the
 * post-write reload live here once.
 *
 * Session outcomes keep the structural handling `useResource` already applies: a
 * 401/404 mid-session clears the session so the route guard returns the admin to
 * the login screen without leaking which resource was involved (§6.12), and a
 * 403 `ADMIN_2FA_SETUP_REQUIRED` traps into the forced-enrollment wizard (#400).
 *
 * `key` scopes the pending flag to one row, so a list can disable exactly the
 * button that is working instead of the whole table.
 */
export function useAdminMutation<TArgs extends readonly unknown[]>(
  action: (...args: TArgs) => Promise<unknown>,
  options: AdminMutationOptions,
): AdminMutation<TArgs> & { runFor: (key: string, ...args: TArgs) => Promise<boolean> } {
  const { locale } = useI18n();
  const { clearSession, requireTwoFactorSetup } = useAuth();
  const [pending, setPending] = useState<string | boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  const execute = useCallback(
    async (key: string | true, args: TArgs): Promise<boolean> => {
      setPending(key);
      setError(null);
      try {
        await action(...args);
        options.onSuccess?.();
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.isNotAuthorized) {
          clearSession();
          return false;
        }
        if (isAdminTwoFactorSetupRequired(err)) {
          requireTwoFactorSetup();
          return false;
        }
        setError(localizedMessage(locale, options.errorKey));
        return false;
      } finally {
        // Only the call that claimed the flag may release it: two rows acted on
        // at once are legitimate, and the first to finish must not re-enable the
        // control the second one is still working.
        setPending((current) => (current === key ? false : current));
      }
    },
    // `action` and `options` are inline closures at every call site; re-creating
    // the callback on each render is correct and cheap for a write path.
    [action, clearSession, locale, options, requireTwoFactorSetup],
  );

  const run = useCallback((...args: TArgs) => execute(true, args), [execute]);
  const runFor = useCallback((key: string, ...args: TArgs) => execute(key, args), [execute]);

  return { run, runFor, pending, error, clearError };
}
