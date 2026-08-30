import { useQuery } from '@tanstack/react-query';

import type { EndpointVaultState } from '../keystore';
import { endpointVaultKeystore, restoreEndpointCustodyOnce } from '../keystore/runtime';

/**
 * The prefix every per-vault endpoint-state key hangs off — and the exact scope
 * an unlock, a lock or a custody restore has to invalidate.
 *
 * Deliberately narrower than `['vaults']`: the cleartext vault DIRECTORY lives
 * under `['vaults', 'configs']` and is a network read, so invalidating the root
 * would turn every local state change into an HTTP request.
 */
export const VAULT_ENDPOINT_STATE_QUERY_PREFIX = ['vaults', 'endpoint-state'] as const;

export function vaultEndpointStateQueryKey(vaultId: string) {
  return [...VAULT_ENDPOINT_STATE_QUERY_PREFIX, vaultId] as const;
}

/**
 * The one way any surface asks this endpoint about a vault.
 *
 * A device the user kept unlocked must never paint "Unlock" first and correct
 * itself afterwards, so every state read waits for the one-shot custody restore.
 * It is memoized per tab and short-circuits once the session is live, so this is
 * one IndexedDB read per account, not one per refetch — and going through this
 * function is what keeps the four call sites (stub, switcher, chip, manager)
 * from diverging on that guarantee.
 */
export async function readVaultEndpointState(vaultId: string): Promise<EndpointVaultState> {
  await restoreEndpointCustodyOnce();
  return endpointVaultKeystore.stateFor(vaultId);
}

export function useVaultEndpointState(vaultId: string | null) {
  return useQuery({
    queryKey: vaultEndpointStateQueryKey(vaultId ?? 'none'),
    queryFn: () => readVaultEndpointState(vaultId!),
    enabled: vaultId !== null,
    staleTime: 5_000,
  });
}
