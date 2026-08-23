import { useQuery } from '@tanstack/react-query';

import { endpointVaultKeystore } from '../keystore/runtime';

export function vaultEndpointStateQueryKey(vaultId: string) {
  return ['vaults', 'endpoint-state', vaultId] as const;
}

export function useVaultEndpointState(vaultId: string | null) {
  return useQuery({
    queryKey: vaultEndpointStateQueryKey(vaultId ?? 'none'),
    queryFn: () => endpointVaultKeystore.stateFor(vaultId!),
    enabled: vaultId !== null,
    staleTime: 5_000,
  });
}
