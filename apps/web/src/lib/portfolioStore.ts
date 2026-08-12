import type {
  CashEntryRequest,
  CashMovementsQuery,
  CashMovementsResponse,
  CashMovementResponse,
  CashPreviewRequest,
  CashPreviewResponse,
  CashSource,
  CashSourceListResponse,
  CashTransferRequest,
  CashTransferResponse,
  CreateCashSourceRequest,
  CreateCustomAssetRequest,
  CreateCustomAssetResponse,
  CreatePortfolioRequest,
  CustomAsset,
  CustomAssetListResponse,
  PortfolioHistoryRange,
  PortfolioHistoryResponse,
  PortfolioListResponse,
  PortfolioResponse,
  PortfolioSummary,
  PortfolioTaxSettingsResponse,
  SetCashBalanceRequest,
  SetCashBalanceResponse,
  StandingOrder,
  StandingOrderListResponse,
  Transaction,
  TransactionInput,
  TransactionListOrder,
  TransactionListResponse,
  UpdateCustomAssetRequest,
  UpdateCashSourceRequest,
  UpdatePortfolioRequest,
  UpdateTaxSettingsRequest,
  CreateStandingOrderRequest,
  UpdateStandingOrderRequest,
  UpdateTransactionRequest,
  ValuePoint,
  ValuePointsResponse,
} from '@bettertrack/contracts';

import * as portfolioApi from './portfolioApi';
import * as settingsApi from './settingsApi';
import * as standingOrdersApi from './standingOrdersApi';

export interface PortfolioTransactionListParams {
  cursor?: string;
  limit?: number;
  source?: string;
  assetId?: string;
  order?: TransactionListOrder;
  includeSourceTags?: boolean;
}

/**
 * The single client-side read/write seam for portfolio data. Normal accounts
 * use {@link apiPortfolioStore}; paranoid accounts receive an unlocked
 * vault-backed implementation from the user-app provider.
 */
export interface PortfolioStore {
  listPortfolios(signal?: AbortSignal, includeArchived?: boolean): Promise<PortfolioListResponse>;
  createPortfolio(
    name: CreatePortfolioRequest['name'],
    kind?: CreatePortfolioRequest['kind'],
  ): Promise<PortfolioSummary>;
  getPortfolio(portfolioId: string, signal?: AbortSignal): Promise<PortfolioResponse>;
  getPortfolioHistory(
    portfolioId: string,
    range: PortfolioHistoryRange,
    overlay?: boolean,
    signal?: AbortSignal,
  ): Promise<PortfolioHistoryResponse>;
  updatePortfolio(portfolioId: string, patch: UpdatePortfolioRequest): Promise<PortfolioSummary>;
  archivePortfolio(portfolioId: string): Promise<PortfolioSummary>;
  restorePortfolio(portfolioId: string): Promise<PortfolioSummary>;
  deletePortfolio(portfolioId: string): Promise<void>;
  getTaxSettings(signal?: AbortSignal): Promise<PortfolioTaxSettingsResponse['effective']>;
  updateTaxSettings(
    body: UpdateTaxSettingsRequest,
  ): Promise<PortfolioTaxSettingsResponse['effective']>;
  getPortfolioTaxSettings(
    portfolioId: string,
    signal?: AbortSignal,
  ): Promise<PortfolioTaxSettingsResponse>;
  setPortfolioTaxOverride(
    portfolioId: string,
    body: UpdateTaxSettingsRequest,
  ): Promise<PortfolioTaxSettingsResponse>;
  clearPortfolioTaxOverride(portfolioId: string): Promise<PortfolioTaxSettingsResponse>;
  listCustomAssets(signal?: AbortSignal): Promise<CustomAssetListResponse>;
  createCustomAsset(body: CreateCustomAssetRequest): Promise<CreateCustomAssetResponse>;
  updateCustomAsset(id: string, patch: UpdateCustomAssetRequest): Promise<CustomAsset>;
  getValuePoints(id: string, signal?: AbortSignal): Promise<ValuePointsResponse>;
  putValuePoints(id: string, points: ValuePoint[]): Promise<ValuePointsResponse>;
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
  listCashSources(
    portfolioId: string,
    includeArchived?: boolean,
    signal?: AbortSignal,
  ): Promise<CashSourceListResponse>;
  createCashSource(portfolioId: string, body: CreateCashSourceRequest): Promise<CashSource>;
  updateCashSource(
    portfolioId: string,
    sourceId: string,
    patch: UpdateCashSourceRequest,
  ): Promise<CashSource>;
  archiveCashSource(
    portfolioId: string,
    sourceId: string,
    options?: { baseSeq?: number },
  ): Promise<CashSource>;
  restoreCashSource(
    portfolioId: string,
    sourceId: string,
    options?: { baseSeq?: number },
  ): Promise<CashSource>;
  getCashMovements(
    portfolioId: string,
    params?: CashMovementsQuery,
    signal?: AbortSignal,
  ): Promise<CashMovementsResponse>;
  previewCash(
    portfolioId: string,
    body: CashPreviewRequest,
    signal?: AbortSignal,
  ): Promise<CashPreviewResponse>;
  depositCash(portfolioId: string, body: CashEntryRequest): Promise<CashMovementResponse>;
  withdrawCash(portfolioId: string, body: CashEntryRequest): Promise<CashMovementResponse>;
  /**
   * Record a standing custody/account fee (V5, §16 2026-07-30). At parity in
   * BOTH store implementations, so the fee surface cannot work in normal mode
   * and silently fail — or bypass the vault — in paranoid mode.
   */
  chargeCashFee(portfolioId: string, body: CashEntryRequest): Promise<CashMovementResponse>;
  transferCash(portfolioId: string, body: CashTransferRequest): Promise<CashTransferResponse>;
  setCashBalance(
    portfolioId: string,
    sourceId: string,
    body: SetCashBalanceRequest,
  ): Promise<SetCashBalanceResponse>;
  listStandingOrders(
    portfolioId?: string,
    signal?: AbortSignal,
  ): Promise<StandingOrderListResponse>;
  createStandingOrder(body: CreateStandingOrderRequest): Promise<StandingOrder>;
  updateStandingOrder(id: string, patch: UpdateStandingOrderRequest): Promise<StandingOrder>;
  pauseStandingOrder(id: string): Promise<StandingOrder>;
  resumeStandingOrder(id: string): Promise<StandingOrder>;
  deleteStandingOrder(id: string): Promise<void>;
}

/**
 * Normal-account compatibility wrapper. Delegates resolve only when an
 * operation runs, preserving the existing endpoint, request, response, abort,
 * and typed-error behavior.
 */
export const apiPortfolioStore: PortfolioStore = {
  listPortfolios: (...args) => portfolioApi.listPortfolios(...args),
  createPortfolio: (...args) => portfolioApi.createPortfolio(...args),
  getPortfolio: (...args) => portfolioApi.getPortfolio(...args),
  getPortfolioHistory: (...args) => portfolioApi.getPortfolioHistory(...args),
  updatePortfolio: (...args) => portfolioApi.updatePortfolio(...args),
  archivePortfolio: (...args) => portfolioApi.archivePortfolio(...args),
  restorePortfolio: (...args) => portfolioApi.restorePortfolio(...args),
  deletePortfolio: (...args) => portfolioApi.deletePortfolio(...args),
  getTaxSettings: (...args) => settingsApi.getTaxSettings(...args),
  updateTaxSettings: (...args) => settingsApi.updateTaxSettings(...args),
  getPortfolioTaxSettings: (...args) => portfolioApi.getPortfolioTaxSettings(...args),
  setPortfolioTaxOverride: (...args) => portfolioApi.setPortfolioTaxOverride(...args),
  clearPortfolioTaxOverride: (...args) => portfolioApi.clearPortfolioTaxOverride(...args),
  listCustomAssets: (...args) => portfolioApi.listCustomAssets(...args),
  createCustomAsset: (...args) => portfolioApi.createCustomAsset(...args),
  updateCustomAsset: (...args) => portfolioApi.updateCustomAsset(...args),
  getValuePoints: (...args) => portfolioApi.getValuePoints(...args),
  putValuePoints: async (...args) => ({ points: await portfolioApi.putValuePoints(...args) }),
  listTransactions: (...args) => portfolioApi.listTransactions(...args),
  createTransactions: (...args) => portfolioApi.createTransactions(...args),
  updateTransaction: (...args) => portfolioApi.updateTransaction(...args),
  deleteTransaction: (...args) => portfolioApi.deleteTransaction(...args),
  listCashSources: (...args) => portfolioApi.listCashSources(...args),
  createCashSource: (...args) => portfolioApi.createCashSource(...args),
  updateCashSource: (...args) => portfolioApi.updateCashSource(...args),
  archiveCashSource: (...args) => portfolioApi.archiveCashSource(...args),
  restoreCashSource: (...args) => portfolioApi.restoreCashSource(...args),
  getCashMovements: (...args) => portfolioApi.getCashMovements(...args),
  previewCash: (...args) => portfolioApi.previewCash(...args),
  depositCash: (...args) => portfolioApi.depositCash(...args),
  withdrawCash: (...args) => portfolioApi.withdrawCash(...args),
  chargeCashFee: (...args) => portfolioApi.chargeCashFee(...args),
  transferCash: (...args) => portfolioApi.transferCash(...args),
  setCashBalance: (...args) => portfolioApi.setCashBalance(...args),
  listStandingOrders: (...args) => standingOrdersApi.listStandingOrders(...args),
  createStandingOrder: (...args) => standingOrdersApi.createStandingOrder(...args),
  updateStandingOrder: (...args) => standingOrdersApi.updateStandingOrder(...args),
  pauseStandingOrder: (...args) => standingOrdersApi.pauseStandingOrder(...args),
  resumeStandingOrder: (...args) => standingOrdersApi.resumeStandingOrder(...args),
  deleteStandingOrder: (...args) => standingOrdersApi.deleteStandingOrder(...args),
};
