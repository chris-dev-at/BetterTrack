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
vi.mock('../../../lib/cashApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/cashApi')>();
  return {
    ...actual,
    listCashTags: vi.fn(),
    listCashRules: vi.fn(),
    listAllCashBudgets: vi.fn(),
  };
});
vi.mock('../../../lib/standingOrdersApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/standingOrdersApi')>();
  return { ...actual, listStandingOrderRuns: vi.fn() };
});
vi.mock('../../../lib/userApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/userApi')>();
  return { ...actual, getParanoidNormalRevision: vi.fn() };
});

import { getAssetDetail } from '../../../lib/assetApi';
import { listAllCashBudgets, listCashRules, listCashTags } from '../../../lib/cashApi';
import {
  listExpenseBudgets,
  listExpenseCategories,
  listExpenseRules,
  listExpenseTransactions,
} from '../../../lib/expensesApi';
import { getTaxYearReport, getTaxYearReports, listDividends } from '../../../lib/portfolioApi';
import { apiPortfolioStore } from '../../../lib/portfolioStore';
import { listStandingOrderRuns } from '../../../lib/standingOrdersApi';
import { getParanoidNormalRevision } from '../../../lib/userApi';
import { openVaultSession } from '../engine/session';
import { toStrictRestoreDocument } from '../paranoidDisable';
import {
  buildNormalVaultDocument,
  captureNormalVault,
  CAPTURE_STABILITY_ATTEMPTS,
  VaultCaptureUnstableError,
} from './migration';

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
const RUN_ID = '018f0000-0000-7000-8000-000000000060';
const CLAIM_ID = '018f0000-0000-7000-8000-000000000061';
const REVISION = 'FAKE-normal-data-revision_0';

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
  vi.mocked(listCashTags).mockResolvedValue({ tags: [] });
  vi.mocked(listCashRules).mockResolvedValue({ rules: [] });
  vi.mocked(listAllCashBudgets).mockResolvedValue({ budgets: [] });
  vi.mocked(listStandingOrderRuns).mockResolvedValue({ runs: [] });
  vi.mocked(getParanoidNormalRevision).mockResolvedValue({ revision: REVISION });
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

  it('carries the cash-fusion tags, movement links, rules and budgets into the vault', async () => {
    // Regression for the one-way enable purge: every cash-fusion table is
    // `vault`-classified, so enable hard-deletes it server-side and disable
    // restores it from the document ALONE. A row this migration fails to capture
    // is lost for good on the round trip. The killer case is a month-SPECIFIC
    // budget for a month other than "now": the per-month progress list can never
    // surface it, so only the raw `/cash/budgets/all` read carries it.
    const SOURCE_ID = '018f0000-0000-7000-8000-0000000000c1';
    const MOVEMENT_ID = '018f0000-0000-7000-8000-0000000000c2';
    const USER_TAG_ID = '018f0000-0000-7000-8000-0000000000c3';
    const SYSTEM_TAG_ID = '018f0000-0000-7000-8000-0000000000c4';
    const RULE_ID = '018f0000-0000-7000-8000-0000000000c5';
    const RECURRING_BUDGET_ID = '018f0000-0000-7000-8000-0000000000c6';
    const MONTH_BUDGET_ID = '018f0000-0000-7000-8000-0000000000c7';

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
      getCashMovements: vi.fn(async () => ({
        balanceEur: 100,
        sources: [
          {
            id: SOURCE_ID,
            name: 'Main',
            type: 'cash' as const,
            isMain: true,
            archivedAt: null,
            balanceEur: 100,
            createdAt: NOW,
          },
        ],
        movements: [
          {
            id: MOVEMENT_ID,
            kind: 'deposit' as const,
            amountEur: 100,
            sourceId: SOURCE_ID,
            transactionId: null,
            transferId: null,
            counterpartSourceId: null,
            dividendId: null,
            taxYear: null,
            executedAt: '2026-07-15T09:00:00.000Z',
            note: 'Salary',
            source: 'manual' as const,
            createdAt: '2026-07-15T09:00:00.000Z',
            tags: [SYSTEM_TAG_ID, USER_TAG_ID],
          },
        ],
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

    vi.mocked(listCashTags).mockResolvedValue({
      tags: [
        {
          id: SYSTEM_TAG_ID,
          name: 'Deposits',
          color: '#123456',
          system: true,
          systemKey: 'deposit',
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: USER_TAG_ID,
          name: 'Salary',
          color: '#abcdef',
          system: false,
          systemKey: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    });
    vi.mocked(listCashRules).mockResolvedValue({
      rules: [
        {
          id: RULE_ID,
          tagIds: [USER_TAG_ID],
          matchType: 'contains' as const,
          pattern: 'salary',
          priority: 0,
          enabled: true,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    });
    vi.mocked(listAllCashBudgets).mockResolvedValue({
      budgets: [
        {
          id: RECURRING_BUDGET_ID,
          portfolioId: PORTFOLIO_ID,
          tagId: USER_TAG_ID,
          period: null,
          amount: 500,
          currency: 'EUR',
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: MONTH_BUDGET_ID,
          portfolioId: PORTFOLIO_ID,
          tagId: USER_TAG_ID,
          // A future month the current-month progress list could never surface.
          period: '2026-12',
          amount: 250,
          currency: 'EUR',
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    });

    let idSequence = 0;
    const document = await buildNormalVaultDocument({
      userId: USER_ID,
      deviceId: DEVICE_ID,
      store,
      now: () => NOW,
      id: () => `018f0000-0000-7000-8000-e${String(++idSequence).padStart(11, '0')}`,
    });

    expect(listAllCashBudgets).toHaveBeenCalledWith(undefined);
    expect((document.entities.cashTag ?? []).map((entity) => entity.id).sort()).toEqual(
      [SYSTEM_TAG_ID, USER_TAG_ID].sort(),
    );
    expect(
      document.entities.cashTag?.find((entity) => entity.id === USER_TAG_ID)?.data,
    ).toMatchObject({ userId: USER_ID, name: 'Salary', system: false, systemKey: null });
    // Both of the movement's tag links ride into the vault, keyed by
    // (movementId, tagId) under synthesized join ids.
    expect(
      (document.entities.cashMovementTag ?? [])
        .map((entity) => `${entity.data.movementId}:${entity.data.tagId}`)
        .sort(),
    ).toEqual([`${MOVEMENT_ID}:${SYSTEM_TAG_ID}`, `${MOVEMENT_ID}:${USER_TAG_ID}`].sort());
    expect(document.entities.cashRule).toHaveLength(1);
    expect(document.entities.cashRule?.[0]?.data).toMatchObject({
      userId: USER_ID,
      pattern: 'salary',
    });
    expect(document.entities.cashRuleTag?.map((entity) => entity.data.tagId)).toEqual([
      USER_TAG_ID,
    ]);
    // The recurring AND the month-specific budget both survive — the raw read is
    // the only path that carries the December row.
    expect(
      (document.entities.cashBudget ?? [])
        .map((entity) => `${entity.id}:${entity.data.periodKey}:${entity.data.amount}`)
        .sort(),
    ).toEqual([`${RECURRING_BUDGET_ID}:null:500`, `${MONTH_BUDGET_ID}:2026-12:250`].sort());
  });

  it('carries every run-ledger row, including a claim no watermark mentions', async () => {
    // The engine CLAIMS a period before it books and leaves the claim as an
    // un-retried tombstone when booking (or `markBooked`) fails afterwards — so
    // `standing_order_runs` legitimately holds rows the order's
    // `lastPeriodKey`/`lastRunAt` watermark says nothing about. Synthesizing
    // runs from the watermark dropped exactly those, and since enable purges the
    // table and disable restores it from this document alone, the scheduler
    // would re-book a period that was intentionally closed: a double booking of
    // real money.
    const store: PortfolioStore = {
      ...apiPortfolioStore,
      listPortfolios: vi.fn(async () => ({ portfolios: [] })),
      listCustomAssets: vi.fn(async () => ({ assets: [] })),
      getTaxSettings: vi.fn(async () => ({ mode: 'none' as const, country: null })),
      listStandingOrders: vi.fn(async () => ({
        orders: [
          {
            id: ORDER_ID,
            portfolioId: PORTFOLIO_ID,
            kind: 'cash-add' as const,
            assetId: null,
            assetSymbol: null,
            assetName: null,
            amount: 100,
            currency: 'EUR',
            label: 'Salary',
            cadence: 'monthly' as const,
            anchorDay: 1,
            startDate: '2026-05-01',
            endDate: null,
            status: 'active' as const,
            suspendedByArchive: false,
            // The watermark stopped at June: July was claimed, then its booking
            // failed. That claim exists ONLY in the ledger.
            lastRunAt: '2026-06-01T04:00:00.000Z',
            lastPeriodKey: '2026-06-01',
            nextRunDate: '2026-08-01',
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      })),
    };
    vi.mocked(listStandingOrderRuns).mockResolvedValue({
      runs: [
        {
          id: RUN_ID,
          standingOrderId: ORDER_ID,
          periodKey: '2026-06-01',
          bookedAt: '2026-06-01T04:00:00.000Z',
        },
        {
          id: CLAIM_ID,
          standingOrderId: ORDER_ID,
          periodKey: '2026-07-01',
          bookedAt: '2026-07-01T04:00:00.000Z',
        },
      ],
    });

    const document = await buildNormalVaultDocument({
      userId: USER_ID,
      deviceId: DEVICE_ID,
      store,
      now: () => NOW,
    });

    // Both rows ride, under their REAL ledger ids — the identity the restore
    // writes back and the client's occurrence lookup matches semantically.
    expect(
      (document.entities.standingOrderRun ?? []).map(
        (entity) => `${entity.id}:${entity.data.periodKey}`,
      ),
    ).toEqual([`${RUN_ID}:2026-06-01`, `${CLAIM_ID}:2026-07-01`]);
    // And the restore boundary ships them: the claim is what stops the
    // post-disable scheduler from re-booking July.
    const restore = toStrictRestoreDocument(document);
    expect(
      restore.entities
        .filter((entity) => entity.kind === 'standingOrderRun')
        .map((entity) => entity.data.periodKey),
    ).toEqual(['2026-06-01', '2026-07-01']);
  });

  it('refuses a booked watermark whose authoritative run row is missing', async () => {
    // The server checks this invariant only at DISABLE — by then the cleartext
    // rows are gone and a refusal traps the account in paranoid mode. So the
    // capture proves it while the normal account is still intact.
    const store: PortfolioStore = {
      ...apiPortfolioStore,
      listPortfolios: vi.fn(async () => ({ portfolios: [] })),
      listCustomAssets: vi.fn(async () => ({ assets: [] })),
      getTaxSettings: vi.fn(async () => ({ mode: 'none' as const, country: null })),
      listStandingOrders: vi.fn(async () => ({
        orders: [
          {
            id: ORDER_ID,
            portfolioId: PORTFOLIO_ID,
            kind: 'cash-add' as const,
            assetId: null,
            assetSymbol: null,
            assetName: null,
            amount: 100,
            currency: 'EUR',
            label: 'Salary',
            cadence: 'monthly' as const,
            anchorDay: 1,
            startDate: '2026-05-01',
            endDate: null,
            status: 'active' as const,
            suspendedByArchive: false,
            lastRunAt: '2026-06-01T04:00:00.000Z',
            lastPeriodKey: '2026-06-01',
            nextRunDate: '2026-08-01',
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      })),
    };
    vi.mocked(listStandingOrderRuns).mockResolvedValue({ runs: [] });

    await expect(
      buildNormalVaultDocument({ userId: USER_ID, deviceId: DEVICE_ID, store, now: () => NOW }),
    ).rejects.toThrow(/no run row for the booked period/);
  });

  it('refuses a run whose standing order the capture never saw', async () => {
    // The ledger read and the order read are two round trips; an order deleted
    // between them would leave a dangling claim that the server's restore
    // validation rejects — AFTER the irreversible purge. Refuse before enable.
    const store: PortfolioStore = {
      ...apiPortfolioStore,
      listPortfolios: vi.fn(async () => ({ portfolios: [] })),
      listCustomAssets: vi.fn(async () => ({ assets: [] })),
      getTaxSettings: vi.fn(async () => ({ mode: 'none' as const, country: null })),
      listStandingOrders: vi.fn(async () => ({ orders: [] })),
    };
    vi.mocked(listStandingOrderRuns).mockResolvedValue({
      runs: [
        {
          id: CLAIM_ID,
          standingOrderId: ORDER_ID,
          periodKey: '2026-07-01',
          bookedAt: '2026-07-01T04:00:00.000Z',
        },
      ],
    });

    await expect(
      buildNormalVaultDocument({ userId: USER_ID, deviceId: DEVICE_ID, store, now: () => NOW }),
    ).rejects.toThrow(/run for unknown order/);
  });

  it('brackets the row reads with the CAS revision and binds the agreed token to the capture', async () => {
    // The window this closes: the wizard reads the whole account, encrypts it,
    // writes both media and verifies them — all lock-free — and only then
    // commits the purge. Reading the revision before the first row read AND
    // again after the last makes the server's compare-and-swap cover the entire
    // capture, so a write that lands mid-read (another session, the
    // standing-order worker, or — see below — the capture's own GETs) refuses
    // the enable instead of being purged out of existence.
    const order: string[] = [];
    vi.mocked(getParanoidNormalRevision).mockImplementation(async () => {
      order.push('revision');
      return { revision: REVISION };
    });
    const store: PortfolioStore = {
      ...apiPortfolioStore,
      listPortfolios: vi.fn(async () => {
        order.push('portfolios');
        return { portfolios: [] };
      }),
      listCustomAssets: vi.fn(async () => ({ assets: [] })),
      getTaxSettings: vi.fn(async () => ({ mode: 'none' as const, country: null })),
      listStandingOrders: vi.fn(async () => ({ orders: [] })),
    };

    const capture = await captureNormalVault({
      userId: USER_ID,
      deviceId: DEVICE_ID,
      store,
      now: () => NOW,
    });

    // A quiet account settles on the first pass: one build, bracketed.
    expect(order).toEqual(['revision', 'portfolios', 'revision']);
    expect(capture.normalDataRevision).toBe(REVISION);
    expect(capture.document.schemaVersion).toBe(1);
  });

  it('re-captures when its own reads wrote, and ships the rows those writes created', async () => {
    /*
     * The defect this pins. The capture's reads are NOT side-effect-free:
     * `GET …/reports/tax-years` runs the #635 self-heal and INSERTS the open
     * year's correction cash movement, while `store.getCashMovements` sits in
     * the same `Promise.all` and has already snapshotted the ledger without it.
     * `GET /expenses/categories` likewise seeds this account's default
     * categories on first read. A single-pass capture therefore shipped a
     * document MISSING money rows — and enable hard-deletes them, with disable
     * restoring from the document alone.
     *
     * The fake reproduces that ordering exactly: the ledger snapshot happens
     * first, then the tax read appends the correction and moves the revision.
     * The assertion that matters is not "the capture succeeded" — it is that the
     * ACCEPTED document contains the correction. A fix that merely re-read the
     * token after the build would pass a 200-only assertion while still losing
     * the row.
     */
    const SOURCE_ID = '018f0000-0000-7000-8000-0000000000f1';
    const DEPOSIT_ID = '018f0000-0000-7000-8000-0000000000f2';
    const CORRECTION_ID = '018f0000-0000-7000-8000-0000000000f3';
    const CATEGORY_ID = '018f0000-0000-7000-8000-0000000000f4';

    const movement = (id: string, kind: 'deposit' | 'tax_refund', amountEur: number) => ({
      id,
      kind,
      amountEur,
      sourceId: SOURCE_ID,
      transactionId: null,
      transferId: null,
      counterpartSourceId: null,
      dividendId: null,
      taxYear: kind === 'deposit' ? null : 2026,
      executedAt: '2026-07-01T09:00:00.000Z',
      note: null,
      source: 'manual' as const,
      createdAt: '2026-07-01T09:00:00.000Z',
      tags: [],
    });

    // The server's state, as the capture's own reads leave it.
    let version = 0;
    const ledger = [movement(DEPOSIT_ID, 'deposit', 100)];
    const categories: Array<{
      id: string;
      name: string;
      direction: 'expense';
      color: string;
      createdAt: string;
      updatedAt: string;
    }> = [];

    vi.mocked(getParanoidNormalRevision).mockImplementation(async () => ({
      revision: `${REVISION}-${version}`,
    }));
    vi.mocked(getTaxYearReports).mockImplementation(async () => {
      // `reconcileOpenYears`: posts the pending correction once, then converges
      // (the year's correction delta is zero afterwards).
      if (!ledger.some((row) => row.id === CORRECTION_ID)) {
        ledger.push(movement(CORRECTION_ID, 'tax_refund', 247.5));
        version += 1;
      }
      return { years: [] };
    });
    vi.mocked(listExpenseCategories).mockImplementation(async () => {
      // The lazy default seed: one-shot, and self-covering — the read that
      // seeds also returns what it seeded.
      if (categories.length === 0) {
        categories.push({
          id: CATEGORY_ID,
          name: 'Groceries',
          direction: 'expense',
          color: '#445566',
          createdAt: NOW,
          updatedAt: NOW,
        });
        version += 1;
      }
      return { categories: [...categories] };
    });

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
      // Snapshots the ledger at call time — before the tax read appends to it,
      // which is the whole point.
      getCashMovements: vi.fn(async () => ({
        balanceEur: 100,
        sources: [
          {
            id: SOURCE_ID,
            name: 'Main',
            type: 'cash' as const,
            isMain: true,
            archivedAt: null,
            balanceEur: 100,
            createdAt: NOW,
          },
        ],
        movements: [...ledger],
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
    const capture = await captureNormalVault({
      userId: USER_ID,
      deviceId: DEVICE_ID,
      store,
      now: () => NOW,
      id: () => `018f0000-0000-7000-8000-f${String(++idSequence).padStart(11, '0')}`,
    });

    // Completeness first, because it is the assertion a green enable cannot
    // make: the correction the capture's own tax read posted rides in the
    // shipped document.
    expect(
      (capture.document.entities.cashMovement ?? []).map((entity) => entity.id).sort(),
    ).toEqual([CORRECTION_ID, DEPOSIT_ID].sort());
    expect(
      (capture.document.entities.cashMovement ?? []).find((e) => e.id === CORRECTION_ID)?.data,
    ).toMatchObject({ kind: 'tax_refund', amountEur: '247.5', taxYear: 2026 });
    expect((capture.document.entities.expenseCategory ?? []).map((entity) => entity.id)).toEqual([
      CATEGORY_ID,
    ]);
    // The token handed to the commit is the settled one, and it is the one the
    // accepted document was built under — not the pre-seed token.
    expect(capture.normalDataRevision).toBe(`${REVISION}-2`);
    // Exactly two passes: the second reads state its own first pass settled.
    expect(vi.mocked(getTaxYearReports)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(getParanoidNormalRevision)).toHaveBeenCalledTimes(3);
  });

  it('refuses to hand over a document when the account never settles', async () => {
    // An account something else keeps writing to. The capture must not ship the
    // stale document with the newer token (the CAS would pass over rows the
    // document never carried) nor the newer document with the older token (the
    // server refuses, after the user redid the whole encrypt/write/verify pass).
    // It gives up, with its own error type so the wizard can name the cause.
    let version = 0;
    vi.mocked(getParanoidNormalRevision).mockImplementation(async () => ({
      revision: `${REVISION}-${version++}`,
    }));
    const store: PortfolioStore = {
      ...apiPortfolioStore,
      listPortfolios: vi.fn(async () => ({ portfolios: [] })),
      listCustomAssets: vi.fn(async () => ({ assets: [] })),
      getTaxSettings: vi.fn(async () => ({ mode: 'none' as const, country: null })),
      listStandingOrders: vi.fn(async () => ({ orders: [] })),
    };

    await expect(
      captureNormalVault({ userId: USER_ID, deviceId: DEVICE_ID, store, now: () => NOW }),
    ).rejects.toBeInstanceOf(VaultCaptureUnstableError);
    // Bounded: it does not spin forever against a busy account.
    expect(vi.mocked(getParanoidNormalRevision)).toHaveBeenCalledTimes(
      CAPTURE_STABILITY_ATTEMPTS + 1,
    );
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
            suspendedByArchive: false,
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
            suspendedByArchive: false,
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
