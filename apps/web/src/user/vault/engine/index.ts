import type { MarketDataSource } from '../../../lib/marketDataSource';
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
}

/** The complete PD7 client money engine over one authenticated vault session. */
export function createVaultMoneyEngine(
  sync: VaultSyncEngine,
  market: MarketDataSource,
  options: CreateVaultMoneyEngineOptions = {},
): VaultMoneyEngine {
  const portfolio = createPortfolioDerivationEngine(sync, market, options);
  const tax = createClientTaxEngine(sync, market, options);
  return {
    derivePortfolio: portfolio.derivePortfolio,
    deriveTaxReport: tax.deriveTaxReport,
    clearCache() {
      portfolio.clearCache();
      tax.clearTaxCache();
    },
  };
}
