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

export interface PortfolioTransactionListParams {
  cursor?: string;
  limit?: number;
  source?: string;
}

/**
 * The single client-side read/write seam for portfolio data. Normal accounts
 * use {@link apiPortfolioStore}; paranoid accounts use the vault-backed
 * implementation without letting consumers select individual transports.
 */
export interface PortfolioStore {
  listPortfolios(signal?: AbortSignal, includeArchived?: boolean): Promise<PortfolioListResponse>;
  createPortfolio(name: CreatePortfolioRequest['name']): Promise<PortfolioSummary>;
  getPortfolio(portfolioId: string, signal?: AbortSignal): Promise<PortfolioResponse>;
  updatePortfolio(portfolioId: string, patch: UpdatePortfolioRequest): Promise<PortfolioSummary>;
  deletePortfolio(portfolioId: string): Promise<void>;
  listTransactions(
    portfolioId: string,
    params?: PortfolioTransactionListParams,
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
 * Compatibility implementation for normal accounts. Delegates resolve only
 * when an operation runs, so a portfolio surface never eagerly loads unrelated
 * API operations before an alternate store can be selected. The calls still
 * preserve the existing request shaping, schema parsing, aborts and typed API
 * errors from the client.
 */
export const apiPortfolioStore: PortfolioStore = {
  listPortfolios: (...args) => portfolioApi.listPortfolios(...args),
  createPortfolio: (...args) => portfolioApi.createPortfolio(...args),
  getPortfolio: (...args) => portfolioApi.getPortfolio(...args),
  updatePortfolio: (...args) => portfolioApi.updatePortfolio(...args),
  deletePortfolio: (...args) => portfolioApi.deletePortfolio(...args),
  listTransactions: (...args) => portfolioApi.listTransactions(...args),
  createTransactions: (...args) => portfolioApi.createTransactions(...args),
  updateTransaction: (...args) => portfolioApi.updateTransaction(...args),
  deleteTransaction: (...args) => portfolioApi.deleteTransaction(...args),
  depositCash: (...args) => portfolioApi.depositCash(...args),
  withdrawCash: (...args) => portfolioApi.withdrawCash(...args),
};
