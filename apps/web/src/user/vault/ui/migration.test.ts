import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PortfolioStore } from '../../../lib/portfolioStore';

vi.mock('../../../lib/portfolioApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/portfolioApi')>();
  return {
    ...actual,
    getTaxYearReport: vi.fn(),
    getTaxYearReports: vi.fn(),
    listDividends: vi.fn(),
  };
});
vi.mock('../../../lib/expensesApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/expensesApi')>();
  return {
    ...actual,
    listExpenseBudgets: vi.fn(),
    listExpenseCategories: vi.fn(),
    listExpenseRules: vi.fn(),
    listExpenseTransactions: vi.fn(),
  };
});

import {
  listExpenseBudgets,
  listExpenseCategories,
  listExpenseRules,
  listExpenseTransactions,
} from '../../../lib/expensesApi';
import { getTaxYearReport, getTaxYearReports, listDividends } from '../../../lib/portfolioApi';
import { apiPortfolioStore } from '../../../lib/portfolioStore';
import { buildNormalVaultDocument } from './migration';

const USER_ID = '018f0000-0000-7000-8000-000000000001';
const PORTFOLIO_ID = '018f0000-0000-7000-8000-000000000010';
const TRANSACTION_ID = '018f0000-0000-7000-8000-000000000020';
const ASSET_ID = '018f0000-0000-7000-8000-000000000030';
const NEXT_CURSOR = '018f0000-0000-7000-8000-000000000040';
const NOW = '2026-07-30T10:00:00.000Z';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listDividends).mockResolvedValue({ dividends: [] });
  vi.mocked(getTaxYearReports).mockResolvedValue({ years: [] });
  vi.mocked(getTaxYearReport).mockRejectedValue(new Error('No tax year was requested.'));
  vi.mocked(listExpenseCategories).mockResolvedValue({ categories: [] });
  vi.mocked(listExpenseTransactions).mockResolvedValue({ transactions: [] });
  vi.mocked(listExpenseRules).mockResolvedValue({ rules: [] });
  vi.mocked(listExpenseBudgets).mockResolvedValue({ budgets: [], period: '2026-07' });
});

describe('buildNormalVaultDocument', () => {
  it('collects the complete normal portfolio graph through the store before enable', async () => {
    const listPortfolios = vi.fn(async () => ({
      portfolios: [
        {
          id: PORTFOLIO_ID,
          name: 'Main',
          visibility: 'private' as const,
          sortOrder: 0,
          isDefault: true,
          defaultPayFromCash: false,
          archivedAt: null,
        },
      ],
    }));
    const listTransactions = vi
      .fn()
      .mockResolvedValueOnce({
        items: [
          {
            id: TRANSACTION_ID,
            assetId: ASSET_ID,
            side: 'buy',
            quantity: 1e-7,
            price: 123.45,
            fee: 0,
            executedAt: '2026-07-01T09:00:00.000Z',
            note: null,
            allowUncovered: false,
            uncoveredEntryPrice: null,
            source: 'manual',
            asset: {
              id: ASSET_ID,
              symbol: 'ACME',
              name: 'Acme',
              exchange: 'XETRA',
              currency: 'EUR',
              type: 'stock',
              isCustom: false,
              category: null,
            },
          },
        ],
        nextCursor: NEXT_CURSOR,
      })
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    const store: PortfolioStore = {
      ...apiPortfolioStore,
      listPortfolios,
      listTransactions,
      getCashMovements: vi.fn(async () => ({
        balanceEur: 0,
        movements: [],
        sources: [],
      })),
      getPortfolioTaxSettings: vi.fn(async () => ({
        effective: { mode: 'none' as const, country: null },
        override: null,
        userDefault: { mode: 'none' as const, country: null },
        source: 'system' as const,
      })),
      getTaxSettings: vi.fn(async () => ({ mode: 'none' as const, country: null })),
      listCustomAssets: vi.fn(async () => ({ assets: [] })),
      listStandingOrders: vi.fn(async () => ({ orders: [] })),
    };
    let idSequence = 0;

    const document = await buildNormalVaultDocument({
      userId: USER_ID,
      deviceId: 'browser-a',
      store,
      now: () => NOW,
      id: () => `018f0000-0000-7000-8000-${String(++idSequence).padStart(12, '0')}`,
    });

    expect(listPortfolios).toHaveBeenCalledWith(undefined, true);
    expect(listTransactions).toHaveBeenNthCalledWith(
      1,
      PORTFOLIO_ID,
      { cursor: undefined, limit: 200 },
      undefined,
    );
    expect(listTransactions).toHaveBeenNthCalledWith(
      2,
      PORTFOLIO_ID,
      { cursor: NEXT_CURSOR, limit: 200 },
      undefined,
    );
    expect(listDividends).toHaveBeenCalledWith(PORTFOLIO_ID, undefined, undefined);
    expect(getTaxYearReports).toHaveBeenCalledWith(PORTFOLIO_ID, undefined);
    expect(getTaxYearReport).not.toHaveBeenCalled();
    expect(listExpenseTransactions).toHaveBeenCalledWith({ limit: 500 }, undefined);

    expect(document).toMatchObject({
      schemaVersion: 1,
      mergeLog: [],
      entities: {
        portfolio: [
          {
            id: PORTFOLIO_ID,
            editedBy: 'browser-a',
            data: { userId: USER_ID, name: 'Main' },
          },
        ],
        transaction: [
          {
            id: TRANSACTION_ID,
            data: {
              portfolioId: PORTFOLIO_ID,
              assetId: ASSET_ID,
              quantity: '0.0000001',
              price: '123.45',
              source: 'manual',
            },
          },
        ],
        customAsset: [
          {
            id: ASSET_ID,
            data: {
              providerId: 'yahoo',
              providerRef: 'ACME',
              ownerId: null,
            },
          },
        ],
        taxSetting: [
          {
            data: {
              userId: USER_ID,
              mode: 'none',
              country: null,
            },
          },
        ],
      },
    });
  });

  it('re-reads a full expense page boundary so enable never silently truncates money rows', async () => {
    const expense = (index: number, bookedOn: string) => ({
      id: `018f0000-0000-7000-8001-${String(index).padStart(12, '0')}`,
      categoryId: null,
      direction: 'expense' as const,
      amount: index + 1,
      currency: 'EUR',
      bookedOn,
      description: `Expense ${index}`,
      source: 'manual',
      createdAt: `${bookedOn}T10:00:00.000Z`,
      updatedAt: `${bookedOn}T10:00:00.000Z`,
    });
    const newest = Array.from({ length: 400 }, (_, index) => expense(index + 1, '2026-07-30'));
    const boundary = Array.from({ length: 100 }, (_, index) => expense(index + 401, '2026-07-29'));
    const older = expense(501, '2026-07-28');
    vi.mocked(listExpenseTransactions)
      .mockResolvedValueOnce({ transactions: [...newest, ...boundary] })
      .mockResolvedValueOnce({ transactions: boundary })
      .mockResolvedValueOnce({ transactions: [older] });
    const store: PortfolioStore = {
      ...apiPortfolioStore,
      listPortfolios: vi.fn(async () => ({ portfolios: [] })),
      listCustomAssets: vi.fn(async () => ({ assets: [] })),
      getTaxSettings: vi.fn(async () => ({ mode: 'none' as const, country: null })),
      listStandingOrders: vi.fn(async () => ({ orders: [] })),
    };

    const document = await buildNormalVaultDocument({
      userId: USER_ID,
      deviceId: 'browser-a',
      store,
      now: () => NOW,
    });

    expect(listExpenseTransactions).toHaveBeenNthCalledWith(
      2,
      {
        from: '2026-07-29',
        to: '2026-07-29',
        limit: 500,
      },
      undefined,
    );
    expect(listExpenseTransactions).toHaveBeenNthCalledWith(
      3,
      { limit: 500, to: '2026-07-28' },
      undefined,
    );
    expect(document.entities.expenseTransaction).toHaveLength(501);
  });
});
