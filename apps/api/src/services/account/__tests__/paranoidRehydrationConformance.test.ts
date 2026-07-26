import {
  CASH_SOURCE_TYPES,
  EXPENSE_DIRECTIONS,
  EXPENSE_RULE_MATCH_TYPES,
  IMPORT_BATCH_STATUSES,
  IMPORT_ROW_FLAGS,
  IMPORT_ROW_KINDS,
  IMPORT_ROW_RESULTS,
  paranoidDisableRehydrationRequestSchema,
  STANDING_ORDER_CADENCES,
  STANDING_ORDER_KINDS,
  STANDING_ORDER_STATUSES,
  VAULT_ENTITY_KINDS,
  VAULT_ENTITY_SCHEMAS,
  type ParanoidDisableRehydrationRequest,
} from '@bettertrack/contracts';
import { CASH_MOVEMENT_KINDS } from '@bettertrack/domain/cashLedger';
import { reducePosition } from '@bettertrack/domain/holdings';
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../../../data/db';
import { newId } from '../../../data/ids';
import { createAssetRepository } from '../../../data/repositories/assetRepository';
import { createExpenseTransactionRepository } from '../../../data/repositories/expenseRepository';
import {
  createImportRepository,
  type StageImportRowInput,
} from '../../../data/repositories/importRepository';
import { createPortfolioSnapshotRepository } from '../../../data/repositories/portfolioSnapshotRepository';
import {
  assets,
  dividends,
  expenseBudgetFires,
  expenseBudgets,
  expenseCategories,
  expenseRules,
  expenseTransactions,
  importBatches,
  importRows,
  paranoidRehydrationReceipts,
  paranoidVaults,
  portfolioCashMovements,
  portfolioCashSources,
  portfolioDailySnapshots,
  portfolioSettings,
  portfolioSnapshotState,
  portfolios,
  priceHistory,
  standingOrderRuns,
  standingOrders,
  transactions,
  userTaxSettings,
  users,
} from '../../../data/schema';
import {
  createTestApp,
  type CreateTestAppOptions,
  type TestHarness,
} from '../../../testing/createTestApp';
import { PARANOID_REHYDRATION_HANDLERS } from '../../export/manifest';
import {
  createParanoidRehydrationService,
  type ParanoidRehydrationStage,
} from '../paranoidRehydrationService';

type StrictDocument = ParanoidDisableRehydrationRequest['document'];
type StrictEntity = StrictDocument['entities'][number];
type StrictKind = StrictEntity['kind'];
type StrictData<K extends StrictKind> = Extract<StrictEntity, { kind: K }>['data'];
type PersistedRow = Record<string, unknown>;

const DEVICE_ID = '018f0000-0000-7000-8000-000000000001';
const EDITED_AT = '2026-07-24T12:00:00.000Z';
const TEST_NOW = Date.parse(EDITED_AT);

interface FieldValue {
  field: string;
  value: unknown;
}

interface ArrangedReachableState {
  userId: string;
  focus(document: StrictDocument): readonly FieldValue[];
  /** Exercise validateGraph/preflight only when a later restore subsystem owns a separate boundary. */
  preflightOnly?: boolean;
}

interface ReachableStateCase {
  name: string;
  options?: CreateTestAppOptions;
  arrange(harness: TestHarness): Promise<ArrangedReachableState>;
}

function jsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonValue(item)]),
    );
  }
  return value;
}

function valueAtPath(value: unknown, path: readonly PropertyKey[]): unknown {
  let current = value;
  for (const part of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<PropertyKey, unknown>)[part];
  }
  return current;
}

function displayValue(value: unknown): string {
  const encoded = JSON.stringify(jsonValue(value));
  return encoded ?? String(value);
}

/**
 * Serialize the database row through the strict v1 schema. A persisted shape
 * that the vault union cannot represent fails with its exact path and value.
 */
function strictEntity<K extends StrictKind>(
  kind: K,
  row: PersistedRow,
): Extract<StrictEntity, { kind: K }> {
  const { id: persistedId, ...persistedData } = row;
  const candidate = {
    id: typeof persistedId === 'string' ? persistedId : newId(),
    kind,
    rev: 0,
    editedAt: EDITED_AT,
    editedBy: DEVICE_ID,
    deletedAt: null,
    data: jsonValue(persistedData),
  };
  const parsed = VAULT_ENTITY_SCHEMAS[kind].safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path ?? [];
    throw new Error(
      `persisted ${kind}.${path.join('.')}=${displayValue(
        valueAtPath(candidate, path),
      )} is absent from strict v1: ${issue?.message ?? parsed.error.message}`,
    );
  }
  return parsed.data as Extract<StrictEntity, { kind: K }>;
}

async function whenIds<T>(
  ids: readonly string[],
  select: (ids: string[]) => Promise<T[]>,
): Promise<T[]> {
  return ids.length === 0 ? [] : select([...ids]);
}

function persistedRows<T>(rows: readonly T[]): readonly PersistedRow[] {
  return rows as unknown as readonly PersistedRow[];
}

/**
 * Every persisted field owned by a normal writer. The full-graph enrollment
 * below compares these lists with every captured row, so a new column inside an
 * existing kind fails this suite until its normal finite state is deliberately
 * enrolled; the mapped type separately makes a new kind a compile failure.
 */
const NORMAL_WRITE_FIELDS = {
  portfolio: ['userId', 'name', 'visibility', 'sortOrder', 'defaultPayFromCash', 'archivedAt'],
  transaction: [
    'portfolioId',
    'assetId',
    'side',
    'quantity',
    'price',
    'fee',
    'executedAt',
    'note',
    'taxMode',
    'taxCountry',
    'taxAmountEur',
    'taxParams',
    'allowUncovered',
    'uncoveredEntryPrice',
    'source',
  ],
  dividend: [
    'portfolioId',
    'assetId',
    'cashSourceId',
    'grossAmountEur',
    'executedAt',
    'note',
    'taxMode',
    'taxCountry',
    'taxAmountEur',
    'taxParams',
    'source',
    'createdAt',
  ],
  cashSource: ['portfolioId', 'name', 'type', 'isMain', 'archivedAt', 'createdAt'],
  cashMovement: [
    'portfolioId',
    'sourceId',
    'kind',
    'amountEur',
    'transactionId',
    'transferId',
    'counterpartSourceId',
    'dividendId',
    'taxYear',
    'executedAt',
    'note',
    'source',
    'createdAt',
  ],
  portfolioSetting: ['portfolioId', 'key', 'value', 'updatedAt'],
  taxSetting: [
    'userId',
    'mode',
    'country',
    'manualDefaultAmountEur',
    'manualDefaultRatePct',
    'customParams',
    'updatedAt',
  ],
  customAsset: [
    'providerId',
    'providerRef',
    'ownerId',
    'type',
    'symbol',
    'name',
    'exchange',
    'currency',
    'meta',
    'searchText',
  ],
  customAssetValue: ['assetId', 'date', 'close'],
  standingOrder: [
    'userId',
    'portfolioId',
    'kind',
    'assetId',
    'amount',
    'currency',
    'label',
    'cadence',
    'anchorDay',
    'startDate',
    'endDate',
    'status',
    'lastRunAt',
    'lastPeriodKey',
    'createdAt',
    'updatedAt',
  ],
  standingOrderRun: ['standingOrderId', 'periodKey', 'bookedAt'],
  importBatch: [
    'ownerId',
    'portfolioId',
    'brokerId',
    'filename',
    'status',
    'cashSourceId',
    'createdAt',
    'appliedAt',
  ],
  importRow: [
    'batchId',
    'rowIndex',
    'raw',
    'kind',
    'flag',
    'message',
    'executedAt',
    'isin',
    'symbol',
    'name',
    'quantity',
    'price',
    'fee',
    'amountEur',
    'currency',
    'note',
    'assetId',
    'contentHash',
    'result',
    'resultMessage',
  ],
  portfolioDailySnapshot: [
    'portfolioId',
    'date',
    'valueEur',
    'costBasisEur',
    'plEur',
    'flowEur',
    'cashBySource',
    'assetValues',
    'computedAt',
  ],
  portfolioSnapshotState: ['portfolioId', 'computedThrough', 'dirtyFrom', 'updatedAt'],
  expenseCategory: ['userId', 'name', 'direction', 'color', 'createdAt', 'updatedAt'],
  expenseTransaction: [
    'userId',
    'categoryId',
    'direction',
    'amount',
    'currency',
    'bookedOn',
    'description',
    'source',
    'dedupHash',
    'createdAt',
    'updatedAt',
  ],
  expenseRule: [
    'userId',
    'categoryId',
    'matchType',
    'pattern',
    'priority',
    'enabled',
    'createdAt',
    'updatedAt',
  ],
  expenseBudget: ['userId', 'categoryId', 'amount', 'currency', 'createdAt', 'updatedAt'],
  expenseBudgetFire: ['budgetId', 'periodKey', 'firedAt'],
} as const satisfies {
  [K in StrictKind]: readonly (keyof StrictData<K> & string)[];
};

interface VariantEnrollment {
  kind: StrictKind;
  field: string;
  values: readonly unknown[];
}

function variantEnrollment<K extends StrictKind, F extends keyof StrictData<K> & string>(
  kind: K,
  field: F,
  values: readonly StrictData<K>[F][],
): VariantEnrollment {
  return { kind, field, values };
}

/**
 * Finite normal-write vocabularies whose every member must be materialized in
 * the same captured graph. The arrays come from the production contracts/domain
 * constants, so adding an enum member automatically makes enrollment fail.
 */
const NORMAL_WRITE_VARIANTS = [
  variantEnrollment('portfolio', 'visibility', ['private', 'friends']),
  variantEnrollment('portfolio', 'defaultPayFromCash', [false, true]),
  variantEnrollment('transaction', 'side', ['buy', 'sell']),
  variantEnrollment('transaction', 'allowUncovered', [false, true]),
  variantEnrollment('cashSource', 'type', CASH_SOURCE_TYPES),
  variantEnrollment('cashSource', 'isMain', [false, true]),
  variantEnrollment('cashMovement', 'kind', CASH_MOVEMENT_KINDS),
  variantEnrollment('standingOrder', 'kind', STANDING_ORDER_KINDS),
  variantEnrollment('standingOrder', 'cadence', STANDING_ORDER_CADENCES),
  variantEnrollment('standingOrder', 'status', STANDING_ORDER_STATUSES),
  variantEnrollment('importBatch', 'status', IMPORT_BATCH_STATUSES),
  variantEnrollment('importRow', 'kind', [null, ...IMPORT_ROW_KINDS]),
  variantEnrollment('importRow', 'flag', IMPORT_ROW_FLAGS),
  variantEnrollment('importRow', 'result', [null, ...IMPORT_ROW_RESULTS]),
  variantEnrollment('expenseCategory', 'direction', EXPENSE_DIRECTIONS),
  variantEnrollment('expenseTransaction', 'direction', EXPENSE_DIRECTIONS),
  variantEnrollment('expenseRule', 'matchType', EXPENSE_RULE_MATCH_TYPES),
  variantEnrollment('expenseRule', 'enabled', [false, true]),
] as const satisfies readonly VariantEnrollment[];

/**
 * Load every strict-v1 kind from normal persisted state. The mapped return type
 * is the mechanical enrollment gate: adding a vault entity kind cannot compile
 * until this differential capture learns where its normal rows live.
 */
async function loadStrictRows(
  db: Database,
  userId: string,
): Promise<{ [K in StrictKind]: readonly PersistedRow[] }> {
  const [portfolioRows, customAssetRows, standingOrderRows, importBatchRows, expenseBudgetRows] =
    await Promise.all([
      db.select().from(portfolios).where(eq(portfolios.userId, userId)),
      db.select().from(assets).where(eq(assets.ownerId, userId)),
      db.select().from(standingOrders).where(eq(standingOrders.userId, userId)),
      db.select().from(importBatches).where(eq(importBatches.ownerId, userId)),
      db.select().from(expenseBudgets).where(eq(expenseBudgets.userId, userId)),
    ]);
  const portfolioIds = portfolioRows.map((row) => row.id);
  const customAssetIds = customAssetRows.map((row) => row.id);
  const standingOrderIds = standingOrderRows.map((row) => row.id);
  const importBatchIds = importBatchRows.map((row) => row.id);
  const expenseBudgetIds = expenseBudgetRows.map((row) => row.id);

  const [
    transactionRows,
    dividendRows,
    cashSourceRows,
    cashMovementRows,
    portfolioSettingRows,
    taxSettingRows,
    customAssetValueRows,
    standingOrderRunRows,
    expenseCategoryRows,
    expenseTransactionRows,
    expenseRuleRows,
    importRowRows,
    portfolioDailySnapshotRows,
    portfolioSnapshotStateRows,
    expenseBudgetFireRows,
  ] = await Promise.all([
    whenIds(portfolioIds, (ids) =>
      db.select().from(transactions).where(inArray(transactions.portfolioId, ids)),
    ),
    whenIds(portfolioIds, (ids) =>
      db.select().from(dividends).where(inArray(dividends.portfolioId, ids)),
    ),
    whenIds(portfolioIds, (ids) =>
      db.select().from(portfolioCashSources).where(inArray(portfolioCashSources.portfolioId, ids)),
    ),
    whenIds(portfolioIds, (ids) =>
      db
        .select()
        .from(portfolioCashMovements)
        .where(inArray(portfolioCashMovements.portfolioId, ids)),
    ),
    whenIds(portfolioIds, (ids) =>
      db.select().from(portfolioSettings).where(inArray(portfolioSettings.portfolioId, ids)),
    ),
    db.select().from(userTaxSettings).where(eq(userTaxSettings.userId, userId)),
    whenIds(customAssetIds, (ids) =>
      db.select().from(priceHistory).where(inArray(priceHistory.assetId, ids)),
    ),
    whenIds(standingOrderIds, (ids) =>
      db.select().from(standingOrderRuns).where(inArray(standingOrderRuns.standingOrderId, ids)),
    ),
    db.select().from(expenseCategories).where(eq(expenseCategories.userId, userId)),
    db.select().from(expenseTransactions).where(eq(expenseTransactions.userId, userId)),
    db.select().from(expenseRules).where(eq(expenseRules.userId, userId)),
    whenIds(importBatchIds, (ids) =>
      db.select().from(importRows).where(inArray(importRows.batchId, ids)),
    ),
    whenIds(portfolioIds, (ids) =>
      db
        .select()
        .from(portfolioDailySnapshots)
        .where(inArray(portfolioDailySnapshots.portfolioId, ids)),
    ),
    whenIds(portfolioIds, (ids) =>
      db
        .select()
        .from(portfolioSnapshotState)
        .where(inArray(portfolioSnapshotState.portfolioId, ids)),
    ),
    whenIds(expenseBudgetIds, (ids) =>
      db.select().from(expenseBudgetFires).where(inArray(expenseBudgetFires.budgetId, ids)),
    ),
  ]);

  return {
    portfolio: persistedRows(portfolioRows),
    transaction: persistedRows(transactionRows),
    dividend: persistedRows(dividendRows),
    cashSource: persistedRows(cashSourceRows),
    cashMovement: persistedRows(cashMovementRows),
    portfolioSetting: persistedRows(portfolioSettingRows),
    taxSetting: persistedRows(taxSettingRows),
    customAsset: persistedRows(customAssetRows),
    customAssetValue: persistedRows(customAssetValueRows),
    standingOrder: persistedRows(standingOrderRows),
    standingOrderRun: persistedRows(standingOrderRunRows),
    importBatch: persistedRows(importBatchRows),
    importRow: persistedRows(importRowRows),
    portfolioDailySnapshot: persistedRows(portfolioDailySnapshotRows),
    portfolioSnapshotState: persistedRows(portfolioSnapshotStateRows),
    expenseCategory: persistedRows(expenseCategoryRows),
    expenseTransaction: persistedRows(expenseTransactionRows),
    expenseRule: persistedRows(expenseRuleRows),
    expenseBudget: persistedRows(expenseBudgetRows),
    expenseBudgetFire: persistedRows(expenseBudgetFireRows),
  };
}

async function captureStrictDocument(db: Database, userId: string): Promise<StrictDocument> {
  const rowsByKind = await loadStrictRows(db, userId);
  const entities = VAULT_ENTITY_KINDS.flatMap((kind) =>
    rowsByKind[kind].map((row) => strictEntity(kind, row)),
  );
  const parsed = paranoidDisableRehydrationRequestSchema.safeParse({
    rehydrationId: newId(),
    document: { schemaVersion: 1, entities, mergeLog: [] },
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path ?? [];
    throw new Error(
      `persisted document field ${path.join('.')}=${displayValue(
        valueAtPath({ document: { schemaVersion: 1, entities, mergeLog: [] } }, path),
      )} is rejected by strict v1: ${issue?.message ?? parsed.error.message}`,
    );
  }
  return parsed.data.document;
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortedJson(item)]),
    );
  }
  return value;
}

const ID_BACKED_KINDS = new Set<StrictKind>([
  'portfolio',
  'transaction',
  'dividend',
  'cashSource',
  'cashMovement',
  'customAsset',
  'standingOrder',
  'standingOrderRun',
  'expenseCategory',
  'expenseTransaction',
  'expenseRule',
  'expenseBudget',
]);
const RESTORABLE_KINDS = new Set<StrictKind>(PARANOID_REHYDRATION_HANDLERS);

function documentFingerprint(document: StrictDocument): string[] {
  return document.entities
    .filter((entry) => RESTORABLE_KINDS.has(entry.kind))
    .map((entry) =>
      JSON.stringify(
        sortedJson({
          kind: entry.kind,
          ...(ID_BACKED_KINDS.has(entry.kind) ? { id: entry.id } : {}),
          data: entry.data,
        }),
      ),
    )
    .sort();
}

async function replaceNormalRowsWithServerVault(
  harness: TestHarness,
  userId: string,
): Promise<void> {
  await harness.db.transaction(async (tx) => {
    await tx.delete(portfolios).where(eq(portfolios.userId, userId));
    await tx.delete(assets).where(eq(assets.ownerId, userId));
    await tx.delete(expenseTransactions).where(eq(expenseTransactions.userId, userId));
    await tx.delete(expenseCategories).where(eq(expenseCategories.userId, userId));
    await tx.delete(userTaxSettings).where(eq(userTaxSettings.userId, userId));
    await tx
      .update(users)
      .set({
        privacyMode: 'paranoid',
        paranoidMediaSet: ['server'],
        paranoidDriveAttestedVersion: null,
      })
      .where(eq(users.id, userId));
    await tx.insert(paranoidVaults).values({
      userId,
      version: 1,
      formatVersion: 1,
      sizeBytes: 10,
      blob: Buffer.from('conformance-ciphertext'),
    });
  });
}

async function expectNoRestorableRows(
  db: Database,
  userId: string,
  message: string,
): Promise<void> {
  const rows = await loadStrictRows(db, userId);
  const present = PARANOID_REHYDRATION_HANDLERS.flatMap((kind) =>
    rows[kind].map((row) => `${kind}=${displayValue(row)}`),
  );
  expect(present, message).toEqual([]);
}

function entities<K extends StrictKind>(
  document: StrictDocument,
  kind: K,
): Extract<StrictEntity, { kind: K }>[] {
  return document.entities.filter(
    (entry): entry is Extract<StrictEntity, { kind: K }> => entry.kind === kind,
  );
}

function normalWriteEnrollmentFocus(document: StrictDocument): FieldValue[] {
  for (const kind of VAULT_ENTITY_KINDS) {
    const enrolled = document.entities.filter((entry) => entry.kind === kind);
    expect(
      enrolled.length,
      `${kind} has no service/repository-produced row in the normal-write enrollment graph`,
    ).toBeGreaterThan(0);
    const expectedFields = [...NORMAL_WRITE_FIELDS[kind]].sort();
    for (const entry of enrolled) {
      expect(
        Object.keys(entry.data).sort(),
        `${kind}[${entry.id}] gained or lost a persisted capability; update its normal writer enrollment`,
      ).toEqual(expectedFields);
    }
  }

  return NORMAL_WRITE_VARIANTS.map(({ kind, field, values }) => {
    const observedValues = document.entities
      .filter((entry) => entry.kind === kind)
      .map((entry) => (entry.data as Record<string, unknown>)[field]);
    const observed = [...new Set(observedValues.map(displayValue))].sort();
    const expected = [...new Set(values.map(displayValue))].sort();
    expect(
      observed,
      `${kind}.${field} normal-write variants are not mechanically enrolled`,
    ).toEqual(expected);
    return { field: `${kind}.${field}`, value: observedValues };
  });
}

function focusText(focus: readonly FieldValue[]): string {
  return focus.map(({ field, value }) => `${field}=${displayValue(value)}`).join(', ');
}

function conformanceFailure(name: string, focus: readonly FieldValue[], error: unknown): Error {
  const cause = error instanceof Error ? `${error.name}: ${error.message}` : displayValue(error);
  return new Error(
    `${name} rejected a normal-write-path persisted state; rejected field/value: ${focusText(
      focus,
    )}; ${cause}`,
    { cause },
  );
}

async function expectReachableStateRoundTrip(testCase: ReachableStateCase): Promise<void> {
  const harness = await createTestApp(testCase.options);
  const arranged = await testCase.arrange(harness);
  const sourceDocument = await captureStrictDocument(harness.db, arranged.userId);
  const focus = arranged.focus(sourceDocument);
  expect(focus.length, `${testCase.name} must name a diagnostic field/value`).toBeGreaterThan(0);
  const sourceFingerprint = documentFingerprint(sourceDocument);

  if (arranged.preflightOnly) {
    try {
      await createParanoidRehydrationService({
        db: harness.db,
        now: () => new Date(TEST_NOW),
      }).rehydrate(arranged.userId, {
        rehydrationId: newId(),
        document: sourceDocument,
      });
      throw new Error(`${testCase.name} unexpectedly passed the normal-mode state gate`);
    } catch (error) {
      if (
        !(
          error !== null &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'NOT_PARANOID'
        )
      ) {
        throw conformanceFailure(testCase.name, focus, error);
      }
    }
    expect(documentFingerprint(await captureStrictDocument(harness.db, arranged.userId))).toEqual(
      sourceFingerprint,
    );
    return;
  }

  await replaceNormalRowsWithServerVault(harness, arranged.userId);
  await expectNoRestorableRows(
    harness.db,
    arranged.userId,
    `${testCase.name} did not clear its normal source rows`,
  );

  try {
    await createParanoidRehydrationService({
      db: harness.db,
      now: () => new Date(TEST_NOW),
    }).rehydrate(arranged.userId, {
      rehydrationId: newId(),
      document: sourceDocument,
    });
  } catch (error) {
    throw conformanceFailure(testCase.name, focus, error);
  }

  const restoredDocument = await captureStrictDocument(harness.db, arranged.userId);
  expect(
    documentFingerprint(restoredDocument),
    `${testCase.name} changed persisted rows after accepting ${focusText(focus)}`,
  ).toEqual(sourceFingerprint);
}

interface QuantityInput {
  side: 'buy' | 'sell';
  quantity: number;
}

interface QuantityCase {
  name: string;
  inputs: readonly QuantityInput[];
  expectedStored: readonly string[];
  preflightOnly?: boolean;
}

const QUANTITY_CASES: readonly QuantityCase[] = [
  {
    name: 'one-quantum scale-8 round-apart batch',
    inputs: [
      { side: 'buy', quantity: 1.0000000046 },
      { side: 'sell', quantity: 1.0000000051 },
    ],
    expectedStored: ['1.00000000', '1.00000001'],
  },
  {
    name: 'cumulative four-buy scale-8 round-apart batch',
    inputs: [
      { side: 'buy', quantity: 0.2500000046 },
      { side: 'buy', quantity: 0.2500000046 },
      { side: 'buy', quantity: 0.2500000046 },
      { side: 'buy', quantity: 0.2500000046 },
      { side: 'sell', quantity: 1.0000000189 },
    ],
    expectedStored: ['0.25000000', '0.25000000', '0.25000000', '0.25000000', '1.00000002'],
  },
  {
    name: 'large-magnitude IEEE-754 cancellation batch',
    inputs: [
      { side: 'buy', quantity: 999_999_999_999 },
      { side: 'buy', quantity: 0.00007 },
      { side: 'sell', quantity: 999_999_999_999 },
      { side: 'sell', quantity: 0.0001 },
    ],
    expectedStored: ['999999999999.00000000', '0.00007000', '999999999999.00000000', '0.00010000'],
  },
  {
    name: 'large-magnitude IEEE-754 addition batch',
    // This issue owns validateGraph arithmetic. Full replay of this extreme
    // FIFO discrepancy belongs to the separate tax-replay seam.
    preflightOnly: true,
    inputs: [
      { side: 'buy', quantity: 300_000_000_000.0004 },
      { side: 'buy', quantity: 300_000_000_000.01245 },
      { side: 'sell', quantity: 600_000_000_000.013 },
    ],
    expectedStored: ['300000000000.00040000', '300000000000.01245000', '600000000000.01300000'],
  },
];

function quantityFocus(document: StrictDocument): FieldValue[] {
  return entities(document, 'transaction').map((entry) => ({
    field: `transaction[${entry.id}].quantity`,
    value: entry.data.quantity,
  }));
}

async function arrangeCompleteNormalWriteGraph(
  harness: TestHarness,
): Promise<ArrangedReachableState> {
  const user = await harness.seedUser();
  const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);

  const sharedPortfolio = await harness.ctx.portfolio.createPortfolio(user.id, {
    name: 'Enrollment shared',
  });
  await harness.ctx.portfolio.updatePortfolio(user.id, sharedPortfolio.id, {
    visibility: 'friends',
    defaultPayFromCash: true,
  });
  const archivedPortfolio = await harness.ctx.portfolio.createPortfolio(user.id, {
    name: 'Enrollment archived',
  });
  await harness.ctx.portfolio.archivePortfolio(user.id, archivedPortfolio.id);

  const custom = await harness.ctx.customAssets.create(user.id, {
    name: 'Enrollment custom asset',
    category: 'other',
    currency: 'EUR',
    smoothing: true,
  });
  await harness.ctx.customAssets.putValuePoints(user.id, custom.asset.id, [
    { date: '2026-07-24', value: 321.123456 },
  ]);

  const assetRepo = createAssetRepository(harness.db);
  const { row: asset } = await assetRepo.upsertGlobal({
    providerId: 'test',
    providerRef: 'REHYDRATION-NORMAL-WRITE',
    type: 'stock',
    symbol: 'WRITE',
    name: 'Normal write enrollment',
    exchange: null,
    currency: 'EUR',
  });
  const { row: uncoveredAsset } = await assetRepo.upsertGlobal({
    providerId: 'test',
    providerRef: 'REHYDRATION-UNCOVERED-WRITE',
    type: 'stock',
    symbol: 'UNCOV',
    name: 'Uncovered normal write enrollment',
    exchange: null,
    currency: 'EUR',
  });

  await harness.ctx.tax.updateSettings(user.id, {
    mode: 'country_specific',
    country: 'AT',
  });
  await harness.ctx.tax.setPortfolioTaxOverride(user.id, portfolioId, {
    mode: 'country_specific',
    country: 'AT',
  });

  const createdSources = new Map<
    (typeof CASH_SOURCE_TYPES)[number],
    Awaited<ReturnType<TestHarness['ctx']['portfolio']['createCashSource']>>
  >();
  for (const type of CASH_SOURCE_TYPES) {
    const source = await harness.ctx.portfolio.createCashSource(user.id, portfolioId, {
      name: `Enrollment ${type}`,
      type,
    });
    createdSources.set(type, source);
  }
  const allSources = await harness.ctx.portfolio.listCashSources(user.id, portfolioId);
  const main = allSources.sources.find((source) => source.isMain);
  const bank = createdSources.get('bank');
  const retirement = createdSources.get('retirement');
  const archivedSource = createdSources.get('custom');
  if (!main || !bank || !retirement || !archivedSource) {
    throw new Error('expected complete normal cash-source enrollment');
  }
  await harness.ctx.portfolio.archiveCashSource(user.id, portfolioId, archivedSource.id);

  await harness.ctx.portfolio.depositCash(user.id, portfolioId, {
    sourceId: main.id,
    amountEur: 5_000,
    executedAt: '2026-01-01T08:00:00.000Z',
    note: 'Enrollment deposit',
  });
  await harness.ctx.portfolio.withdrawCash(user.id, portfolioId, {
    sourceId: main.id,
    amountEur: 10,
    executedAt: '2026-01-02T08:00:00.000Z',
    note: 'Enrollment withdrawal',
  });
  await harness.ctx.portfolio.depositCash(user.id, portfolioId, {
    sourceId: bank.id,
    amountEur: 500,
    executedAt: '2026-01-03T08:00:00.000Z',
  });
  await harness.ctx.portfolio.transferCash(user.id, portfolioId, {
    fromSourceId: bank.id,
    toSourceId: retirement.id,
    amountEur: 100,
    executedAt: '2026-01-04T08:00:00.000Z',
    note: 'Enrollment transfer',
  });

  await harness.ctx.portfolio.createTransactions(user.id, portfolioId, [
    {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 10,
      fee: 0,
      executedAt: '2026-01-10T10:00:00.000Z',
      note: 'Enrollment funded buy',
      payFromCash: true,
      cashSourceId: main.id,
    },
  ]);
  await harness.ctx.portfolio.createTransactions(user.id, portfolioId, [
    {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 19,
      fee: 0,
      executedAt: '2026-02-10T10:00:00.000Z',
      addProceedsToCash: true,
      cashSourceId: main.id,
    },
    {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 8,
      fee: 0,
      executedAt: '2026-03-10T10:00:00.000Z',
      addProceedsToCash: true,
      cashSourceId: main.id,
    },
  ]);
  await harness.ctx.portfolio.createTransactions(user.id, portfolioId, [
    {
      assetId: uncoveredAsset.id,
      side: 'sell',
      quantity: 2,
      price: 5,
      fee: 0,
      executedAt: '2026-04-01T10:00:00.000Z',
      allowUncovered: true,
      uncoveredEntryPrice: 5,
      note: 'Enrollment acknowledged uncovered sell',
    },
  ]);
  await harness.ctx.tax.recordDividend(user.id, portfolioId, {
    assetId: asset.id,
    cashSourceId: main.id,
    grossAmountEur: 20,
    executedAt: '2026-04-10T10:00:00.000Z',
    note: 'Enrollment dividend',
  });

  let runnableOrderId: string | null = null;
  let standingOrderIndex = 0;
  for (const kind of STANDING_ORDER_KINDS) {
    for (const cadence of STANDING_ORDER_CADENCES) {
      const runnable = kind === 'cash-add' && cadence === 'daily';
      const order = await harness.ctx.standingOrders.create(user.id, {
        portfolioId,
        kind,
        ...(kind === 'buy-asset' ? { assetId: asset.id } : {}),
        amount: standingOrderIndex + 1,
        label: `Enrollment ${kind} ${cadence}`,
        cadence,
        ...(cadence === 'monthly' ? { anchorDay: 24 } : {}),
        startDate: '2026-07-01',
        ...(standingOrderIndex % 2 === 0 ? { endDate: '2026-08-31' } : {}),
      });
      if (runnable) runnableOrderId = order.id;
      else await harness.ctx.standingOrders.pause(user.id, order.id);
      standingOrderIndex += 1;
    }
  }
  if (!runnableOrderId) throw new Error('expected a runnable standing order');
  await expect(
    harness.ctx.standingOrders.processDueOrders({ now: TEST_NOW }),
  ).resolves.toMatchObject({ booked: 1 });

  const importRepo = createImportRepository(harness.db);
  const stagedRows: StageImportRowInput[] = IMPORT_ROW_KINDS.map((kind, index) => ({
    rowIndex: index,
    raw: `${kind};normal-write-enrollment`,
    kind,
    flag: (
      [
        'mapped',
        'duplicate',
        'unmapped',
        'error',
        'mapped',
      ] as const satisfies readonly (typeof IMPORT_ROW_FLAGS)[number][]
    )[index]!,
    message: index === 0 ? null : `Enrollment ${kind}`,
    executedAt: new Date(`2026-06-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`),
    isin: null,
    symbol: kind === 'buy' || kind === 'sell' || kind === 'dividend' ? asset.symbol : null,
    name: null,
    quantity: kind === 'buy' || kind === 'sell' ? index + 1 : null,
    price: kind === 'buy' || kind === 'sell' ? 10 + index : null,
    fee: kind === 'buy' || kind === 'sell' ? 0 : null,
    amountEur: kind === 'dividend' || kind === 'deposit' || kind === 'withdrawal' ? 10 : null,
    currency: 'EUR',
    note: null,
    assetId: kind === 'buy' || kind === 'sell' || kind === 'dividend' ? asset.id : null,
    contentHash: `normal-write-${kind}`,
  }));
  const appliedBatch = await importRepo.createBatch(
    {
      ownerId: user.id,
      portfolioId,
      brokerId: 'conformance',
      filename: 'applied.csv',
    },
    stagedRows,
  );
  const appliedRows = await importRepo.listRows(appliedBatch.id);
  await importRepo.setRowResults(
    appliedRows.map((row, index) => ({
      id: row.id,
      result: IMPORT_ROW_RESULTS[index]!,
      resultMessage: index === 0 ? null : `Enrollment ${IMPORT_ROW_RESULTS[index]!}`,
    })),
  );
  await importRepo.claimPendingBatch(appliedBatch.id, main.id);
  await importRepo.createBatch(
    {
      ownerId: user.id,
      portfolioId,
      brokerId: 'conformance',
      filename: 'pending.csv',
    },
    [
      {
        rowIndex: 0,
        raw: 'unparseable',
        kind: null,
        flag: 'error',
        message: 'Enrollment pending error',
        executedAt: null,
        isin: null,
        symbol: null,
        name: null,
        quantity: null,
        price: null,
        fee: null,
        amountEur: null,
        currency: null,
        note: null,
        assetId: null,
        contentHash: null,
      },
    ],
  );

  const expenseCategory = (
    await harness.ctx.expenses.createCategory(user.id, {
      name: 'Enrollment expense',
      direction: 'expense',
      color: '#123456',
    })
  ).category;
  const incomeCategory = (
    await harness.ctx.expenses.createCategory(user.id, {
      name: 'Enrollment income',
      direction: 'income',
      color: '#654321',
    })
  ).category;
  for (const [index, matchType] of EXPENSE_RULE_MATCH_TYPES.entries()) {
    await harness.ctx.expenses.createRule(user.id, {
      categoryId: expenseCategory.id,
      matchType,
      pattern: matchType === 'regex' ? '^enrollment.*' : `enrollment-${matchType}`,
      priority: index,
      enabled: index % 2 === 0,
    });
  }
  await harness.ctx.expenseBudgets.createBudget(user.id, {
    categoryId: expenseCategory.id,
    amount: 50,
    currency: 'EUR',
  });
  await harness.ctx.expenses.createTransaction(user.id, {
    categoryId: expenseCategory.id,
    direction: 'expense',
    amount: 60,
    currency: 'EUR',
    bookedOn: '2026-07-10',
    description: 'Enrollment budget breach',
  });
  await harness.ctx.expenses.createTransaction(user.id, {
    categoryId: incomeCategory.id,
    direction: 'income',
    amount: 100,
    currency: 'EUR',
    bookedOn: '2026-07-11',
    description: 'Enrollment income',
  });
  await harness.ctx.expenses.createTransaction(user.id, {
    categoryId: null,
    direction: 'expense',
    amount: 1,
    currency: 'EUR',
    bookedOn: '2026-07-12',
    description: 'Enrollment uncategorized',
  });
  await createExpenseTransactionRepository(harness.db).insertImported(user.id, [
    {
      categoryId: expenseCategory.id,
      direction: 'expense',
      amount: 2,
      currency: 'EUR',
      bookedOn: '2026-07-13',
      description: 'Enrollment imported expense',
      source: 'import:conformance',
      dedupHash: 'normal-write-expense-import',
    },
  ]);
  await harness.ctx.expenseBudgets.evaluate(user.id);

  const snapshotRepo = createPortfolioSnapshotRepository(harness.db);
  const priorSnapshotState = await snapshotRepo.getState(portfolioId);
  await expect(
    snapshotRepo.saveComputation({
      portfolioId,
      rows: [
        {
          date: '2026-07-24',
          valueEur: 6_000,
          costBasisEur: 1_000,
          plEur: 500,
          flowEur: 5_000,
          cashBySource: { [main.id]: 4_000 },
          assetValues: { [asset.id]: 2_000 },
        },
      ],
      computedThrough: '2026-07-24',
      seenUpdatedAt: priorSnapshotState?.updatedAt ?? null,
      seenDirtyFrom: priorSnapshotState?.dirtyFrom ?? null,
    }),
  ).resolves.toEqual({ applied: true });

  return {
    userId: user.id,
    focus: normalWriteEnrollmentFocus,
  };
}

const REACHABLE_STATE_CASES: readonly ReachableStateCase[] = [
  {
    name: 'complete strict-v1 graph enrolled through normal services and repositories',
    options: {
      taxNow: () => TEST_NOW,
      budgetNow: () => new Date(TEST_NOW),
    },
    arrange: arrangeCompleteNormalWriteGraph,
  },
  {
    name: 'customAssetValue.close values persisted through CustomAssetService',
    async arrange(harness) {
      const user = await harness.seedUser();
      await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
      const custom = await harness.ctx.customAssets.create(user.id, {
        name: 'Conformance value points',
        category: 'other',
        currency: 'EUR',
        smoothing: true,
      });
      await harness.ctx.customAssets.putValuePoints(user.id, custom.asset.id, [
        { date: '2026-07-20', value: 0 },
        { date: '2026-07-24', value: 123.456789 },
      ]);
      return {
        userId: user.id,
        focus(document) {
          return entities(document, 'customAssetValue').map((entry) => ({
            field: `customAssetValue[${entry.id}].close`,
            value: entry.data.close,
          }));
        },
      };
    },
  },
  {
    name: 'standing-order kind/cadence/status reachable matrix',
    async arrange(harness) {
      const user = await harness.seedUser();
      const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
      const custom = await harness.ctx.customAssets.create(user.id, {
        name: 'Conformance standing-order asset',
        category: 'other',
        currency: 'EUR',
        smoothing: false,
      });

      let index = 0;
      for (const kind of STANDING_ORDER_KINDS) {
        for (const cadence of STANDING_ORDER_CADENCES) {
          for (const status of STANDING_ORDER_STATUSES) {
            const order = await harness.ctx.standingOrders.create(user.id, {
              portfolioId,
              kind,
              ...(kind === 'buy-asset' ? { assetId: custom.asset.id } : {}),
              amount: index + 1,
              label: `${kind}-${cadence}-${status}`,
              cadence,
              ...(cadence === 'monthly' ? { anchorDay: 31 } : {}),
              startDate: '2026-07-01',
              ...(index % 2 === 0 ? { endDate: '2026-07-31' } : {}),
            });
            if (status === 'paused') await harness.ctx.standingOrders.pause(user.id, order.id);
            index += 1;
          }
        }
      }

      return {
        userId: user.id,
        focus(document) {
          return entities(document, 'standingOrder').flatMap((entry) => [
            { field: `standingOrder[${entry.id}].kind`, value: entry.data.kind },
            { field: `standingOrder[${entry.id}].assetId`, value: entry.data.assetId },
            { field: `standingOrder[${entry.id}].cadence`, value: entry.data.cadence },
            { field: `standingOrder[${entry.id}].anchorDay`, value: entry.data.anchorDay },
            { field: `standingOrder[${entry.id}].startDate`, value: entry.data.startDate },
            { field: `standingOrder[${entry.id}].endDate`, value: entry.data.endDate },
            { field: `standingOrder[${entry.id}].status`, value: entry.data.status },
          ]);
        },
      };
    },
  },
  ...QUANTITY_CASES.map(
    (quantityCase): ReachableStateCase => ({
      name: `transaction.quantity ${quantityCase.name}`,
      options: { taxNow: () => TEST_NOW },
      async arrange(harness) {
        const user = await harness.seedUser();
        const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
        const { row: asset } = await createAssetRepository(harness.db).upsertGlobal({
          providerId: 'test',
          providerRef: `REHYDRATION-${quantityCase.name}`.replaceAll(' ', '-').toUpperCase(),
          type: 'stock',
          symbol: 'QTY',
          name: quantityCase.name,
          exchange: null,
          currency: 'EUR',
        });
        const domainRows = quantityCase.inputs.map((input, index) => ({
          assetId: asset.id,
          side: input.side,
          quantity: input.quantity,
          price: 1,
          fee: 0,
          executedAt: new Date(TEST_NOW + index * 60_000).toISOString(),
        }));

        try {
          reducePosition(domainRows);
        } catch (error) {
          throw new Error(
            `${quantityCase.name} is no longer admitted by normal reducePosition arithmetic`,
            { cause: error },
          );
        }
        await harness.ctx.portfolio.createTransactions(user.id, portfolioId, domainRows);
        const stored = (
          await harness.db
            .select()
            .from(transactions)
            .where(eq(transactions.portfolioId, portfolioId))
        )
          .sort(
            (left, right) =>
              left.executedAt.getTime() - right.executedAt.getTime() ||
              left.id.localeCompare(right.id),
          )
          .map((row) => row.quantity);
        expect(
          stored,
          `${quantityCase.name} no longer persists the reviewed numeric(20,8) boundary`,
        ).toEqual(quantityCase.expectedStored);

        return {
          userId: user.id,
          focus: quantityFocus,
          preflightOnly: quantityCase.preflightOnly,
        };
      },
    }),
  ),
];

describe('paranoid rehydration normal-write differential conformance', () => {
  it.each(REACHABLE_STATE_CASES)('$name', async (testCase) => {
    await expectReachableStateRoundTrip(testCase);
  });

  it('rejects an unreachable two-quantum stored oversell before its first write', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
    const { row: asset } = await createAssetRepository(harness.db).upsertGlobal({
      providerId: 'test',
      providerRef: 'REHYDRATION-TRUE-OVERSELL',
      type: 'stock',
      symbol: 'OVER',
      name: 'True stored oversell',
      exchange: null,
      currency: 'EUR',
    });
    await harness.ctx.portfolio.createTransactions(user.id, portfolioId, [
      {
        assetId: asset.id,
        side: 'buy',
        quantity: 0.25,
        price: 1,
        fee: 0,
        executedAt: '2026-07-24T10:00:00.000Z',
      },
      {
        assetId: asset.id,
        side: 'sell',
        quantity: 0.25,
        price: 1,
        fee: 0,
        executedAt: '2026-07-24T10:01:00.000Z',
      },
    ]);
    const sourceDocument = await captureStrictDocument(harness.db, user.id);
    const sell = entities(sourceDocument, 'transaction').find(
      (entry) => entry.data.side === 'sell',
    );
    if (!sell) throw new Error('expected captured sell');
    sell.data.quantity = '0.25000002';

    await replaceNormalRowsWithServerVault(harness, user.id);
    const mutationTransaction = vi.spyOn(harness.db, 'transaction');
    await expect(
      createParanoidRehydrationService({ db: harness.db }).rehydrate(user.id, {
        rehydrationId: newId(),
        document: sourceDocument,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_CASH_LEDGER',
      message: expect.stringContaining(
        `transaction[${sell.id}].quantity=${JSON.stringify(sell.data.quantity)}`,
      ),
    });
    expect(mutationTransaction).not.toHaveBeenCalled();
    await expectNoRestorableRows(
      harness.db,
      user.id,
      `unreachable transaction[${sell.id}].quantity=${sell.data.quantity} wrote rows`,
    );
    mutationTransaction.mockRestore();
  });

  it('reports the rejected field/value and attempts zero writes for an invalid graph', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
    const custom = await harness.ctx.customAssets.create(user.id, {
      name: 'Invalid close diagnostic',
      category: 'other',
      currency: 'EUR',
      smoothing: false,
    });
    await harness.ctx.customAssets.putValuePoints(user.id, custom.asset.id, [
      { date: '2026-07-24', value: 1 },
    ]);
    const sourceDocument = await captureStrictDocument(harness.db, user.id);
    const value = entities(sourceDocument, 'customAssetValue')[0];
    if (!value) throw new Error('expected captured custom-asset value');
    value.data.close = '-1';
    const focus = [
      { field: `customAssetValue[${value.id}].close`, value: value.data.close },
    ] as const;

    await replaceNormalRowsWithServerVault(harness, user.id);
    const mutationTransaction = vi.spyOn(harness.db, 'transaction');
    const stages: ParanoidRehydrationStage[] = [];
    let rejection: unknown;
    let diagnostic: Error | undefined;
    try {
      await createParanoidRehydrationService({
        db: harness.db,
        afterStage(stage) {
          stages.push(stage);
        },
      }).rehydrate(user.id, {
        rehydrationId: newId(),
        document: sourceDocument,
      });
    } catch (error) {
      rejection = error;
      diagnostic = conformanceFailure('invalid complete graph', focus, error);
    }

    expect(rejection).toMatchObject({
      code: 'INVALID_REFERENCE',
      message: expect.stringMatching(/custom-asset close/i),
    });
    expect(diagnostic?.message).toContain(
      `rejected field/value: ${focus[0].field}="${focus[0].value}"`,
    );
    expect(
      mutationTransaction,
      `invalid graph entered the mutation transaction before rejecting ${focusText(focus)}`,
    ).not.toHaveBeenCalled();
    expect(stages).toEqual([]);
    await expectNoRestorableRows(
      harness.db,
      user.id,
      `invalid graph wrote rows before rejecting ${focusText(focus)}`,
    );
    expect(
      await harness.db
        .select()
        .from(paranoidRehydrationReceipts)
        .where(eq(paranoidRehydrationReceipts.userId, user.id)),
    ).toEqual([]);
    mutationTransaction.mockRestore();
  });
});
