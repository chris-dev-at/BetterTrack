import type { MarketDataSource } from '../../../lib/marketDataSource';
import { asMoneyFailure, type VaultMoneyOutcome } from '../engine/errors';
import type { VaultSyncEngine } from '../sync';
import { createVaultPortfolioStore, type VaultPortfolioStore } from '../vaultPortfolioStore';
import {
  materializeDueStandingOrders,
  type StandingOrderMaterializationResult,
  type StandingOrderMaterializerOptions,
} from './materialize';

type Materialize = typeof materializeDueStandingOrders;

export interface StandingOrderMaterializationLifecycleOptions extends StandingOrderMaterializerOptions {
  store?: VaultPortfolioStore;
  /** Initial call plus this many immediate retries for retryable boundaries. */
  retryCount?: number;
  materialize?: Materialize;
}

export interface StandingOrderMaterializationLifecycle {
  /** Application bootstrap boundary; concurrent callers share one run. */
  onAppOpen(): Promise<VaultMoneyOutcome<StandingOrderMaterializationResult>>;
  /** Fresh-unlock boundary; a prior locked result is deliberately attempted again. */
  afterUnlock(): Promise<VaultMoneyOutcome<StandingOrderMaterializationResult>>;
  /** Latest completed scan in this unlocked session; never persisted in the vault document. */
  getLastStandingOrderMaterialization(): StandingOrderMaterializationResult | null;
  /** Observe successful scan results without coupling UI state to booking mutations. */
  subscribeStandingOrderMaterialization(listener: () => void): () => void;
}

/**
 * Lifecycle adapter for standing-order catch-up. It coalesces concurrent app
 * bootstrap/derivation calls, retries typed transient failures, and leaves a
 * locked vault dormant until the next explicit unlock boundary.
 */
export function createStandingOrderMaterializationLifecycle(
  sync: VaultSyncEngine,
  market: MarketDataSource,
  options: StandingOrderMaterializationLifecycleOptions = {},
): StandingOrderMaterializationLifecycle {
  const store = options.store ?? createVaultPortfolioStore(sync);
  const materialize = options.materialize ?? materializeDueStandingOrders;
  const retryCount = options.retryCount ?? 1;
  let inFlight: Promise<VaultMoneyOutcome<StandingOrderMaterializationResult>> | null = null;
  let lastResult: StandingOrderMaterializationResult | null = null;
  const listeners = new Set<() => void>();

  function run(): Promise<VaultMoneyOutcome<StandingOrderMaterializationResult>> {
    if (inFlight !== null) return inFlight;
    const current = runWithRetry().then((outcome) => {
      if (outcome.ok) publish(outcome.value);
      return outcome;
    });
    inFlight = current;
    const clear = () => {
      if (inFlight === current) inFlight = null;
    };
    void current.then(clear, clear);
    return current;
  }

  async function runWithRetry(): Promise<VaultMoneyOutcome<StandingOrderMaterializationResult>> {
    let outcome = await invoke();
    for (
      let attempt = 0;
      !outcome.ok &&
      outcome.error.retryable &&
      outcome.error.code !== 'VAULT_LOCKED' &&
      attempt < retryCount;
      attempt += 1
    ) {
      outcome = await invoke();
    }
    return outcome;
  }

  async function invoke(): Promise<VaultMoneyOutcome<StandingOrderMaterializationResult>> {
    try {
      return await materialize(sync, store, market, {
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (cause) {
      return { ok: false, error: asMoneyFailure(cause) };
    }
  }

  function publish(result: StandingOrderMaterializationResult): void {
    lastResult = result;
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        // An observer cannot turn a completed materialization into a failed run.
        console.error('Failed to notify standing-order materialization observer.', error);
      }
    }
  }

  function subscribeStandingOrderMaterialization(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    onAppOpen: run,
    afterUnlock: run,
    getLastStandingOrderMaterialization: () => lastResult,
    subscribeStandingOrderMaterialization,
  };
}
