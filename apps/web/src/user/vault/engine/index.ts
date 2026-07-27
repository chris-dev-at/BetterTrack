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
  const appOpenCatchUp = standingOrders.onAppOpen();

  async function catchUpStandingOrders(): Promise<void> {
    const initial = await appOpenCatchUp;
    if (!initial.ok && initial.error.code === 'VAULT_LOCKED') {
      await standingOrders.afterUnlock();
    }
  }

  return {
    async derivePortfolio(...args) {
      await catchUpStandingOrders();
      return portfolio.derivePortfolio(...args);
    },
    async deriveTaxReport(...args) {
      await catchUpStandingOrders();
      return tax.deriveTaxReport(...args);
    },
    clearCache() {
      portfolio.clearCache();
      tax.clearTaxCache();
    },
  };
}
