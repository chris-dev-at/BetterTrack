import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';

import { createIndexedDbVaultCustody } from './custody';
import { VaultLockCore } from './lock';

const VaultRuntimeContext = createContext<VaultLockCore | null>(null);

/**
 * Production owner for the unlocked vault-key lifecycle. PD8 unlock surfaces
 * consume this core; every successful unlock automatically installs the real
 * Drive/DataHome/media/sync composition through `VaultLockCore`. Leaving the
 * authenticated shell always disposes that runtime and its in-memory key.
 */
export function VaultRuntimeProvider({
  authenticated,
  children,
}: {
  authenticated: boolean;
  children: ReactNode;
}) {
  const core = useRef<VaultLockCore | null>(null);
  core.current ??= new VaultLockCore({ custody: createIndexedDbVaultCustody() });

  useEffect(() => {
    const current = core.current;
    if (!authenticated) void current?.lock();
    return () => {
      void current?.lock();
    };
  }, [authenticated]);

  return (
    <VaultRuntimeContext.Provider value={core.current}>{children}</VaultRuntimeContext.Provider>
  );
}

export function useVaultRuntime(): VaultLockCore {
  const runtime = useContext(VaultRuntimeContext);
  if (!runtime) throw new Error('useVaultRuntime must be used within VaultRuntimeProvider.');
  return runtime;
}
