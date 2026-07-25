import type {
  CashEntryRequest,
  CashMovementResponse,
  CreatePortfolioRequest,
  PortfolioListResponse,
  PortfolioResponse,
  PortfolioSummary,
  Transaction,
  TransactionInput,
  TransactionListResponse,
  UpdatePortfolioRequest,
  UpdateTransactionRequest,
} from '@bettertrack/contracts';

import * as portfolioApi from './portfolioApi';

/**
 * The single client-side portfolio-data seam from paranoid design §11. The API
 * implementation intentionally preserves today's endpoint request/response
 * behavior while vaultPortfolioStore supplies the authenticated local variant.
 */
export interface PortfolioStore {
  listPortfolios(signal?: AbortSignal, includeArchived?: boolean): Promise<PortfolioListResponse>;
  createPortfolio(name: CreatePortfolioRequest['name']): Promise<PortfolioSummary>;
  getPortfolio(portfolioId: string, signal?: AbortSignal): Promise<PortfolioResponse>;
  updatePortfolio(portfolioId: string, patch: UpdatePortfolioRequest): Promise<PortfolioSummary>;
  deletePortfolio(portfolioId: string): Promise<void>;
  listTransactions(
    portfolioId: string,
    params?: { cursor?: string; limit?: number; source?: string },
    signal?: AbortSignal,
  ): Promise<TransactionListResponse>;
  createTransactions(portfolioId: string, inputs: TransactionInput[]): Promise<Transaction[]>;
  updateTransaction(
    portfolioId: string,
    transactionId: string,
    patch: UpdateTransactionRequest,
  ): Promise<Transaction>;
  deleteTransaction(
    portfolioId: string,
    transactionId: string,
    options?: { baseSeq?: number },
  ): Promise<void>;
  depositCash(portfolioId: string, body: CashEntryRequest): Promise<CashMovementResponse>;
  withdrawCash(portfolioId: string, body: CashEntryRequest): Promise<CashMovementResponse>;
}

/**
 * Compatibility wrapper for normal accounts. It is deliberately a direct
 * delegation layer: no request shaping, error translation, caching, or
 * fallback means current consumers retain exactly their API-backed behavior.
 */
export const apiPortfolioStore: PortfolioStore = {
  listPortfolios: portfolioApi.listPortfolios,
  createPortfolio: portfolioApi.createPortfolio,
  getPortfolio: portfolioApi.getPortfolio,
  updatePortfolio: portfolioApi.updatePortfolio,
  deletePortfolio: portfolioApi.deletePortfolio,
  listTransactions: portfolioApi.listTransactions,
  createTransactions: portfolioApi.createTransactions,
  updateTransaction: portfolioApi.updateTransaction,
  deleteTransaction: portfolioApi.deleteTransaction,
  depositCash: portfolioApi.depositCash,
  withdrawCash: portfolioApi.withdrawCash,
};
