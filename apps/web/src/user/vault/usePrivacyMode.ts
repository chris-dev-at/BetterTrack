import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, createElement, useContext, type ReactNode } from 'react';

import {
  paranoidMediaStateResponseSchema,
  type ParanoidEnableResponse,
  type ParanoidMediaStateResponse,
  type ParanoidVaultMediaState,
  type PrivacyMode,
} from '@bettertrack/contracts';

import { getParanoidMediaState } from '../../lib/userApi';

/** Shared with Settings → Connections so one fetch serves both surfaces. */
export const VAULT_MEDIA_QUERY_KEY = ['vault', 'media'] as const;

export function vaultMediaQueryKey(accountId: string | null) {
  return accountId == null
    ? VAULT_MEDIA_QUERY_KEY
    : ([...VAULT_MEDIA_QUERY_KEY, accountId] as const);
}

export interface ResolvedPrivacyModeState {
  accountId: string | null;
  privacyMode: PrivacyMode;
  mediaState: ParanoidVaultMediaState | null;
}

const ResolvedPrivacyModeContext = createContext<ResolvedPrivacyModeState>({
  accountId: null,
  privacyMode: 'normal',
  mediaState: null,
});
const OFFLINE_MODE_CACHE_PREFIX = 'bettertrack:vault-mode:';

export function ResolvedPrivacyModeProvider({
  children,
  mode,
  accountId = null,
  mediaState = null,
}: {
  children: ReactNode;
  mode: PrivacyMode;
  accountId?: string | null;
  mediaState?: ParanoidVaultMediaState | null;
}) {
  return createElement(
    ResolvedPrivacyModeContext.Provider,
    { value: { accountId, privacyMode: mode, mediaState } },
    children,
  );
}

/** Synchronous mode for already-gated day-to-day surfaces; defaults normal in isolated tests. */
export function useResolvedPrivacyMode(): PrivacyMode {
  return useContext(ResolvedPrivacyModeContext).privacyMode;
}

/** Authoritative state inherited from the account gate; never starts its own request. */
export function useResolvedPrivacyModeState(): ResolvedPrivacyModeState {
  return useContext(ResolvedPrivacyModeContext);
}

export interface PrivacyModeState {
  /** Resolved account privacy mode; null while loading or after an error. */
  privacyMode: PrivacyMode | null;
  mediaState: ParanoidVaultMediaState | null;
  isPending: boolean;
  isError: boolean;
  refetch(): Promise<void>;
  acceptEnabled(receipt: ParanoidEnableResponse): void;
  acceptNormal(): void;
}

/**
 * Account privacy mode (docs/paranoid-design.md §1) — account metadata, never
 * portfolio data. Paranoid gating fails closed: callers keep server portfolio
 * reads DISABLED until this resolves to 'normal'.
 */
export function usePrivacyMode(enabled = true, accountId: string | null = null): PrivacyModeState {
  const queryClient = useQueryClient();
  const queryKey = vaultMediaQueryKey(accountId);
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const result = await getParanoidMediaState(signal);
      cacheParanoidMode(accountId, result);
      return result;
    },
    initialData: () => readCachedParanoidMode(accountId),
    // This read gates the WHOLE authenticated app (`AccountModeRoot`), so a
    // single transient failure must not replace every page with a retry card
    // where the individual page queries used to retry themselves. Bounded, not
    // unlimited: the gate still fails closed — while these attempts run the
    // query is pending (a splash), and it never resolves to 'normal' on error.
    retry: 2,
    staleTime: 15_000,
    // Only a paranoid account polls. It is the one that must notice a disable
    // performed on another device *while a decrypted session is open*; a normal
    // account changes mode roughly once in its life, and the default refetch on
    // window focus (plus the 15 s staleTime) picks an enable up just as well
    // without a permanent 4 req/min heartbeat per signed-in user.
    refetchInterval: (query) =>
      enabled && query.state.data?.privacyMode === 'paranoid' ? 15_000 : false,
    refetchIntervalInBackground: false,
    enabled,
  });
  return {
    privacyMode: query.data?.privacyMode ?? null,
    mediaState: query.data?.mediaState ?? null,
    isPending: query.isPending,
    isError: query.isError && query.data == null,
    async refetch() {
      await queryClient.invalidateQueries({ queryKey, exact: true });
    },
    acceptEnabled(receipt) {
      const result = enabledState(receipt);
      queryClient.setQueryData(queryKey, result);
      cacheParanoidMode(accountId, result);
    },
    acceptNormal() {
      const result: ParanoidMediaStateResponse = {
        privacyMode: 'normal',
        mediaState: null,
      };
      queryClient.setQueryData(queryKey, result);
      cacheParanoidMode(accountId, result);
    },
  };
}

function enabledState(receipt: ParanoidEnableResponse): ParanoidMediaStateResponse {
  const serverSelected = receipt.mediaSet.includes('server');
  const driveSelected = receipt.mediaSet.includes('drive');
  return paranoidMediaStateResponseSchema.parse({
    privacyMode: 'paranoid',
    mediaState: {
      mediaSet: receipt.mediaSet,
      driveAttestedVersion: driveSelected ? receipt.vaultVersion : null,
      server: {
        disposition: serverSelected ? 'active' : 'empty',
        candidate: null,
        retired: null,
      },
    },
  });
}

/**
 * Cache only the fail-closed account state needed to open a Drive/local vault
 * offline. A normal result removes the marker; it is never cached because a
 * stale normal marker could expose route chrome before server enforcement.
 */
function cacheParanoidMode(accountId: string | null, result: ParanoidMediaStateResponse): void {
  if (accountId == null) return;
  try {
    const key = `${OFFLINE_MODE_CACHE_PREFIX}${accountId}`;
    if (result.privacyMode === 'paranoid') {
      globalThis.localStorage?.setItem(key, JSON.stringify(result));
    } else {
      globalThis.localStorage?.removeItem(key);
    }
  } catch {
    // Offline mode metadata is an optional availability aid, never key material.
  }
}

function readCachedParanoidMode(accountId: string | null): ParanoidMediaStateResponse | undefined {
  if (accountId == null) return undefined;
  try {
    const raw = globalThis.localStorage?.getItem(`${OFFLINE_MODE_CACHE_PREFIX}${accountId}`);
    if (!raw) return undefined;
    const parsed = paranoidMediaStateResponseSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.privacyMode === 'paranoid' ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
