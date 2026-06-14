import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../lib/apiClient';
import { useAuth } from './AuthContext';

interface ResourceState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

interface Resource<T> extends ResourceState<T> {
  /** Re-run the fetch (e.g. after a mutation). */
  reload: () => void;
}

/**
 * Loads a single admin resource with loading/error state and abort-on-unmount.
 * A 401/404 mid-session (expired cookie, account disabled) clears the session so
 * the route guard sends the admin back to the login screen — without leaking
 * which route or resource was involved (PROJECTPLAN.md §6.12).
 */
export function useResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): Resource<T> {
  const { clearSession } = useAuth();
  const [state, setState] = useState<ResourceState<T>>({
    data: null,
    loading: true,
    error: null,
  });
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    void (async () => {
      try {
        const data = await fetcher(controller.signal);
        if (!controller.signal.aborted) setState({ data, loading: false, error: null });
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (err instanceof ApiError && err.isNotAuthorized) {
          clearSession();
          return;
        }
        const message = err instanceof ApiError ? err.message : 'Something went wrong.';
        setState({ data: null, loading: false, error: message });
      }
    })();
    return () => controller.abort();
    // `fetcher` is intentionally excluded from the dependency list — callers pass
    // an inline closure and declare its real inputs through `deps`.
  }, [nonce, clearSession, ...deps]);

  return { ...state, reload };
}
