import {
  paranoidDisableRehydrationRequestSchema,
  STANDING_ORDER_CADENCES,
  STANDING_ORDER_KINDS,
  STANDING_ORDER_STATUSES,
  VAULT_ENTITY_KINDS,
  VAULT_ENTITY_SCHEMAS,
  type ParanoidDisableRehydrationRequest,
} from '@bettertrack/contracts';
import { reducePosition } from '@bettertrack/domain/holdings';
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../../../data/db';
import { newId } from '../../../data/ids';
import { createAssetRepository } from '../../../data/repositories/assetRepository';
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

const REACHABLE_STATE_CASES: readonly ReachableStateCase[] = [
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
