import { useMemo } from 'react';

import { UserApp } from '../UserApp';

import { createVaultPortfolioStore } from './vaultPortfolioStore';
import type { VaultSyncEngine } from './sync';

/**
 * Authenticated paranoid-mode composition point. The PD8 bootstrap owns
 * creating, unlocking, and starting the engine; once it has one, every
 * portfolio mutation in the normal user route tree receives the vault store.
 */
export function VaultUserApp({ engine }: { engine: VaultSyncEngine }) {
  const portfolioStore = useMemo(() => createVaultPortfolioStore(engine), [engine]);
  return <UserApp portfolioStore={portfolioStore} />;
}
