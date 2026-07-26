import { describe, expect, it } from 'vitest';

import {
  paranoidDisableRehydrationRequestSchema,
  paranoidDisableRehydrationResultSchema,
  VAULT_DOCUMENT_VERSION,
  VAULT_ENTITY_KINDS,
  type VaultStrictEntity,
  vaultMediaStateSchema,
  vaultStrictDocumentV1Schema,
  vaultStrictEntitySchema,
} from './vault';

const uuid = (value: number) => `018f0000-0000-7000-8000-${value.toString(16).padStart(12, '0')}`;
const AT = '2026-07-24T10:00:00.000Z';
const USER_ID = uuid(1);
const PORTFOLIO_ID = uuid(2);
const ASSET_ID = uuid(3);
const CASH_SOURCE_ID = uuid(4);
const CATEGORY_ID = uuid(5);
const ORDER_ID = uuid(6);
const BUDGET_ID = uuid(7);
const ORIGINAL_EXPENSE_HASH = 'a'.repeat(64);

const meta = (id: string) => ({
  id,
  rev: 3,
  editedAt: AT,
  editedBy: uuid(99),
  deletedAt: null,
  mutationId: uuid(98),
  atomicMutationIds: [uuid(97)],
  atomicMutationTimestamps: { [uuid(97)]: AT },
});

/**
 * One fully populated persisted row per vault-classified table. Numeric values
 * stay decimal strings, timestamps stay ISO strings, and JSON columns stay
 * JSON: parsing never converts, defaults, hashes, or reconstructs a column.
 */
const fixtures: VaultStrictEntity[] = [
  {
    ...meta(PORTFOLIO_ID),
    kind: 'portfolio',
    data: {
      userId: USER_ID,
      name: 'Main',
      visibility: 'private',
      sortOrder: 2,
      defaultPayFromCash: true,
      archivedAt: '2026-07-25T10:00:00.000Z',
    },
  },
  {
    ...meta(uuid(10)),
    kind: 'transaction',
    data: {
      portfolioId: PORTFOLIO_ID,
      assetId: ASSET_ID,
      side: 'sell',
      quantity: '1.25000000',
      price: '123.456789',
      fee: '1.250000',
      executedAt: AT,
      note: 'frozen facts',
      taxMode: 'custom',
      taxCountry: 'DE',
      taxAmountEur: '-5.500000',
      taxParams: {
        ratePct: 27.5,
        lossOffset: true,
        refund: true,
        yearReset: true,
        carryForward: true,
        costBasis: 'fifo',
      },
      allowUncovered: true,
      uncoveredEntryPrice: '100.000000',
      source: 'import:ibkr',
    },
  },
  {
    ...meta(uuid(11)),
    kind: 'dividend',
    data: {
      portfolioId: PORTFOLIO_ID,
      assetId: ASSET_ID,
      cashSourceId: CASH_SOURCE_ID,
      grossAmountEur: '12.500000',
      executedAt: AT,
      note: 'quarterly',
      taxMode: 'country_specific',
      taxCountry: 'DE',
      taxAmountEur: '3.296875',
      taxParams: { source: 'frozen' },
      source: 'sync:broker',
      createdAt: '2026-07-23T09:00:00.000Z',
    },
  },
  {
    ...meta(CASH_SOURCE_ID),
    kind: 'cashSource',
    data: {
      portfolioId: PORTFOLIO_ID,
      name: 'Main',
      type: 'bank',
      isMain: true,
      archivedAt: '2026-07-25T10:00:00.000Z',
      createdAt: '2026-07-20T08:00:00.000Z',
    },
  },
  {
    ...meta(uuid(12)),
    kind: 'cashMovement',
    data: {
      portfolioId: PORTFOLIO_ID,
      sourceId: CASH_SOURCE_ID,
      kind: 'tax_refund',
      amountEur: '5.500000',
      transactionId: uuid(10),
      transferId: null,
      counterpartSourceId: null,
      dividendId: uuid(11),
      taxYear: 2026,
      executedAt: AT,
      note: 'settlement',
      source: 'manual',
      createdAt: '2026-07-22T08:00:00.000Z',
    },
  },
  {
    ...meta(uuid(13)),
    kind: 'portfolioSetting',
    data: {
      portfolioId: PORTFOLIO_ID,
      key: 'tax',
      value: { mode: 'custom', nested: [1, true, null] },
      updatedAt: AT,
    },
  },
  {
    ...meta(uuid(14)),
    kind: 'taxSetting',
    data: {
      userId: USER_ID,
      mode: 'manual_per_trade',
      country: null,
      manualDefaultAmountEur: '12.345678',
      manualDefaultRatePct: null,
      customParams: null,
      updatedAt: AT,
    },
  },
  {
    ...meta(ASSET_ID),
    kind: 'customAsset',
    data: {
      providerId: 'manual',
      providerRef: ASSET_ID,
      ownerId: USER_ID,
      type: 'custom',
      symbol: 'HOME',
      name: 'House',
      exchange: 'OFF-MARKET',
      currency: 'EUR',
      meta: {
        category: 'other',
        smoothing: true,
        recategorize: true,
        futureMetadata: { retained: true },
      },
      searchText: "'house':2 'home':1",
    },
  },
  {
    ...meta(uuid(15)),
    kind: 'customAssetValue',
    data: {
      assetId: ASSET_ID,
      date: '2026-07-24',
      close: '456789.1234567',
    },
  },
  {
    ...meta(ORDER_ID),
    kind: 'standingOrder',
    data: {
      userId: USER_ID,
      portfolioId: PORTFOLIO_ID,
      kind: 'buy-asset',
      assetId: ASSET_ID,
      amount: '0.12500000',
      currency: 'EUR',
      label: 'Monthly home slice',
      cadence: 'monthly',
      anchorDay: 31,
      startDate: '2026-01-31',
      endDate: '2026-12-31',
      status: 'paused',
      lastRunAt: AT,
      lastPeriodKey: '2026-07-24',
      createdAt: '2026-01-01T08:00:00.000Z',
      updatedAt: AT,
    },
  },
  {
    ...meta(uuid(16)),
    kind: 'standingOrderRun',
    data: {
      standingOrderId: ORDER_ID,
      periodKey: '2026-07-24',
      bookedAt: '2026-07-24T09:59:59.000Z',
    },
  },
  {
    ...meta(uuid(17)),
    kind: 'importBatch',
    data: {
      ownerId: USER_ID,
      portfolioId: PORTFOLIO_ID,
      brokerId: 'ibkr',
      filename: 'history.csv',
      status: 'applied',
      cashSourceId: CASH_SOURCE_ID,
      createdAt: '2026-07-20T08:00:00.000Z',
      appliedAt: AT,
    },
  },
  {
    ...meta(uuid(18)),
    kind: 'importRow',
    data: {
      batchId: uuid(17),
      rowIndex: 2,
      raw: '2026-07-24,BUY,HOME',
      kind: 'buy',
      flag: 'mapped',
      message: 'mapped exactly',
      executedAt: AT,
      isin: 'AT0000000001',
      symbol: 'HOME',
      name: 'House',
      quantity: '1.25000000',
      price: '123.456789',
      fee: '1.250000',
      amountEur: '154.320000',
      currency: 'EUR',
      note: 'import note',
      assetId: ASSET_ID,
      contentHash: 'b'.repeat(64),
      result: 'applied',
      resultMessage: 'booked',
    },
  },
  {
    ...meta(uuid(19)),
    kind: 'portfolioDailySnapshot',
    data: {
      portfolioId: PORTFOLIO_ID,
      date: '2026-07-24',
      valueEur: '10000.123456',
      costBasisEur: '9000.000000',
      plEur: '1000.123456',
      flowEur: '-25.000000',
      cashBySource: { [CASH_SOURCE_ID]: '500.000000' },
      assetValues: { [ASSET_ID]: '9500.123456' },
      computedAt: AT,
    },
  },
  {
    ...meta(uuid(20)),
    kind: 'portfolioSnapshotState',
    data: {
      portfolioId: PORTFOLIO_ID,
      computedThrough: '2026-07-24',
      dirtyFrom: '2026-07-01',
      updatedAt: AT,
    },
  },
  {
    ...meta(CATEGORY_ID),
    kind: 'expenseCategory',
    data: {
      userId: USER_ID,
      name: 'Groceries',
      direction: 'expense',
      color: '#22c55e',
      createdAt: AT,
      updatedAt: AT,
    },
  },
  {
    ...meta(uuid(21)),
    kind: 'expenseTransaction',
    data: {
      userId: USER_ID,
      categoryId: CATEGORY_ID,
      direction: 'income',
      amount: '12.50',
      currency: 'EUR',
      bookedOn: '2026-07-24',
      description: 'Edited merchant description',
      source: 'import:n26',
      dedupHash: ORIGINAL_EXPENSE_HASH,
      createdAt: AT,
      updatedAt: '2026-07-25T10:00:00.000Z',
    },
  },
  {
    ...meta(uuid(22)),
    kind: 'expenseRule',
    data: {
      userId: USER_ID,
      categoryId: CATEGORY_ID,
      matchType: 'regex',
      pattern: '^market',
      priority: 7,
      enabled: true,
      createdAt: AT,
      updatedAt: AT,
    },
  },
  {
    ...meta(BUDGET_ID),
    kind: 'expenseBudget',
    data: {
      userId: USER_ID,
      categoryId: CATEGORY_ID,
      amount: '350.25',
      currency: 'EUR',
      createdAt: AT,
      updatedAt: AT,
    },
  },
  {
    ...meta(uuid(23)),
    kind: 'expenseBudgetFire',
    data: {
      budgetId: BUDGET_ID,
      periodKey: '2026-07',
      firedAt: AT,
    },
  },
];

describe('strict vault document v1', () => {
  it('has a fully populated round-trip fixture for every enrolled entity kind', () => {
    expect(fixtures.map((fixture) => fixture.kind).sort()).toEqual([...VAULT_ENTITY_KINDS].sort());
  });

  for (const fixture of fixtures) {
    it(`round-trips every persisted ${fixture.kind} field byte-for-byte`, () => {
      const payload = JSON.stringify({
        schemaVersion: VAULT_DOCUMENT_VERSION,
        entities: [fixture],
        mergeLog: [],
      });
      const parsed = vaultStrictDocumentV1Schema.parse(JSON.parse(payload));
      expect(JSON.stringify(parsed)).toBe(payload);
    });
  }

  it('fails closed for a forward document version', () => {
    expect(
      vaultStrictDocumentV1Schema.safeParse({
        schemaVersion: VAULT_DOCUMENT_VERSION + 1,
        entities: fixtures,
        mergeLog: [],
      }).success,
    ).toBe(false);
  });

  it('requires every strict row field instead of defaulting or deriving one', () => {
    const expense = fixtures.find((fixture) => fixture.kind === 'expenseTransaction');
    if (expense?.kind !== 'expenseTransaction') throw new Error('expense fixture missing');
    const { dedupHash: _omitted, ...withoutDedupHash } = expense.data;
    expect(vaultStrictEntitySchema.safeParse({ ...expense, data: withoutDedupHash }).success).toBe(
      false,
    );
  });

  it('keeps assets.meta.recategorize and every sibling metadata field', () => {
    const asset = fixtures.find((fixture) => fixture.kind === 'customAsset');
    if (asset?.kind !== 'customAsset') throw new Error('asset fixture missing');
    const parsed = vaultStrictEntitySchema.parse(JSON.parse(JSON.stringify(asset)));
    expect(parsed.kind).toBe('customAsset');
    if (parsed.kind !== 'customAsset') throw new Error('asset parse changed kind');
    expect(parsed.data.meta).toEqual(asset.data.meta);
    expect(parsed.data.meta).toMatchObject({ recategorize: true });
  });

  it('keeps an imported-then-edited expense original dedup_hash verbatim', () => {
    const expense = fixtures.find((fixture) => fixture.kind === 'expenseTransaction');
    if (expense?.kind !== 'expenseTransaction') throw new Error('expense fixture missing');
    const parsed = vaultStrictEntitySchema.parse(JSON.parse(JSON.stringify(expense)));
    expect(parsed.kind).toBe('expenseTransaction');
    if (parsed.kind !== 'expenseTransaction') throw new Error('expense parse changed kind');
    expect(parsed.data.description).toBe('Edited merchant description');
    expect(parsed.data.direction).toBe('income');
    expect(parsed.data.dedupHash).toBe(ORIGINAL_EXPENSE_HASH);
  });

  it('binds the internal disable request to the strict graph, not the shipped client map', () => {
    const request = {
      rehydrationId: uuid(98),
      document: {
        schemaVersion: VAULT_DOCUMENT_VERSION,
        entities: fixtures,
        mergeLog: [],
      },
    };
    expect(paranoidDisableRehydrationRequestSchema.parse(request)).toEqual(request);
    expect(
      paranoidDisableRehydrationRequestSchema.safeParse({
        ...request,
        document: {
          schemaVersion: VAULT_DOCUMENT_VERSION,
          entities: { portfolio: [] },
          mergeLog: [],
        },
      }).success,
    ).toBe(false);
  });

  it('keeps the completion receipt non-sensitive and strict', () => {
    const result = {
      rehydrationId: uuid(98),
      completedAt: AT,
      idempotent: false,
      postCommit: {
        invalidate: ['account', 'portfolio', 'expenses', 'standingOrders', 'tax'] as const,
      },
    };
    expect(paranoidDisableRehydrationResultSchema.parse(result)).toEqual(result);
    expect(
      paranoidDisableRehydrationResultSchema.safeParse({ ...result, restoredRows: fixtures.length })
        .success,
    ).toBe(false);
  });
});

describe('vault media state', () => {
  it('rejects a Drive attestation unless Drive is selected', () => {
    expect(
      vaultMediaStateSchema.safeParse({
        mediaSet: ['server'],
        driveAttestedVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      vaultMediaStateSchema.safeParse({
        mediaSet: ['drive'],
        driveAttestedVersion: 1,
      }).success,
    ).toBe(true);
  });
});
