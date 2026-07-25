import { describe, expect, it, vi } from 'vitest';

vi.mock('./portfolioApi', () => ({
  listPortfolios: vi.fn(),
  createPortfolio: vi.fn(),
  getPortfolio: vi.fn(),
  updatePortfolio: vi.fn(),
  deletePortfolio: vi.fn(),
  listTransactions: vi.fn(),
  createTransactions: vi.fn(),
  updateTransaction: vi.fn(),
  deleteTransaction: vi.fn(),
  depositCash: vi.fn(),
  withdrawCash: vi.fn(),
}));

import * as portfolioApi from './portfolioApi';
import { apiPortfolioStore } from './portfolioStore';

const PORTFOLIO_ID = '018f0000-0000-7000-8000-000000000001';
const TRANSACTION_ID = '018f0000-0000-7000-8000-000000000002';
const ASSET_ID = '018f0000-0000-7000-8000-000000000003';

const summary = {
  id: PORTFOLIO_ID,
  name: 'Main',
  visibility: 'private' as const,
  sortOrder: 0,
  isDefault: true,
  defaultPayFromCash: false,
  archivedAt: null,
};

const transaction = {
  id: TRANSACTION_ID,
  assetId: ASSET_ID,
  side: 'buy' as const,
  quantity: 1,
  price: 10,
  fee: 0,
  executedAt: '2026-07-25T10:00:00.000Z',
  note: null,
  allowUncovered: false,
  uncoveredEntryPrice: null,
  source: 'manual' as const,
  asset: {
    id: ASSET_ID,
    symbol: 'TEST',
    name: 'Test',
    type: 'stock' as const,
    currency: 'EUR',
    exchange: null,
    isCustom: false,
    category: null,
  },
};

describe('apiPortfolioStore', () => {
  it('delegates representative list/read/create/update/delete operations unchanged', async () => {
    vi.mocked(portfolioApi.listPortfolios).mockResolvedValue({ portfolios: [summary] });
    vi.mocked(portfolioApi.createPortfolio).mockResolvedValue(summary);
    vi.mocked(portfolioApi.getPortfolio).mockResolvedValue({
      baseCurrency: 'EUR',
      holdings: [],
      totals: {
        marketValueEur: 0,
        investedEur: 0,
        unrealizedPnlEur: 0,
        unrealizedPnlPct: null,
        dayChangeEur: 0,
        dayChangePct: null,
        cashEur: 0,
        totalValueEur: 0,
      },
    });
    vi.mocked(portfolioApi.updatePortfolio).mockResolvedValue(summary);
    vi.mocked(portfolioApi.deletePortfolio).mockResolvedValue(undefined);

    const signal = new AbortController().signal;
    await expect(apiPortfolioStore.listPortfolios(signal, true)).resolves.toEqual({
      portfolios: [summary],
    });
    await expect(apiPortfolioStore.createPortfolio('Main')).resolves.toEqual(summary);
    await apiPortfolioStore.getPortfolio(PORTFOLIO_ID, signal);
    await apiPortfolioStore.updatePortfolio(PORTFOLIO_ID, { name: 'Renamed' });
    await apiPortfolioStore.deletePortfolio(PORTFOLIO_ID);

    expect(portfolioApi.listPortfolios).toHaveBeenCalledWith(signal, true);
    expect(portfolioApi.createPortfolio).toHaveBeenCalledWith('Main');
    expect(portfolioApi.getPortfolio).toHaveBeenCalledWith(PORTFOLIO_ID, signal);
    expect(portfolioApi.updatePortfolio).toHaveBeenCalledWith(PORTFOLIO_ID, { name: 'Renamed' });
    expect(portfolioApi.deletePortfolio).toHaveBeenCalledWith(PORTFOLIO_ID);
  });

  it('preserves transaction and cash request shapes and errors', async () => {
    const error = new Error('API-backed failure');
    vi.mocked(portfolioApi.listTransactions).mockResolvedValue({
      items: [transaction],
      nextCursor: null,
    });
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([transaction]);
    vi.mocked(portfolioApi.updateTransaction).mockResolvedValue(transaction);
    vi.mocked(portfolioApi.deleteTransaction).mockRejectedValue(error);
    vi.mocked(portfolioApi.depositCash).mockResolvedValue({
      movement: {
        id: TRANSACTION_ID,
        kind: 'deposit',
        amountEur: 10,
        sourceId: PORTFOLIO_ID,
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: '2026-07-25T10:00:00.000Z',
        note: null,
        source: 'manual',
        createdAt: '2026-07-25T10:00:00.000Z',
      },
      sourceBalanceEur: 10,
      balanceEur: 10,
    });
    vi.mocked(portfolioApi.withdrawCash).mockRejectedValue(error);

    const txInput = {
      assetId: ASSET_ID,
      side: 'buy' as const,
      quantity: 1,
      price: 10,
      fee: 0,
      executedAt: '2026-07-25T10:00:00.000Z',
    };
    const cash = { amountEur: 10, sourceId: PORTFOLIO_ID, note: 'Savings' };
    await apiPortfolioStore.listTransactions(PORTFOLIO_ID, { limit: 20, source: 'manual' });
    await apiPortfolioStore.createTransactions(PORTFOLIO_ID, [txInput]);
    await apiPortfolioStore.updateTransaction(PORTFOLIO_ID, TRANSACTION_ID, { note: 'Edited' });
    await expect(
      apiPortfolioStore.deleteTransaction(PORTFOLIO_ID, TRANSACTION_ID, { baseSeq: 7 }),
    ).rejects.toBe(error);
    await apiPortfolioStore.depositCash(PORTFOLIO_ID, cash);
    await expect(apiPortfolioStore.withdrawCash(PORTFOLIO_ID, cash)).rejects.toBe(error);

    expect(portfolioApi.listTransactions).toHaveBeenCalledWith(PORTFOLIO_ID, {
      limit: 20,
      source: 'manual',
    });
    expect(portfolioApi.createTransactions).toHaveBeenCalledWith(PORTFOLIO_ID, [txInput]);
    expect(portfolioApi.updateTransaction).toHaveBeenCalledWith(PORTFOLIO_ID, TRANSACTION_ID, {
      note: 'Edited',
    });
    expect(portfolioApi.deleteTransaction).toHaveBeenCalledWith(PORTFOLIO_ID, TRANSACTION_ID, {
      baseSeq: 7,
    });
    expect(portfolioApi.depositCash).toHaveBeenCalledWith(PORTFOLIO_ID, cash);
    expect(portfolioApi.withdrawCash).toHaveBeenCalledWith(PORTFOLIO_ID, cash);
  });
});
