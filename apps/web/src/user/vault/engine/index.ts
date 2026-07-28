import type { MarketDataSource } from '../../../lib/marketDataSource';
import {
  createStandingOrderMaterializationLifecycle,
  type StandingOrderMaterializationLifecycle,
} from '../standingOrders/lifecycle';
import type { VaultSyncEngine } from '../sync';
import { createPortfolioDerivationEngine } from './portfolioEngine';
import { createClientTaxEngine } from './taxEngine';
import type { VaultMoneyEngine } from './types';

export * from './cache';
export * from './errors';
export * from './portfolioEngine';
export * from './session';
export * from './taxEngine';
export * from './types';

export interface CreateVaultMoneyEngineOptions {
  now?: () => number;
  standingOrders?: StandingOrderMaterializationLifecycle;
}

/** The complete PD7 client money engine over one authenticated vault session. */
export function createVaultMoneyEngine(
  sync: VaultSyncEngine,
  market: MarketDataSource,
  options: CreateVaultMoneyEngineOptions = {},
): VaultMoneyEngine {
  const portfolio = createPortfolioDerivationEngine(sync, market, options);
  const tax = createClientTaxEngine(sync, market, options);
  const now = options.now;
  const standingOrders =
    options.standingOrders ??
    createStandingOrderMaterializationLifecycle(sync, market, {
      ...(now === undefined ? {} : { now: () => new Date(now()) }),
    });
  let requiredCatchUp: ReturnType<StandingOrderMaterializationLifecycle['onAppOpen']> | null = null;
  let unlockRequired = false;

  function onAppOpen() {
    if (requiredCatchUp === null) {
      requiredCatchUp = trackCatchUp(standingOrders.onAppOpen());
    }
    return requiredCatchUp;
  }

  function afterUnlock() {
    unlockRequired = false;
    requiredCatchUp = trackCatchUp(standingOrders.afterUnlock());
    return requiredCatchUp;
  }

  function trackCatchUp(catchUp: ReturnType<StandingOrderMaterializationLifecycle['onAppOpen']>) {
    void catchUp.then(
      (outcome) => {
        if (requiredCatchUp !== catchUp || outcome.ok) return;
        if (outcome.error.code === 'VAULT_LOCKED') {
          unlockRequired = true;
          return;
        }
        if (outcome.error.retryable && !unlockRequired) {
          requiredCatchUp = null;
        }
      },
      () => {
        if (requiredCatchUp === catchUp && !unlockRequired) {
          requiredCatchUp = null;
        }
      },
    );
    return catchUp;
  }

  async function catchUpFailure() {
    const outcome = await onAppOpen();
    return outcome.ok ? null : outcome.error;
  }

  return {
    onAppOpen,
    afterUnlock,
    async derivePortfolio(...args) {
      const error = await catchUpFailure();
      if (error !== null) return { ok: false, error };
      return portfolio.derivePortfolio(...args);
    },
    async deriveTaxReport(...args) {
      const error = await catchUpFailure();
      if (error !== null) return { ok: false, error };
      return tax.deriveTaxReport(...args);
    },
    clearCache() {
      portfolio.clearCache();
      tax.clearTaxCache();
    },
  };
}
