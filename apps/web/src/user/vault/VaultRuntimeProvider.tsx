import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { createIndexedDbVaultCustody } from './custody';
import { VaultLockCore } from './lock';

const VaultRuntimeContext = createContext<VaultLockCore | null>(null);

/**
 * Production owner for the unlocked vault-key lifecycle. A successful unlock
 * installs the Drive/media/sync composition through `VaultLockCore`; leaving
 * the authenticated shell removes that capability and clears the in-memory key.
 */
export function VaultRuntimeProvider({
  authenticated,
  children,
}: {
  authenticated: boolean;
  children: ReactNode;
}) {
  const [core] = useState(() => new VaultLockCore({ custody: createIndexedDbVaultCustody() }));

  useEffect(() => {
    if (!authenticated) void core.lock();
    return () => {
      void core.lock();
    };
  }, [authenticated, core]);

  return <VaultRuntimeContext.Provider value={core}>{children}</VaultRuntimeContext.Provider>;
}

export function useVaultRuntime(): VaultLockCore {
  const runtime = useContext(VaultRuntimeContext);
  if (!runtime) throw new Error('useVaultRuntime must be used within VaultRuntimeProvider.');
  return runtime;
}
