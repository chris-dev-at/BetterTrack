import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './apiClient';
import * as portfolioApi from './portfolioApi';
import { apiPortfolioStore } from './portfolioStore';

const PORTFOLIO_ID = '018f0000-0000-7000-8000-000000000001';
const TRANSACTION_ID = '018f0000-0000-7000-8000-000000000002';
const ASSET_ID = '018f0000-0000-7000-8000-000000000003';
const SOURCE_ID = '018f0000-0000-7000-8000-000000000004';
const AT = '2026-07-25T10:00:00.000Z';

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
  executedAt: AT,
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

const movement = {
  id: TRANSACTION_ID,
  kind: 'deposit' as const,
  amountEur: 10,
  sourceId: SOURCE_ID,
  transactionId: null,
  transferId: null,
  counterpartSourceId: null,
  dividendId: null,
  taxYear: null,
  executedAt: AT,
  note: null,
  source: 'manual' as const,
  createdAt: AT,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('apiPortfolioStore compatibility', () => {
  it('keeps every normal-account operation behind a lazy shared-store delegate', () => {
    expect(apiPortfolioStore.listPortfolios).not.toBe(portfolioApi.listPortfolios);
    expect(apiPortfolioStore.createPortfolio).not.toBe(portfolioApi.createPortfolio);
    expect(apiPortfolioStore.getPortfolio).not.toBe(portfolioApi.getPortfolio);
    expect(apiPortfolioStore.updatePortfolio).not.toBe(portfolioApi.updatePortfolio);
    expect(apiPortfolioStore.deletePortfolio).not.toBe(portfolioApi.deletePortfolio);
    expect(apiPortfolioStore.listTransactions).not.toBe(portfolioApi.listTransactions);
    expect(apiPortfolioStore.createTransactions).not.toBe(portfolioApi.createTransactions);
    expect(apiPortfolioStore.updateTransaction).not.toBe(portfolioApi.updateTransaction);
    expect(apiPortfolioStore.deleteTransaction).not.toBe(portfolioApi.deleteTransaction);
    expect(apiPortfolioStore.depositCash).not.toBe(portfolioApi.depositCash);
    expect(apiPortfolioStore.withdrawCash).not.toBe(portfolioApi.withdrawCash);
  });

  it('produces the same requests and parsed results for representative operations', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    const txInput = {
      assetId: ASSET_ID,
      side: 'buy' as const,
      quantity: 1,
      price: 10,
      fee: 0,
      executedAt: AT,
    };

    await compareDirectAndWrapped(
      fetchMock,
      () => portfolioApi.listPortfolios(signal, true),
      () => apiPortfolioStore.listPortfolios(signal, true),
      { portfolios: [summary] },
    );
    await compareDirectAndWrapped(
      fetchMock,
      () => portfolioApi.getPortfolio(PORTFOLIO_ID, signal),
      () => apiPortfolioStore.getPortfolio(PORTFOLIO_ID, signal),
      {
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
      },
    );
    await compareDirectAndWrapped(
      fetchMock,
      () => portfolioApi.createPortfolio('Main'),
      () => apiPortfolioStore.createPortfolio('Main'),
      { portfolio: summary },
    );
    await compareDirectAndWrapped(
      fetchMock,
      () => portfolioApi.updatePortfolio(PORTFOLIO_ID, { name: 'Renamed' }),
      () => apiPortfolioStore.updatePortfolio(PORTFOLIO_ID, { name: 'Renamed' }),
      { portfolio: summary },
    );
    await compareDirectAndWrapped(
      fetchMock,
      () => portfolioApi.deletePortfolio(PORTFOLIO_ID),
      () => apiPortfolioStore.deletePortfolio(PORTFOLIO_ID),
      undefined,
      204,
    );
    await compareDirectAndWrapped(
      fetchMock,
      () => portfolioApi.listTransactions(PORTFOLIO_ID, { limit: 20, source: 'manual' }, signal),
      () =>
        apiPortfolioStore.listTransactions(PORTFOLIO_ID, { limit: 20, source: 'manual' }, signal),
      { items: [transaction], nextCursor: null },
    );
    await compareDirectAndWrapped(
      fetchMock,
      () => portfolioApi.createTransactions(PORTFOLIO_ID, [txInput]),
      () => apiPortfolioStore.createTransactions(PORTFOLIO_ID, [txInput]),
      { transactions: [transaction] },
    );
    await compareDirectAndWrapped(
      fetchMock,
      () => portfolioApi.updateTransaction(PORTFOLIO_ID, TRANSACTION_ID, { note: 'Edited' }),
      () => apiPortfolioStore.updateTransaction(PORTFOLIO_ID, TRANSACTION_ID, { note: 'Edited' }),
      { transaction },
    );
    await compareDirectAndWrapped(
      fetchMock,
      () =>
        portfolioApi.deleteTransaction(PORTFOLIO_ID, TRANSACTION_ID, {
          baseSeq: 7,
        }),
      () =>
        apiPortfolioStore.deleteTransaction(PORTFOLIO_ID, TRANSACTION_ID, {
          baseSeq: 7,
        }),
      undefined,
      204,
    );
    await compareDirectAndWrapped(
      fetchMock,
      () => portfolioApi.depositCash(PORTFOLIO_ID, { amountEur: 10, sourceId: SOURCE_ID }),
      () => apiPortfolioStore.depositCash(PORTFOLIO_ID, { amountEur: 10, sourceId: SOURCE_ID }),
      { movement, sourceBalanceEur: 10, balanceEur: 10 },
    );
  });

  it('preserves the existing typed API error without translation', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const payload = {
      error: {
        code: 'INSUFFICIENT_CASH',
        message: 'Insufficient cash.',
        details: { available: 2 },
      },
    };

    fetchMock.mockResolvedValueOnce(jsonResponse(payload, 409));
    const direct = await captureError(() =>
      portfolioApi.withdrawCash(PORTFOLIO_ID, { amountEur: 10, sourceId: SOURCE_ID }),
    );
    const directCall = fetchMock.mock.calls.at(-1);
    fetchMock.mockResolvedValueOnce(jsonResponse(payload, 409));
    const wrapped = await captureError(() =>
      apiPortfolioStore.withdrawCash(PORTFOLIO_ID, { amountEur: 10, sourceId: SOURCE_ID }),
    );
    const wrappedCall = fetchMock.mock.calls.at(-1);

    expect(wrappedCall).toEqual(directCall);
    expect(direct).toBeInstanceOf(ApiError);
    expect(wrapped).toBeInstanceOf(ApiError);
    expect(wrapped).toMatchObject({
      status: (direct as ApiError).status,
      code: (direct as ApiError).code,
      message: (direct as ApiError).message,
      details: (direct as ApiError).details,
    });
  });
});

async function compareDirectAndWrapped<T>(
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>,
  direct: () => Promise<T>,
  wrapped: () => Promise<T>,
  payload: unknown,
  status = 200,
): Promise<void> {
  fetchMock.mockResolvedValueOnce(jsonResponse(payload, status));
  const directResult = await direct();
  const directCall = fetchMock.mock.calls.at(-1);
  fetchMock.mockResolvedValueOnce(jsonResponse(payload, status));
  const wrappedResult = await wrapped();
  const wrappedCall = fetchMock.mock.calls.at(-1);

  expect(wrappedCall).toEqual(directCall);
  expect(wrappedResult).toEqual(directResult);
}

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(status === 204 ? null : JSON.stringify(payload), {
    status,
    headers: status === 204 ? undefined : { 'Content-Type': 'application/json' },
  });
}

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to reject.');
}
