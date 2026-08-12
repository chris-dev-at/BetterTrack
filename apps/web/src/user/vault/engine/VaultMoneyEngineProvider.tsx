import { useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  createBetterTrackMarketDataSource,
  type MarketDataSource,
} from '../../../lib/marketDataSource';
import { VaultCryptoError } from '../errors';
import type { VaultDriveSyncCoordinator } from '../media/runtime';
import type { VaultSyncEngine } from '../sync';
import { createVaultPortfolioStore } from '../vaultPortfolioStore';
// The CONTEXT module, never `VaultRuntimeProvider`: the provider pulls the lock
// core and with it argon2/fflate, and this module is reachable from any surface
// that mounts a money session.
import { useOptionalVaultRuntime } from '../VaultRuntimeContext';
import { VaultMoneyEngineContext, type VaultMoneySession } from './VaultMoneyEngineContext';
import { createVaultMoneyEngine } from './index';

export interface VaultMoneyEngineDependencies {
  /** Replaces the runtime-derived sync access (tests and isolated pages). */
  sync?: VaultSyncEngine | null;
  market?: MarketDataSource;
  createEngine?: typeof createVaultMoneyEngine;
  createStore?: typeof createVaultPortfolioStore;
}

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
 * One money session's seam over the unlocked sync access. Locking revokes it,
 * so every stale holder of the previous session — an in-flight cleartext
 * export, the fire-and-forget standing-order catch-up, a captured session
 * object — fails locked instead of reading or mutating through the retired
 * unlock, regardless of where the seam came from (runtime or injected).
 */
export function revocableMoneySessionSync(sync: VaultSyncEngine): {
  sync: VaultSyncEngine;
  revoke: () => void;
  /** StrictMode's simulated unmount re-arms the still-provided session. */
  restore: () => void;
} {
  let revoked = false;
  function requireLive(): void {
    if (revoked) {
      throw new VaultCryptoError('locked', 'The vault money session was revoked by a lock.');
    }
  }
  async function guarded(run: () => ReturnType<VaultSyncEngine['reconnect']>) {
    requireLive();
    const state = await run();
    requireLive();
    return state;
  }
  return {
    sync: {
      deviceId: sync.deviceId,
      get state() {
        requireLive();
        return sync.state;
      },
      start: () => guarded(() => sync.start()),
      reconnect: () => guarded(() => sync.reconnect()),
      mutate: (mutator) => guarded(() => sync.mutate(mutator)),
    },
    revoke: () => {
      revoked = true;
    },
    restore: () => {
      revoked = false;
    },
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
  const managed = useMemo<{
    session: VaultMoneySession;
    revoke: () => void;
    restore: () => void;
  } | null>(() => {
    if (sync === null) return null;
    const seam = revocableMoneySessionSync(sync);
    return {
      session: {
        engine: createEngine(seam.sync, market),
        sync: seam.sync,
        store: createStore(seam.sync),
      },
      revoke: seam.revoke,
      restore: seam.restore,
    };
  }, [createEngine, createStore, market, sync]);
  const session = managed === null ? null : managed.session;

  useEffect(() => {
    if (managed === null) return;
    // A real lock replaces `managed` entirely, so restore only ever re-arms
    // the same session after StrictMode's simulated unmount in development.
    managed.restore();
    void managed.session.engine.afterUnlock();
    return () => {
      // Lock boundary: revoke the seam FIRST so in-flight work fails locked,
      // then drop every derived in-memory result.
      managed.revoke();
      managed.session.engine.clearCache();
    };
  }, [managed]);

  return (
    <VaultMoneyEngineContext.Provider value={session}>{children}</VaultMoneyEngineContext.Provider>
  );
}
