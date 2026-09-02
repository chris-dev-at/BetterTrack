import { useCallback, useEffect, useRef, useState } from 'react';

import { localizedMessage, useI18n } from '../i18n';
import { ApiError, classifyApiError } from '../lib/apiClient';
import { isAdminTwoFactorSetupRequired, useAuth } from './AuthContext';

interface ResourceState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  retryable: boolean;
}

export interface Resource<T> extends ResourceState<T> {
  /** Re-run the fetch (e.g. after a mutation). */
  reload: () => void;
}

/**
 * Loads a single admin resource with loading/error state and abort-on-unmount.
 * A 401/404 mid-session (expired cookie, account disabled) clears the session so
 * the route guard sends the admin back to the login screen — without leaking
 * which route or resource was involved (PROJECTPLAN.md §6.12). A 403
 * `ADMIN_2FA_SETUP_REQUIRED` (a break-glass reset stripped the last 2FA method
 * mid-use) instead traps into the forced-enrollment wizard (#400).
 */
export function useResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): Resource<T> {
  const { locale } = useI18n();
  const localeRef = useRef(locale);
  const { clearSession, requireTwoFactorSetup } = useAuth();
  const [state, setState] = useState<ResourceState<T>>({
    data: null,
    loading: true,
    error: null,
    retryable: false,
  });
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    localeRef.current = locale;
  }, [locale]);

  useEffect(() => {
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null, retryable: false }));
    void (async () => {
      try {
        const data = await fetcher(controller.signal);
        if (!controller.signal.aborted) {
          setState({ data, loading: false, error: null, retryable: false });
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (err instanceof ApiError && err.isNotAuthorized) {
          clearSession();
          return;
        }
        if (isAdminTwoFactorSetupRequired(err)) {
          requireTwoFactorSetup();
          return;
        }
        // API envelopes are authored by the server and are not locale-aware.
        // Authorization/setup outcomes above keep their structural handling;
        // every displayable failure uses catalog copy so DE never leaks an
        // English transport or 5xx message.
        const message = localizedMessage(localeRef.current, 'common.genericError');
        setState({
          data: null,
          loading: false,
          error: message,
          retryable: classifyApiError(err) === 'outage',
        });
      }
    })();
    return () => controller.abort();
    // `fetcher` is intentionally excluded from the dependency list — callers pass
    // an inline closure and declare its real inputs through `deps`.
  }, [nonce, clearSession, requireTwoFactorSetup, ...deps]);

  return { ...state, reload };
}
