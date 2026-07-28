import type { PortfolioHistoryRange, TaxYearReportResponse } from '@bettertrack/contracts';
import type { Holding } from '@bettertrack/domain/holdings';
import type { SeriesStats } from '@bettertrack/domain/seriesStats';

import type { StandingOrderMaterializationResult } from '../standingOrders/materialize';
import type { VaultMoneyOutcome } from './errors';

export type ClientPortfolioRange = PortfolioHistoryRange;

export interface ClientCashSourceBalance {
  sourceId: string;
  name: string;
  balanceEur: number;
}

export interface ClientAllocationRow {
  assetId: string;
  valueEur: number;
  pct: number;
}

export interface ClientSeriesPoint {
  date: string;
  /** Null means at least one held asset lacked a usable close/FX rate. */
  valueEur: number | null;
  costBasisEur: number | null;
  pnlEur: number | null;
  twrPct: number | null;
  missingAssetIds: string[];
  freshness: 'fresh' | 'stale';
  isLiveToday: boolean;
}

export interface ClientPortfolioDerivation {
  ownerUserId: string;
  vaultKeyId: string;
  portfolioId: string;
  vaultVersion: number;
  writeId: string;
  assetPriceWatermark: string;
  range: ClientPortfolioRange;
  baseCurrency: 'EUR';
  holdings: Holding[];
  holdingsValueEur: number | null;
  cashBalanceEur: number;
  totalValueEur: number | null;
  allocation: ClientAllocationRow[] | null;
  cashSources: ClientCashSourceBalance[];
  series: ClientSeriesPoint[];
  stats: SeriesStats | null;
  freshness: 'fresh' | 'stale';
  missingAssetIds: string[];
}

export interface ClientTaxReport {
  ownerUserId: string;
  vaultKeyId: string;
  portfolioId: string;
  report: TaxYearReportResponse;
  computedTaxTargetEur: number;
  vaultVersion: number;
  writeId: string;
  assetPriceWatermark: string;
  freshness: 'fresh' | 'stale';
}

export interface VaultMoneyEngine {
  /** Required catch-up boundary for application bootstrap. Concurrent calls coalesce. */
  onAppOpen(): Promise<VaultMoneyOutcome<StandingOrderMaterializationResult>>;
  /** Required catch-up boundary after a fresh unlock. Its outcome gates later derivations. */
  afterUnlock(): Promise<VaultMoneyOutcome<StandingOrderMaterializationResult>>;
  derivePortfolio(
    portfolioId: string,
    range: ClientPortfolioRange,
    signal?: AbortSignal,
  ): Promise<VaultMoneyOutcome<ClientPortfolioDerivation>>;
  deriveTaxReport(
    portfolioId: string,
    year: number,
    signal?: AbortSignal,
  ): Promise<VaultMoneyOutcome<ClientTaxReport>>;
  clearCache(): void;
}
