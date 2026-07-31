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
vi.mock('../../../lib/assetApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/assetApi')>();
  return { ...actual, getAssetDetail: vi.fn() };
});

import { getAssetDetail } from '../../../lib/assetApi';
import {
  listExpenseBudgets,
  listExpenseCategories,
  listExpenseRules,
  listExpenseTransactions,
} from '../../../lib/expensesApi';
import { getTaxYearReport, getTaxYearReports, listDividends } from '../../../lib/portfolioApi';
import { apiPortfolioStore } from '../../../lib/portfolioStore';
import { openVaultSession } from '../engine/session';
import { toStrictRestoreDocument } from '../paranoidDisable';
import { buildNormalVaultDocument } from './migration';

const USER_ID = '018f0000-0000-7000-8000-000000000001';
const PORTFOLIO_ID = '018f0000-0000-7000-8000-000000000010';
const TRANSACTION_ID = '018f0000-0000-7000-8000-000000000020';
const ASSET_ID = '018f0000-0000-7000-8000-000000000030';
const CUSTOM_ASSET_ID = '018f0000-0000-7000-8000-000000000031';
const DEVICE_ID = '018f0000-0000-7000-8000-0000000000d1';
const NEXT_CURSOR = '018f0000-0000-7000-8000-000000000040';
const ORDER_ID = '018f0000-0000-7000-8000-000000000050';
const ORDER_ASSET_ID = '018f0000-0000-7000-8000-000000000051';
const NOW = '2026-07-30T10:00:00.000Z';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAssetDetail).mockRejectedValue(new Error('No asset detail was requested.'));
  vi.mocked(listDividends).mockResolvedValue({ dividends: [] });
  vi.mocked(getTaxYearReports).mockResolvedValue({ years: [] });
  vi.mocked(getTaxYearReport).mockRejectedValue(new Error('No tax year was requested.'));
  vi.mocked(listExpenseCategories).mockResolvedValue({ categories: [] });
  vi.mocked(listExpenseTransactions).mockResolvedValue({ transactions: [] });
  vi.mocked(listExpenseRules).mockResolvedValue({ rules: [] });
  vi.mocked(listExpenseBudgets).mockResolvedValue({ budgets: [], period: '2026-07' });
});

const ASSET = {
  id: ASSET_ID,
  symbol: 'ACME',
  name: 'Acme',
  exchange: 'XETRA',
  currency: 'EUR',
  type: 'stock' as const,
  isCustom: false,
  category: null,
};

function taxYear(year: number) {
  return {
    year,
    realizedPnlEur: 100,
    dividendsGrossEur: 0,
    taxWithheldEur: 27.5,
    taxRefundedEur: 0,
    taxNetEur: 27.5,
  };
}

/** One portfolio holding a single 2024 sell, under the given CURRENT tax settings. */
function storeWithSell(current: {
  mode: 'country_specific';
  country: 'AT' | 'DE';
}): PortfolioStore {
  return {
    ...apiPortfolioStore,
    listPortfolios: vi.fn(async () => ({
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
    })),
    listTransactions: vi.fn(async () => ({
      items: [
        {
          id: TRANSACTION_ID,
          assetId: ASSET_ID,
          side: 'sell' as const,
          quantity: 1,
          price: 200,
          fee: 0,
          executedAt: '2024-05-02T09:00:00.000Z',
          note: null,
          allowUncovered: false,
          uncoveredEntryPrice: null,
          source: 'manual',
          asset: ASSET,
        },
      ],
      nextCursor: null,
    })),
    getCashMovements: vi.fn(async () => ({ balanceEur: 0, movements: [], sources: [] })),
    getPortfolioTaxSettings: vi.fn(async () => ({
      effective: current,
      override: current,
      userDefault: current,
      source: 'portfolio' as const,
    })),
    getTaxSettings: vi.fn(async () => current),
    listCustomAssets: vi.fn(async () => ({ assets: [] })),
    listStandingOrders: vi.fn(async () => ({ orders: [] })),
  };
}

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
        // The local asset table: a market asset is snapshotted for the client
        // engine only, keyed by the same global id the server keeps.
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

  it('emits a restorable custom-asset identity and keeps market snapshots client-only', async () => {
    // The three facts `paranoidRehydrationService.validateCustomAssetFacts`
    // demands of EVERY customAsset entity it receives: this account's owner id,
    // the `manual` provider, and a provider reference equal to the entity id
    // (what `customAssetRepository.create` writes server-side). Enable is
    // one-way, so a document that fails them can never be disabled again — only
    // discarded.
    const store: PortfolioStore = {
      ...apiPortfolioStore,
      listPortfolios: vi.fn(async () => ({
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
      })),
      listTransactions: vi.fn(async () => ({
        items: [
          {
            id: TRANSACTION_ID,
            assetId: ASSET_ID,
            side: 'buy' as const,
            quantity: 1,
            price: 100,
            fee: 0,
            executedAt: '2026-07-01T09:00:00.000Z',
            note: null,
            allowUncovered: false,
            uncoveredEntryPrice: null,
            source: 'manual',
            asset: ASSET,
          },
        ],
        nextCursor: null,
      })),
      getCashMovements: vi.fn(async () => ({ balanceEur: 0, movements: [], sources: [] })),
      getPortfolioTaxSettings: vi.fn(async () => ({
        effective: { mode: 'none' as const, country: null },
        override: null,
        userDefault: { mode: 'none' as const, country: null },
        source: 'system' as const,
      })),
      getTaxSettings: vi.fn(async () => ({ mode: 'none' as const, country: null })),
      listCustomAssets: vi.fn(async () => ({
        assets: [
          {
            id: CUSTOM_ASSET_ID,
            symbol: 'HOUSE',
            name: 'House',
            category: 'other' as const,
            currency: 'EUR',
            type: 'custom' as const,
            smoothing: false,
            needsRecategorization: false,
            latestValue: { date: '2026-07-01', value: 250_000 },
          },
        ],
      })),
      getValuePoints: vi.fn(async () => ({ points: [{ date: '2026-07-01', value: 250_000 }] })),
      listStandingOrders: vi.fn(async () => ({ orders: [] })),
    };

    const document = await buildNormalVaultDocument({
      userId: USER_ID,
      deviceId: DEVICE_ID,
      store,
      now: () => NOW,
    });

    // In the vault document both assets are present — the client engine
    // resolves every transaction through this bucket and cannot value a
    // holding whose asset it has no local snapshot of.
    expect((document.entities.customAsset ?? []).map((entity) => entity.id)).toEqual([
      ASSET_ID,
      CUSTOM_ASSET_ID,
    ]);
    expect(document.entities.customAsset?.[1]?.data).toMatchObject({
      providerId: 'manual',
      providerRef: CUSTOM_ASSET_ID,
      ownerId: USER_ID,
      meta: { category: 'other', smoothing: false },
    });

    // At the restore boundary only the owner's custom assets cross: the market
    // asset is a global row that survived the enable purge, and the server
    // re-resolves it (`resolveReferencedAssets`) instead of accepting a copy.
    const restore = toStrictRestoreDocument(document);
    const restoredAssets = restore.entities.filter((entity) => entity.kind === 'customAsset');
    expect(restoredAssets.map((entity) => entity.id)).toEqual([CUSTOM_ASSET_ID]);
    for (const asset of restoredAssets) {
      expect(asset.data.ownerId).toBe(USER_ID);
      expect(asset.data.providerId).toBe('manual');
      expect(asset.data.providerRef).toBe(asset.id);
    }
    // The market holding itself still travels; only its snapshot is dropped.
    expect(
      restore.entities.some(
        (entity) => entity.kind === 'transaction' && entity.data.assetId === ASSET_ID,
      ),
    ).toBe(true);
    expect(
      restore.entities.some(
        (entity) => entity.kind === 'customAssetValue' && entity.data.assetId === CUSTOM_ASSET_ID,
      ),
    ).toBe(true);
  });

  it('freezes each sell under the country it was RECORDED with, not the current settings', async () => {
    // The account settled 2024 under AT and later switched the portfolio to DE
    // (the V5-P4 migration). Enable is one-way and the server purges the
    // cleartext rows afterwards, so stamping today's DE on a 2024 AT sell would
    // be unrecoverable.
    const store = storeWithSell({ mode: 'country_specific', country: 'DE' });
    vi.mocked(getTaxYearReports).mockResolvedValue({ years: [taxYear(2024)] });
    vi.mocked(getTaxYearReport).mockResolvedValue({
      year: 2024,
      summary: taxYear(2024),
      positions: [
        {
          asset: ASSET,
          realizedPnlEur: 100,
          dividendsGrossEur: 0,
          taxEur: 27.5,
          sells: [
            {
              transactionId: TRANSACTION_ID,
              executedAt: '2024-05-02T09:00:00.000Z',
              quantity: 1,
              proceedsEur: 200,
              costBasisEur: 100,
              realizedPnlEur: 100,
              taxMode: 'country_specific',
              taxAmountEur: 27.5,
              taxCountry: 'AT',
              taxParams: null,
            },
          ],
          dividends: [],
        },
      ],
    });

    const document = await buildNormalVaultDocument({
      userId: USER_ID,
      deviceId: 'browser-a',
      store,
      now: () => NOW,
    });

    expect(document.entities.transaction?.[0]?.data).toMatchObject({
      taxMode: 'country_specific',
      taxCountry: 'AT',
      taxAmountEur: '27.5',
      taxParams: null,
    });
  });

  it('refuses the migration when a sell has no provable frozen tax facts', async () => {
    // The sell exists but no year report covers it: its recorded mode/country
    // cannot be read, and guessing them would corrupt the tax history for good.
    const store = storeWithSell({ mode: 'country_specific', country: 'AT' });
    vi.mocked(getTaxYearReports).mockResolvedValue({ years: [] });

    await expect(
      buildNormalVaultDocument({ userId: USER_ID, deviceId: 'browser-a', store, now: () => NOW }),
    ).rejects.toThrow(/cannot prove the frozen tax facts/);
  });

  it('snapshots the asset of a pending buy-asset order the account has never traded', async () => {
    // The round-7 defect class: the standing-order list DTO names an assetId
    // but carries no type/currency/exchange, and an order may reference an
    // asset with no transaction, dividend, or custom-asset row. Without a real
    // asset read the migrated document holds a dangling reference — and the
    // unlock validator answers VAULT_CORRUPT after the irreversible purge.
    const store: PortfolioStore = {
      ...apiPortfolioStore,
      listPortfolios: vi.fn(async () => ({
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
      })),
      listTransactions: vi.fn(async () => ({ items: [], nextCursor: null })),
      getCashMovements: vi.fn(async () => ({ balanceEur: 0, movements: [], sources: [] })),
      getPortfolioTaxSettings: vi.fn(async () => ({
        effective: { mode: 'none' as const, country: null },
        override: null,
        userDefault: { mode: 'none' as const, country: null },
        source: 'system' as const,
      })),
      getTaxSettings: vi.fn(async () => ({ mode: 'none' as const, country: null })),
      listCustomAssets: vi.fn(async () => ({ assets: [] })),
      listStandingOrders: vi.fn(async () => ({
        orders: [
          {
            id: ORDER_ID,
            portfolioId: PORTFOLIO_ID,
            kind: 'buy-asset' as const,
            assetId: ORDER_ASSET_ID,
            assetSymbol: 'NVDA',
            assetName: 'NVIDIA',
            amount: 2,
            currency: 'USD',
            label: null,
            cadence: 'monthly' as const,
            anchorDay: 1,
            startDate: '2026-08-01',
            endDate: null,
            status: 'active' as const,
            lastRunAt: null,
            lastPeriodKey: null,
            nextRunDate: '2026-08-01',
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      })),
    };
    vi.mocked(getAssetDetail).mockResolvedValue({
      asset: {
        id: ORDER_ASSET_ID,
        providerId: 'yahoo',
        providerRef: 'NVDA',
        symbol: 'NVDA',
        name: 'NVIDIA',
        exchange: 'NASDAQ',
        currency: 'USD',
        type: 'stock',
        isCustom: false,
      },
      quote: null,
      stale: true,
      asOf: null,
      baseCurrency: 'EUR',
    });

    const document = await buildNormalVaultDocument({
      userId: USER_ID,
      deviceId: DEVICE_ID,
      store,
      now: () => NOW,
    });

    expect(getAssetDetail).toHaveBeenCalledWith(ORDER_ASSET_ID, undefined);
    // The class, not the shape: the exact validator every unlock runs accepts
    // the document...
    const session = openVaultSession(document);
    expect(session.ownerUserId).toBe(USER_ID);
    // ...because the order's asset is snapshotted with its full catalog
    // identity, client-only.
    expect(
      document.entities.customAsset?.find((entity) => entity.id === ORDER_ASSET_ID)?.data,
    ).toMatchObject({
      providerId: 'yahoo',
      providerRef: 'NVDA',
      ownerId: null,
      type: 'stock',
      currency: 'USD',
      exchange: 'NASDAQ',
    });
    // And the real restore boundary strips the snapshot while the order itself
    // crosses — the server re-resolves the surviving global asset row.
    const restore = toStrictRestoreDocument(document);
    expect(
      restore.entities.some(
        (entity) => entity.kind === 'customAsset' && entity.id === ORDER_ASSET_ID,
      ),
    ).toBe(false);
    expect(
      restore.entities.some((entity) => entity.kind === 'standingOrder' && entity.id === ORDER_ID),
    ).toBe(true);
  });

  it('refuses the migration when a standing-order asset resolves as an unproven custom asset', async () => {
    const store: PortfolioStore = {
      ...apiPortfolioStore,
      listPortfolios: vi.fn(async () => ({ portfolios: [] })),
      getTaxSettings: vi.fn(async () => ({ mode: 'none' as const, country: null })),
      listCustomAssets: vi.fn(async () => ({ assets: [] })),
      listStandingOrders: vi.fn(async () => ({
        orders: [
          {
            id: ORDER_ID,
            portfolioId: PORTFOLIO_ID,
            kind: 'buy-asset' as const,
            assetId: ORDER_ASSET_ID,
            assetSymbol: 'HOUSE',
            assetName: 'House',
            amount: 1,
            currency: 'EUR',
            label: null,
            cadence: 'monthly' as const,
            anchorDay: 1,
            startDate: '2026-08-01',
            endDate: null,
            status: 'active' as const,
            lastRunAt: null,
            lastPeriodKey: null,
            nextRunDate: '2026-08-01',
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      })),
    };
    vi.mocked(getAssetDetail).mockResolvedValue({
      asset: {
        id: ORDER_ASSET_ID,
        providerId: 'manual',
        providerRef: ORDER_ASSET_ID,
        symbol: 'HOUSE',
        name: 'House',
        exchange: null,
        currency: 'EUR',
        type: 'custom',
        isCustom: true,
      },
      quote: null,
      stale: true,
      asOf: null,
      baseCurrency: 'EUR',
    });

    await expect(
      buildNormalVaultDocument({ userId: USER_ID, deviceId: DEVICE_ID, store, now: () => NOW }),
    ).rejects.toThrow(/cannot prove ownership/);
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
