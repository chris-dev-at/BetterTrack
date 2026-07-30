import { createContext, useContext, type ReactNode } from 'react';

import {
  portfolioHistoryResponseSchema,
  portfolioResponseSchema,
  type PortfolioHistoryResponse,
  type PortfolioResponse,
} from '@bettertrack/contracts';

import { apiPortfolioStore, type PortfolioStore } from '../../lib/portfolioStore';
import { VaultMoneyEngineError } from '../vault/engine/errors';
import { readPortfolioModel } from '../vault/engine/model';
import type { ClientPortfolioDerivation, VaultMoneyEngine } from '../vault/engine/types';
import type { VaultMoneySession } from '../vault/engine/VaultMoneyEngineProvider';

const PortfolioStoreContext = createContext<PortfolioStore>(apiPortfolioStore);

export function PortfolioStoreProvider({
  children,
  store = apiPortfolioStore,
}: {
  children: ReactNode;
  store?: PortfolioStore;
}) {
  return <PortfolioStoreContext.Provider value={store}>{children}</PortfolioStoreContext.Provider>;
}

export function usePortfolioStore(): PortfolioStore {
  return useContext(PortfolioStoreContext);
}

/**
 * Compose PD5's decrypted mutation store with PD7's client derivation engine.
 * Pages receive the same response contracts in either account mode and never
 * need a second paranoid-only implementation.
 */
export function createParanoidAppPortfolioStore(session: VaultMoneySession): PortfolioStore {
  return {
    listPortfolios: (...args) => session.store.listPortfolios(...args),
    createPortfolio: (...args) => session.store.createPortfolio(...args),
    async getPortfolio(portfolioId, signal) {
      const derived = await requireDerivation(session.engine, portfolioId, '1D', signal);
      return portfolioResponse(derived, session);
    },
    async getPortfolioHistory(portfolioId, range, _overlay, signal) {
      const derived = await requireDerivation(session.engine, portfolioId, range, signal);
      return portfolioHistoryResponse(derived);
    },
    updatePortfolio: (...args) => session.store.updatePortfolio(...args),
    archivePortfolio: (...args) => session.store.archivePortfolio(...args),
    restorePortfolio: (...args) => session.store.restorePortfolio(...args),
    deletePortfolio: (...args) => session.store.deletePortfolio(...args),
    getTaxSettings: (...args) => session.store.getTaxSettings(...args),
    updateTaxSettings: (...args) => session.store.updateTaxSettings(...args),
    getPortfolioTaxSettings: (...args) => session.store.getPortfolioTaxSettings(...args),
    setPortfolioTaxOverride: (...args) => session.store.setPortfolioTaxOverride(...args),
    clearPortfolioTaxOverride: (...args) => session.store.clearPortfolioTaxOverride(...args),
    listCustomAssets: (...args) => session.store.listCustomAssets(...args),
    createCustomAsset: (...args) => session.store.createCustomAsset(...args),
    updateCustomAsset: (...args) => session.store.updateCustomAsset(...args),
    getValuePoints: (...args) => session.store.getValuePoints(...args),
    putValuePoints: (...args) => session.store.putValuePoints(...args),
    listTransactions: (...args) => session.store.listTransactions(...args),
    createTransactions: (...args) => session.store.createTransactions(...args),
    updateTransaction: (...args) => session.store.updateTransaction(...args),
    deleteTransaction: (...args) => session.store.deleteTransaction(...args),
    listCashSources: (...args) => session.store.listCashSources(...args),
    createCashSource: (...args) => session.store.createCashSource(...args),
    updateCashSource: (...args) => session.store.updateCashSource(...args),
    archiveCashSource: (...args) => session.store.archiveCashSource(...args),
    restoreCashSource: (...args) => session.store.restoreCashSource(...args),
    getCashMovements: (...args) => session.store.getCashMovements(...args),
    previewCash: (...args) => session.store.previewCash(...args),
    depositCash: (...args) => session.store.depositCash(...args),
    withdrawCash: (...args) => session.store.withdrawCash(...args),
    transferCash: (...args) => session.store.transferCash(...args),
    setCashBalance: (...args) => session.store.setCashBalance(...args),
    listStandingOrders: (...args) => session.store.listStandingOrders(...args),
    createStandingOrder: (...args) => session.store.createStandingOrder(...args),
    updateStandingOrder: (...args) => session.store.updateStandingOrder(...args),
    pauseStandingOrder: (...args) => session.store.pauseStandingOrder(...args),
    resumeStandingOrder: (...args) => session.store.resumeStandingOrder(...args),
    deleteStandingOrder: (...args) => session.store.deleteStandingOrder(...args),
  };
}

async function requireDerivation(
  engine: VaultMoneyEngine,
  portfolioId: string,
  range: ClientPortfolioDerivation['range'],
  signal?: AbortSignal,
): Promise<ClientPortfolioDerivation> {
  const outcome = await engine.derivePortfolio(portfolioId, range, signal);
  if (!outcome.ok) throw new VaultMoneyEngineError(outcome.error);
  return outcome.value;
}

function portfolioResponse(
  derived: ClientPortfolioDerivation,
  session: VaultMoneySession,
): PortfolioResponse {
  const document = session.sync.state.active?.document;
  if (document == null) {
    throw new VaultMoneyEngineError({
      code: 'VAULT_DATA_UNAVAILABLE',
      message: 'No authenticated vault document is available.',
      retryable: true,
    });
  }
  const model = readPortfolioModel(document, derived.portfolioId);
  const holdings = derived.holdings.map((holding) => {
    const asset = model.assets.get(holding.assetId)?.dto;
    if (asset == null) {
      throw new VaultMoneyEngineError({
        code: 'VAULT_CORRUPT',
        message: 'A vault holding references an unavailable asset.',
        retryable: false,
      });
    }
    return { ...holding, asset };
  });
  const investedEur = holdings.reduce((sum, holding) => sum + (holding.costBasisEur ?? 0), 0);
  const marketValueEur = derived.holdingsValueEur ?? 0;
  const unrealizedPnlEur = holdings.reduce(
    (sum, holding) => sum + (holding.unrealizedPnlEur ?? 0),
    0,
  );
  const dayChangeEur = holdings.reduce((sum, holding) => sum + (holding.dayChangeEur ?? 0), 0);
  const previousValueEur = marketValueEur - dayChangeEur;

  return portfolioResponseSchema.parse({
    baseCurrency: derived.baseCurrency,
    holdings,
    totals: {
      marketValueEur,
      investedEur,
      unrealizedPnlEur,
      unrealizedPnlPct: investedEur === 0 ? null : (unrealizedPnlEur / investedEur) * 100,
      dayChangeEur,
      dayChangePct: previousValueEur === 0 ? null : (dayChangeEur / previousValueEur) * 100,
      cashEur: derived.cashBalanceEur,
      totalValueEur: derived.totalValueEur ?? marketValueEur + derived.cashBalanceEur,
    },
  });
}

function portfolioHistoryResponse(derived: ClientPortfolioDerivation): PortfolioHistoryResponse {
  const readable = derived.series.filter(
    (point): point is typeof point & { valueEur: number } => point.valueEur !== null,
  );
  return portfolioHistoryResponseSchema.parse({
    range: derived.range,
    baseCurrency: derived.baseCurrency,
    points: readable.map((point) => ({ date: point.date, valueEur: point.valueEur })),
    performance: readable.map((point) => ({ date: point.date, pct: point.twrPct ?? 0 })),
  });
}
