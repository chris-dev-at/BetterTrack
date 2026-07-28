import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  createBetterTrackMarketDataSource,
  type MarketDataSource,
} from '../../../lib/marketDataSource';
import type { VaultDriveSyncCoordinator } from '../media/runtime';
import type { VaultSyncEngine } from '../sync';
import { createVaultPortfolioStore, type VaultPortfolioStore } from '../vaultPortfolioStore';
import { useOptionalVaultRuntime } from '../VaultRuntimeProvider';
import { createVaultMoneyEngine } from './index';
import type { VaultMoneyEngine } from './types';

/** Everything a paranoid surface needs from one unlocked vault session. */
export interface VaultMoneySession {
  engine: VaultMoneyEngine;
  sync: VaultSyncEngine;
  store: VaultPortfolioStore;
}

export interface VaultMoneyEngineDependencies {
  /** Replaces the runtime-derived sync access (tests and isolated pages). */
  sync?: VaultSyncEngine | null;
  market?: MarketDataSource;
  createEngine?: typeof createVaultMoneyEngine;
  createStore?: typeof createVaultPortfolioStore;
}

const VaultMoneyEngineContext = createContext<VaultMoneySession | null>(null);

/** Adapt the unlocked runtime's narrow sync coordinator to the engine's sync surface. */
export function moneyEngineSyncAccess(coordinator: VaultDriveSyncCoordinator): VaultSyncEngine {
  return {
    deviceId: coordinator.deviceId,
    get state() {
      return coordinator.state;
    },
    start: () => coordinator.reconnect(),
    reconnect: () => coordinator.reconnect(),
    mutate: (mutator) => coordinator.mutate(mutator),
  };
}

/**
 * Production owner of the PD7 client money engine. A money session exists
 * exactly while the vault runtime holds an unlocked sync seam; its creation is
 * the unlock/app-open boundary, so standing-order catch-up starts immediately
 * and its outcome gates every later derivation inside the engine. Locking
 * drops the session and clears every derived in-memory result.
 */
export function VaultMoneyEngineProvider({
  children,
  dependencies,
}: {
  children: ReactNode;
  dependencies?: VaultMoneyEngineDependencies;
}) {
  const runtime = useOptionalVaultRuntime();
  const coordinator = runtime?.sync ?? null;
  const [market] = useState<MarketDataSource>(
    () => dependencies?.market ?? createBetterTrackMarketDataSource(),
  );

  const injectedSync = dependencies?.sync;
  const sync = useMemo<VaultSyncEngine | null>(
    () =>
      injectedSync !== undefined ? injectedSync : coordinator && moneyEngineSyncAccess(coordinator),
    [coordinator, injectedSync],
  );

  const createEngine = dependencies?.createEngine ?? createVaultMoneyEngine;
  const createStore = dependencies?.createStore ?? createVaultPortfolioStore;
  const session = useMemo<VaultMoneySession | null>(
    () =>
      sync === null ? null : { engine: createEngine(sync, market), sync, store: createStore(sync) },
    [createEngine, createStore, market, sync],
  );

  useEffect(() => {
    if (session === null) return;
    void session.engine.afterUnlock();
    return () => {
      session.engine.clearCache();
    };
  }, [session]);

  return (
    <VaultMoneyEngineContext.Provider value={session}>{children}</VaultMoneyEngineContext.Provider>
  );
}

/** The active money session, or null while the vault is locked. */
export function useVaultMoneySession(): VaultMoneySession | null {
  return useContext(VaultMoneyEngineContext);
}
