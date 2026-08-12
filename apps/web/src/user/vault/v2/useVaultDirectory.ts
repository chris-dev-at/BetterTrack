import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { listVaults, readVaultHeaderDoc, VAULT2_QUERY_KEY } from './api';
import type { VaultPassphraseVaultStore } from './devicePassphrase';
import type { UnlockedVault } from './keyring';
import type { VaultKnowledge } from './sectionState';

/**
 * The Vaults v2 data reads: the vault list, each vault's header doc, and which
 * vaults this device remembers.
 *
 * It lives apart from `VaultsProvider` on purpose. The provider is app-level
 * because the in-memory keyring must survive navigation, but an app-level
 * component can never render a loading or an error state — it wraps everything.
 * Keeping the reads in a hook lets the provider stay headless and projects the
 * outcome as `status`, which the surfaces that CAN render those states
 * (`PortfolioVaultSection`, the locked rows) do render.
 */

export const VAULT2_DEVICE_QUERY_KEY = ['vaults', 'v2', 'device-passphrases'] as const;

export interface VaultDirectory {
  status: 'loading' | 'ready' | 'error';
  vaults: VaultKnowledge[];
  refresh: () => Promise<void>;
}

export function useVaultDirectory(input: {
  enabled: boolean;
  passphraseStore: VaultPassphraseVaultStore;
  unlocked: readonly UnlockedVault[];
}): VaultDirectory {
  const queryClient = useQueryClient();

  const vaultsQuery = useQuery({
    queryKey: VAULT2_QUERY_KEY,
    enabled: input.enabled,
    queryFn: async ({ signal }) => {
      const summaries = await listVaults(signal);
      // Header docs are small and independent; fetching them together keeps the
      // locked-row projection consistent instead of popping in per vault.
      return Promise.all(
        summaries.map(async (summary) => {
          try {
            return { summary, header: (await readVaultHeaderDoc(summary.id))?.header ?? null };
          } catch {
            // An unreadable header must not take the whole section down — the
            // vault still renders, just without its alias and index.
            return { summary, header: null };
          }
        }),
      );
    },
  });

  const remembered = useQuery({
    queryKey: VAULT2_DEVICE_QUERY_KEY,
    enabled: input.enabled,
    queryFn: async () =>
      new Set((await input.passphraseStore.list()).map((record) => record.vaultId)),
  });

  return useMemo(() => {
    const unlockedIds = new Set(input.unlocked.map((entry) => entry.vaultId));
    const vaults: VaultKnowledge[] = (vaultsQuery.data ?? []).map((item) => ({
      summary: item.summary,
      // Prefer the keyring's authenticated copy of the header once unlocked.
      header:
        input.unlocked.find((entry) => entry.vaultId === item.summary.id)?.header ?? item.header,
      unlocked: unlockedIds.has(item.summary.id),
      rememberedOnDevice: remembered.data?.has(item.summary.id) ?? false,
    }));

    return {
      status: vaultsQuery.isPending ? 'loading' : vaultsQuery.isError ? 'error' : 'ready',
      vaults,
      refresh: async () => {
        await queryClient.invalidateQueries({ queryKey: VAULT2_QUERY_KEY });
        await queryClient.invalidateQueries({ queryKey: VAULT2_DEVICE_QUERY_KEY });
      },
    };
  }, [
    input.unlocked,
    queryClient,
    remembered.data,
    vaultsQuery.data,
    vaultsQuery.isError,
    vaultsQuery.isPending,
  ]);
}
