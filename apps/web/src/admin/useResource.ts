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
 * What a 404 means for this particular read. The mirror of
 * {@link AdminMutationNotFoundPolicy} on the write seam, and for the same reason.
 *
 * `apiClient`'s `isNotAuthorized` is `401 || 404`, because the admin API answers
 * 404 to non-admins on purpose (§6.12 — no information leak). For a read that
 * addresses a WHOLE surface — the user list, the health page — that conflation
 * is right: a 404 there means the caller is no longer an admin.
 *
 * For a read addressed by a ROW ID it is not. `GET /admin/feedback/:id` 404s
 * when that one submission is gone, which is exactly what a stale helpdesk link
 * produces — and treating it as auth loss signs a working admin out for clicking
 * an old link.
 *
 *  - `session` (default) — a 404 is auth loss, and the session is cleared.
 *  - `gone` — a 404 resolves to `data: null` with no error, so the surface can
 *    say "this row no longer exists". Only for id-addressed reads, and only
 *    where some OTHER read on the same screen still carries the `session`
 *    policy — otherwise a revoked admin would sit on a stale pane forever.
 */
export type AdminResourceNotFoundPolicy = 'session' | 'gone';

export interface UseResourceOptions {
  /** How to read a 404. Defaults to `session`; see the type's docs. */
  notFound?: AdminResourceNotFoundPolicy;
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
  options: UseResourceOptions = {},
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
  // Call sites pass an inline options object every render; a ref keeps it out
  // of the effect's dependency list without going stale.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

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
        // A row-scoped 404 under the `gone` policy is an ANSWER, not auth loss:
        // resolve to null and let the surface say the row is no longer there.
        if (
          err instanceof ApiError &&
          err.status === 404 &&
          optionsRef.current.notFound === 'gone'
        ) {
          setState({ data: null, loading: false, error: null, retryable: false });
          return;
        }
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
