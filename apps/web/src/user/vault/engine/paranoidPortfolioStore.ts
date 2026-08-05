import {
  portfolioHistoryResponseSchema,
  portfolioResponseSchema,
  type PortfolioHistoryResponse,
  type PortfolioResponse,
} from '@bettertrack/contracts';

import type { PortfolioStore } from '../../../lib/portfolioStore';
import { VaultMoneyEngineError } from './errors';
import { readPortfolioModel } from './model';
import type { ClientPortfolioDerivation, VaultMoneyEngine } from './types';
import type { VaultMoneySession } from './VaultMoneyEngineProvider';

/**
 * Compose PD5's decrypted mutation store with PD7's client derivation engine.
 * Kept inside the lazy vault graph so normal-mode sessions only load the API
 * portfolio adapter.
 */
export function createParanoidAppPortfolioStore(session: VaultMoneySession): PortfolioStore {
  return {
    listPortfolios: (...args) => session.store.listPortfolios(...args),
    createPortfolio: (...args) => session.store.createPortfolio(...args),
    async getPortfolio(portfolioId, signal) {
      const derived = await requireDerivation(session.engine, portfolioId, '1D', signal);
      return portfolioResponse(derived, session);
    },
    // `overlay` (the per-asset series the analytics chart can lay over the
    // primary) is not answerable here: the client engine derives one
    // portfolio-level curve, not one per asset. Its single caller —
    // AnalyticsPage's overlay toggle — is normal-mode only, and the control
    // that turns it on is not rendered for a paranoid account, so this never
    // silently drops a requested overlay (docs/paranoid-design.md §8 item 12).
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
    chargeCashFee: (...args) => session.store.chargeCashFee(...args),
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
    // Projected field by field, never spread: the domain holding also carries
    // `assetId`/`currency`, which the strict holding contract rejects.
    return {
      asset,
      quantity: holding.quantity,
      avgCost: holding.avgCost,
      realizedPnl: holding.realizedPnl,
      price: holding.price,
      marketValueEur: holding.marketValueEur,
      costBasisEur: holding.costBasisEur,
      unrealizedPnlEur: holding.unrealizedPnlEur,
      unrealizedPnlPct: holding.unrealizedPnlPct,
      dayChangeEur: holding.dayChangeEur,
      dayChangePct: holding.dayChangePct,
    };
  });
  const investedEur = holdings.reduce((sum, holding) => sum + (holding.costBasisEur ?? 0), 0);
  // Σ (marketValueEur ?? 0) — the client engine refuses to derive at all while
  // an ACTIVE holding has no price (`MARKET_DATA_MISSING`), so this is the
  // server's guarded market-value sum, not an optimistic one.
  const marketValueEur = derived.holdingsValueEur ?? 0;
  // The chosen invariant is the server's (portfolioService.computeTotals):
  // unrealized = value − invested, so the three header numbers always add up on
  // screen. Summing per-holding `unrealizedPnlEur` instead would drop the
  // null rows while their cost still counted in `investedEur`.
  const unrealizedPnlEur = marketValueEur - investedEur;
  // Day change mirrors the server's guarded accumulation
  // (portfolioService.computeTotals): a holding enters BOTH sides of the ratio
  // or neither. `dayChangeEur` is null for every asset without a previous close
  // — i.e. every manual/off-market asset — so deriving the denominator from the
  // whole market value would count a house against a stock's day move and
  // understate the header percentage by orders of magnitude.
  let dayChangeEur = 0;
  let dayPrevValueEur = 0; // Σ (marketValue − dayChange) over assets with a known day move.
  for (const holding of holdings) {
    if (holding.dayChangeEur != null && holding.marketValueEur != null) {
      dayChangeEur += holding.dayChangeEur;
      dayPrevValueEur += holding.marketValueEur - holding.dayChangeEur;
    }
  }

  return portfolioResponseSchema.parse({
    baseCurrency: derived.baseCurrency,
    holdings,
    totals: {
      marketValueEur,
      investedEur,
      unrealizedPnlEur,
      unrealizedPnlPct: investedEur > 0 ? (unrealizedPnlEur / investedEur) * 100 : null,
      dayChangeEur,
      dayChangePct: dayPrevValueEur > 0 ? (dayChangeEur / dayPrevValueEur) * 100 : null,
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
