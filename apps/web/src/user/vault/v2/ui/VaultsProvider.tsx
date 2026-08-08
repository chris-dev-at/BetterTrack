import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import {
  createIndexedDbVaultPassphraseStore,
  type VaultPassphraseVaultStore,
} from '../devicePassphrase';
import { VaultKeyring } from '../keyring';
import type { VaultKnowledge } from '../sectionState';
import { useVaultDirectory } from '../useVaultDirectory';

/**
 * App-level Vaults v2 context: the vault directory, the in-memory keyring and
 * the device passphrase store.
 *
 * It is mounted once, high in the tree, because the keyring must survive route
 * changes — reconstructing it would silently relock every vault — and because
 * both the portfolio settings section and every money surface that renders
 * locked rows need the same answer.
 *
 * It renders no copy and no async states of its own: a component that wraps the
 * whole app cannot honestly show a spinner. `status` is projected to the
 * surfaces that can (`PortfolioVaultSection`, locked rows).
 */

export interface VaultsContextValue {
  status: 'loading' | 'ready' | 'error';
  vaults: VaultKnowledge[];
  keyring: VaultKeyring;
  passphraseStore: VaultPassphraseVaultStore;
  /** Refetch the vault list, every header doc, and the device records. */
  refresh: () => Promise<void>;
}

const VaultsContext = createContext<VaultsContextValue | null>(null);

export interface VaultsProviderProps {
  children: ReactNode;
  /** Test seams; production builds the real IndexedDB store and a fresh keyring. */
  keyring?: VaultKeyring;
  passphraseStore?: VaultPassphraseVaultStore;
  /** Skip the network entirely — used by surfaces that must not query. */
  enabled?: boolean;
}

export function VaultsProvider({
  children,
  keyring,
  passphraseStore,
  enabled = true,
}: VaultsProviderProps) {
  const ring = useMemo(() => keyring ?? new VaultKeyring(), [keyring]);
  const store = useMemo(
    () => passphraseStore ?? createIndexedDbVaultPassphraseStore(),
    [passphraseStore],
  );

  // Zero every content key when the provider unmounts (sign-out, app teardown).
  useEffect(() => () => ring.lockAll(), [ring]);

  const unlocked = useSyncExternalStore(ring.subscribe, ring.getSnapshot, ring.getSnapshot);
  const directory = useVaultDirectory({ enabled, passphraseStore: store, unlocked });

  const value = useMemo<VaultsContextValue>(
    () => ({
      status: directory.status,
      vaults: directory.vaults,
      keyring: ring,
      passphraseStore: store,
      refresh: directory.refresh,
    }),
    [directory.refresh, directory.status, directory.vaults, ring, store],
  );

  return <VaultsContext.Provider value={value}>{children}</VaultsContext.Provider>;
}

/**
 * Read the vault context. Returns `null` outside a provider so surfaces that
 * may render before it is mounted degrade to "no vaults" instead of throwing.
 */
export function useVaults(): VaultsContextValue | null {
  return useContext(VaultsContext);
}
