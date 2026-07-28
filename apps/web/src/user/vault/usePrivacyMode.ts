import { useQuery } from '@tanstack/react-query';

import type { PrivacyMode } from '@bettertrack/contracts';

import { getParanoidMediaState } from '../../lib/userApi';

/** Shared with Settings → Connections so one fetch serves both surfaces. */
export const VAULT_MEDIA_QUERY_KEY = ['vault', 'media'] as const;

export interface PrivacyModeState {
  /** Resolved account privacy mode; null while loading or after an error. */
  privacyMode: PrivacyMode | null;
  isPending: boolean;
  isError: boolean;
}

/**
 * Account privacy mode (docs/paranoid-design.md §1) — account metadata, never
 * portfolio data. Paranoid gating fails closed: callers keep server portfolio
 * reads DISABLED until this resolves to 'normal'.
 */
export function usePrivacyMode(): PrivacyModeState {
  const query = useQuery({
    queryKey: VAULT_MEDIA_QUERY_KEY,
    queryFn: ({ signal }) => getParanoidMediaState(signal),
    retry: false,
    staleTime: 15_000,
  });
  return {
    privacyMode: query.data?.privacyMode ?? null,
    isPending: query.isPending,
    isError: query.isError,
  };
}
