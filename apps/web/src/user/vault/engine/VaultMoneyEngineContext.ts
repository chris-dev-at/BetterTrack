import { createContext, useContext } from 'react';

import type { VaultSyncEngine } from '../sync';
import type { VaultPortfolioStore } from '../vaultPortfolioStore';
import type { VaultMoneyEngine } from './types';

/**
 * Context-only half of the PD7 money engine, split off for the same reason as
 * `VaultRuntimeContext`: reading the session must not drag the provider — and
 * through it the store, the derivation engine and the market adapter — into a
 * normal-mode chunk. Surfaces that only *read* a session (`TaxReportPage`'s
 * paranoid branch, the privacy panel's vault section, the cleartext export)
 * import from here; only `VaultAccountRoot` imports the provider itself.
 */

/** Everything a paranoid surface needs from one unlocked vault session. */
export interface VaultMoneySession {
  engine: VaultMoneyEngine;
  sync: VaultSyncEngine;
  store: VaultPortfolioStore;
}

export const VaultMoneyEngineContext = createContext<VaultMoneySession | null>(null);

/** The active money session, or null while the vault is locked. */
export function useVaultMoneySession(): VaultMoneySession | null {
  return useContext(VaultMoneyEngineContext);
}
