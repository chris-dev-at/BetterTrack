import {
  CASH_SOURCE_TYPES,
  cashMovementKindSchema,
  CUSTOM_COST_BASIS,
  CUSTOM_ASSET_CATEGORIES,
  EXPENSE_DIRECTIONS,
  EXPENSE_RULE_MATCH_TYPES,
  IMPORT_BATCH_STATUSES,
  IMPORT_ROW_FLAGS,
  IMPORT_ROW_KINDS,
  IMPORT_ROW_RESULTS,
  paranoidDisableRehydrationRequestSchema,
  portfolioVisibilitySchema,
  SOURCE_TAG_SYNC_MIRRORCHAIN,
  STANDING_ORDER_CADENCES,
  STANDING_ORDER_KINDS,
  STANDING_ORDER_STATUSES,
  TAX_COUNTRIES,
  TAX_MODES,
  transactionInputSchema,
  transactionSideSchema,
  VAULT_ENTITY_SCHEMAS,
  VAULT_ENTITY_KINDS,
  type ParanoidDisableRehydrationRequest,
  type UpdateTaxSettingsRequest,
} from '@bettertrack/contracts';
import { reducePosition } from '@bettertrack/domain/holdings';
import { costBasisStrategyForCountry } from '@bettertrack/domain/tax';
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../../../data/db';
import { newId } from '../../../data/ids';
import { createAssetRepository } from '../../../data/repositories/assetRepository';
import {
  assets,
  dividends,
  expenseBudgets,
  expenseBudgetFires,
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
  requireEveryStrictKind?: boolean;
  variantDimensions?: (document: StrictDocument) => readonly {
    name: string;
    expected: readonly string[];
    actual: readonly string[];
  }[];
  verifyRestored?: (harness: TestHarness) => Promise<void>;
}

interface ReachableStateCase {
  name: string;
  options?: CreateTestAppOptions;
  arrange(harness: TestHarness): Promise<ArrangedReachableState>;
}

/**
 * Turn a Drizzle row back into the exact JSON representation the strict v1
 * client document carries. This conversion is deliberately schema-driven:
 * whenever a persisted column is added to a strict entity, parsing fails with
 * its path and value instead of silently dropping it from the conformance run.
 */
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
    const field = path.length > 0 ? `${kind}.${path.join('.')}` : kind;
    const rejected = valueAtPath(candidate, path);
    throw new Error(
      `persisted ${field}=${displayValue(rejected)} is absent from the strict v1 row schema: ${
        issue?.message ?? parsed.error.message
      }`,
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
 * Capture the complete user-owned strict-v1 graph from the database after
 * normal services/repositories persisted it. The mapped type is the mechanical
 * enrollment gate: a future vault kind cannot compile until this harness learns
 * how to capture its normal row. Purge-only rows intentionally participate in
 * request-schema and preflight conformance even though they are not restored.
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
      )} is rejected by the strict request schema: ${issue?.message ?? parsed.error.message}`,
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

const ID_BACKED_KINDS = new Set<StrictEntity['kind']>([
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

const RESTORABLE_KIND_SET = new Set<StrictKind>(PARANOID_REHYDRATION_HANDLERS);

function documentFingerprint(document: StrictDocument): string[] {
  return document.entities
    .filter((entity) => RESTORABLE_KIND_SET.has(entity.kind))
    .map((entity) =>
      JSON.stringify(
        sortedJson({
          kind: entity.kind,
          ...(ID_BACKED_KINDS.has(entity.kind) ? { id: entity.id } : {}),
          data: entity.data,
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
    // Portfolio deletion cascades its transactions, dividends, cash graph,
    // settings and standing orders/runs. The remaining roots are owner-scoped.
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

function focusText(focus: readonly FieldValue[]): string {
  return focus.map(({ field, value }) => `${field}=${displayValue(value)}`).join(', ');
}

function leafFields(value: unknown, field: string, output: FieldValue[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => leafFields(item, `${field}[${index}]`, output));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      leafFields(item, `${field}.${key}`, output);
    }
    return;
  }
  output.push({ field, value });
}

function documentFields(document: StrictDocument): FieldValue[] {
  const output: FieldValue[] = [];
  for (const entity of document.entities) {
    leafFields(entity.data, `${entity.kind}[${entity.id}]`, output);
  }
  return output;
}

function diagnosticTokens(value: string): string[] {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
}

/**
 * Locate the persisted leaf implicated by the validator message. Case focus is
 * the deterministic fallback, while normal field labels ("anchor day",
 * "transaction quantity", etc.) narrow automatically. The two semantic
 * validators whose messages name a condition rather than a column get explicit
 * aliases. A temporary rule tightening therefore fails with the actual
 * persisted path and value, not only a generic test name.
 */
function rejectedFieldValues(
  document: StrictDocument,
  focus: readonly FieldValue[],
  error: unknown,
): readonly FieldValue[] {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const messageTokens = new Set(diagnosticTokens(message));
  const scored = documentFields(document).map((candidate) => {
    const pathTokens = diagnosticTokens(candidate.field);
    let score = pathTokens.reduce((total, token) => total + (messageTokens.has(token) ? 1 : 0), 0);
    if (
      /oversell|position/.test(message) &&
      candidate.field.startsWith('transaction[') &&
      candidate.field.endsWith('.quantity')
    ) {
      score += 100;
    }
    if (
      /cash source.*negative|cash ledger/.test(message) &&
      candidate.field.startsWith('cashMovement[') &&
      candidate.field.endsWith('.amountEur')
    ) {
      score += 100;
    }
    return { candidate, score };
  });
  const bestScore = Math.max(0, ...scored.map(({ score }) => score));
  const best = scored
    .filter(({ score }) => score === bestScore && score > 0)
    .map(({ candidate }) => candidate)
    .slice(0, 12);
  return best.length > 0 ? best : focus;
}

function conformanceFailure(
  name: string,
  document: StrictDocument,
  focus: readonly FieldValue[],
  error: unknown,
): Error {
  const cause = error instanceof Error ? `${error.name}: ${error.message}` : displayValue(error);
  const rejected = rejectedFieldValues(document, focus, error);
  return new Error(
    `${name} rejected a normal-write-path persisted state; rejected field/value: ${focusText(
      rejected,
    )}; case focus: ${focusText(focus)}; ${cause}`,
    { cause },
  );
}

async function expectReachableStateRoundTrip(testCase: ReachableStateCase): Promise<void> {
  const harness = await createTestApp(testCase.options);
  const arranged = await testCase.arrange(harness);
  const sourceDocument = await captureStrictDocument(harness.db, arranged.userId);
  const focus = arranged.focus(sourceDocument);
  expect(
    focus.length,
    `${testCase.name} must name at least one diagnostic field/value`,
  ).toBeGreaterThan(0);

  if (arranged.requireEveryStrictKind) {
    const populated = [...new Set(sourceDocument.entities.map((entity) => entity.kind))].sort();
    expect(
      populated,
      `${testCase.name} did not populate every strict-v1 kind; captured ${populated.join(', ')}`,
    ).toEqual([...VAULT_ENTITY_KINDS].sort());
  }

  for (const dimension of arranged.variantDimensions?.(sourceDocument) ?? []) {
    const expected = [...new Set(dimension.expected)].sort();
    const actual = [...new Set(dimension.actual)].sort();
    expect(
      actual,
      `${testCase.name} did not exercise every reachable ${dimension.name} variant`,
    ).toEqual(expected);
  }

  const sourceFingerprint = documentFingerprint(sourceDocument);
  await replaceNormalRowsWithServerVault(harness, arranged.userId);
  await expectNoRestorableRows(
    harness.db,
    arranged.userId,
    `${testCase.name} did not clear its normal source rows before rehydration`,
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
    throw conformanceFailure(testCase.name, sourceDocument, focus, error);
  }

  const restoredDocument = await captureStrictDocument(harness.db, arranged.userId);
  expect(
    documentFingerprint(restoredDocument),
    `${testCase.name} changed persisted rows after accepting ${focusText(focus)}`,
  ).toEqual(sourceFingerprint);
  await arranged.verifyRestored?.(harness);
}

function entities<K extends StrictEntity['kind']>(
  document: StrictDocument,
  kind: K,
): Extract<StrictEntity, { kind: K }>[] {
  return document.entities.filter(
    (entity): entity is Extract<StrictEntity, { kind: K }> => entity.kind === kind,
  );
}

interface TransactionValidationVariant {
  side: (typeof transactionSideSchema.options)[number];
  allowUncovered: boolean;
  uncoveredEntryPrice?: number;
}

/**
 * Enumerate the finite uncovered-sell branch space from the public normal-write
 * schema itself. Invalid combinations (acknowledgement on a buy, or an entry
 * price without acknowledgement) are filtered by that schema; every remaining
 * combination is then persisted through PortfolioService below. New transaction
 * sides therefore enter this gate automatically instead of relying on one
 * representative row per entity kind.
 */
const TRANSACTION_VALIDATION_VARIANTS: readonly TransactionValidationVariant[] =
  transactionSideSchema.options.flatMap((side) =>
    [false, true].flatMap((allowUncovered) =>
      ([undefined, 7] as const satisfies readonly (number | undefined)[])
        .map((uncoveredEntryPrice) => ({
          side,
          allowUncovered,
          ...(uncoveredEntryPrice === undefined ? {} : { uncoveredEntryPrice }),
        }))
        .filter(
          (variant) =>
            transactionInputSchema.safeParse({
              assetId: DEVICE_ID,
              side: variant.side,
              quantity: 1,
              price: 10,
              fee: 0,
              executedAt: EDITED_AT,
              allowUncovered: variant.allowUncovered,
              ...(variant.uncoveredEntryPrice === undefined
                ? {}
                : { uncoveredEntryPrice: variant.uncoveredEntryPrice }),
            }).success,
        ),
    ),
  );

function transactionVariantKey(input: {
  side: string;
  allowUncovered: boolean;
  uncoveredEntryPrice: unknown;
}): string {
  return [
    `side=${input.side}`,
    `allowUncovered=${String(input.allowUncovered)}`,
    `uncoveredEntryPrice=${
      input.uncoveredEntryPrice === null || input.uncoveredEntryPrice === undefined
        ? 'null'
        : 'value'
    }`,
  ].join(',');
}

const QUANTITY_ROUNDING_BUY = 0.2500000046;
const QUANTITY_ROUNDING_VARIANTS = [
  { buyCount: 1, expectedStoredShortfallQuanta: 1n },
  { buyCount: 4, expectedStoredShortfallQuanta: 2n },
  { buyCount: 8, expectedStoredShortfallQuanta: 4n },
] as const;

const QUANTITY_FLOAT_DIRECTION_REVERSAL = {
  name: 'readback direction reversal',
  rows: [
    { side: 'buy', quantity: 54_357_657.322581686 },
    { side: 'buy', quantity: 101_960_493.7435252 },
    { side: 'sell', quantity: 156_318_151.0661069 },
  ],
  expectedRawRemaining: 0,
  expectedStored: ['buy:54357657.32258169', 'buy:101960493.74352520', 'sell:156318151.06610690'],
} as const;

const QUANTITY_FLOAT_VARIANTS = [
  {
    name: 'high-magnitude cancellation',
    rows: [
      { side: 'buy', quantity: 999_999_999_999 },
      { side: 'buy', quantity: 0.00007 },
      { side: 'sell', quantity: 999_999_999_999 },
      { side: 'sell', quantity: 0.0001 },
    ],
    expectedRawRemaining: 0.000022070312499999995,
    expectedStored: [
      'buy:999999999999.00000000',
      'buy:0.00007000',
      'sell:999999999999.00000000',
      'sell:0.00010000',
    ],
  },
  {
    name: 'high-magnitude addition',
    rows: [
      { side: 'buy', quantity: 300_000_000_000.0004 },
      { side: 'buy', quantity: 300_000_000_000.01245 },
      { side: 'sell', quantity: 600_000_000_000.013 },
    ],
    expectedRawRemaining: 0,
    expectedStored: [
      'buy:300000000000.00040000',
      'buy:300000000000.01245000',
      'sell:600000000000.01300000',
    ],
  },
  QUANTITY_FLOAT_DIRECTION_REVERSAL,
] as const;

const TAX_REPLAY_DIRECTION_REVERSAL_PRICES = [
  1_000_000_000, 2_000_000_000, 1_652_262_664.624316,
] as const;

// Prefer FI for the FIFO integration regression: unlike DE, its normal engine
// has no saver-allowance that would mask this deliberately small €32 gain.
const TAX_REPLAY_COUNTRY_PREFERENCE = ['AT', 'FI', 'DE'] as const;
const TAX_REPLAY_COUNTRY_BY_STRATEGY = CUSTOM_COST_BASIS.map((strategy) => {
  const country = TAX_REPLAY_COUNTRY_PREFERENCE.find(
    (candidate) => costBasisStrategyForCountry(candidate) === strategy,
  );
  if (!country) throw new Error(`expected a country-specific ${strategy} tax strategy`);
  return { strategy, country };
});

function scale8Integer(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
}

function quantityRoundingVariantKey(buyCount: number, storedShortfallQuanta: bigint): string {
  return `buyCount=${buyCount},storedShortfallQuanta=${storedShortfallQuanta}`;
}

interface TaxSettingVariant {
  name: string;
  input: UpdateTaxSettingsRequest;
}

function taxSettingVariantsFor(mode: (typeof TAX_MODES)[number]): readonly TaxSettingVariant[] {
  switch (mode) {
    case 'none':
      return [{ name: mode, input: { mode } }];
    case 'manual_per_trade':
      return [
        { name: `${mode}:no-default`, input: { mode } },
        {
          name: `${mode}:amount-default`,
          input: { mode, manualDefaultAmountEur: 4.25 },
        },
        {
          name: `${mode}:rate-default`,
          input: { mode, manualDefaultRatePct: 12.5 },
        },
      ];
    case 'country_specific':
      return TAX_COUNTRIES.map((country) => ({
        name: `${mode}:${country}`,
        input: { mode, country },
      }));
    case 'custom':
      return CUSTOM_COST_BASIS.map((costBasis, index) => ({
        name: `${mode}:${costBasis}`,
        input: {
          mode,
          custom: {
            ratePct: 17.5,
            lossOffset: index % 2 === 0,
            refund: index % 2 === 1,
            yearReset: index % 2 === 0,
            carryForward: index % 2 === 1,
            costBasis,
          },
        },
      }));
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

/**
 * The tax validator has mode-dependent branches. Generate its normal persisted
 * variants from the exported mode/country/cost-basis vocabularies so adding a
 * normal capability enrolls it here without a hand-authored vault fixture.
 */
const TAX_SETTING_VARIANTS = TAX_MODES.flatMap(taxSettingVariantsFor);

const BOOLEAN_VARIANTS = [false, true] as const;
const ROW_LIFECYCLES = ['active', 'archived'] as const;

function portfolioVariantKey(
  visibility: string,
  defaultPayFromCash: boolean,
  lifecycle: (typeof ROW_LIFECYCLES)[number],
): string {
  return `visibility=${visibility},defaultPayFromCash=${defaultPayFromCash},lifecycle=${lifecycle}`;
}

function cashSourceVariantKey(type: string, lifecycle: (typeof ROW_LIFECYCLES)[number]): string {
  return `type=${type},lifecycle=${lifecycle}`;
}

function customAssetVariantKey(category: string, smoothing: boolean): string {
  return `category=${category},smoothing=${smoothing}`;
}

function expenseRuleVariantKey(matchType: string, enabled: boolean): string {
  return `matchType=${matchType},enabled=${enabled}`;
}

function objectField(value: unknown, key: string): unknown {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>)[key];
}

function frozenTaxVariantKey(
  name: string,
  data: {
    taxMode: string | null;
    taxCountry: string | null;
    taxParams: unknown;
  },
): string {
  return [
    name,
    `mode=${data.taxMode ?? 'null'}`,
    `country=${data.taxCountry ?? 'null'}`,
    `customCostBasis=${String(objectField(data.taxParams, 'costBasis') ?? 'null')}`,
  ].join(',');
}

function expectedFrozenTaxVariantKey(variant: TaxSettingVariant): string {
  const { input } = variant;
  return frozenTaxVariantKey(variant.name, {
    taxMode: input.mode,
    taxCountry: input.mode === 'country_specific' ? (input.country ?? null) : null,
    taxParams: input.mode === 'custom' ? input.custom : null,
  });
}

const REACHABLE_STATE_CASES: readonly ReachableStateCase[] = [
  {
    name: 'customAssetValue.close plus every strict-v1 normal-write entity',
    options: {
      taxNow: () => TEST_NOW,
      budgetNow: () => new Date(TEST_NOW),
    },
    async arrange(harness) {
      const user = await harness.seedUser();
      const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
      const custom = await harness.ctx.customAssets.create(user.id, {
        name: 'Conformance House',
        category: 'other',
        currency: 'EUR',
        smoothing: true,
        initialPurchase: {
          quantity: 1,
          price: 100,
          fee: 0,
          executedAt: '2026-07-20T10:00:00.000Z',
        },
      });
      await harness.ctx.customAssets.putValuePoints(user.id, custom.asset.id, [
        { date: '2026-07-20', value: 0 },
        { date: '2026-07-24', value: 123.456789 },
      ]);

      const deposit = await harness.ctx.portfolio.depositCash(user.id, portfolioId, {
        amountEur: 1_000,
        executedAt: '2026-07-20T09:00:00.000Z',
      });
      await harness.ctx.tax.updateSettings(user.id, {
        mode: 'manual_per_trade',
        manualDefaultRatePct: 10,
      });
      await harness.ctx.tax.setPortfolioTaxOverride(user.id, portfolioId, {
        mode: 'country_specific',
        country: 'AT',
      });
      await harness.ctx.tax.recordDividend(user.id, portfolioId, {
        assetId: custom.asset.id,
        grossAmountEur: 25,
        cashSourceId: deposit.movement.sourceId,
        executedAt: '2026-07-23T10:00:00.000Z',
      });

      await harness.ctx.standingOrders.create(user.id, {
        portfolioId,
        kind: 'cash-add',
        amount: 100,
        label: 'Conformance salary',
        cadence: 'daily',
        startDate: '2026-07-24',
      });
      await harness.ctx.standingOrders.processDueOrders({ now: TEST_NOW });

      const { category } = await harness.ctx.expenses.createCategory(user.id, {
        name: 'Conformance groceries',
        direction: 'expense',
        color: '#22c55e',
      });
      await harness.ctx.expenses.createTransaction(user.id, {
        categoryId: category.id,
        direction: 'expense',
        amount: 12.5,
        currency: 'EUR',
        bookedOn: '2026-07-24',
        description: 'Conformance market',
      });
      await harness.ctx.expenses.createRule(user.id, {
        categoryId: category.id,
        matchType: 'contains',
        pattern: 'market',
        priority: 7,
        enabled: true,
      });
      await harness.ctx.expenseBudgets.createBudget(user.id, {
        categoryId: category.id,
        amount: 10,
        currency: 'EUR',
      });

      await harness.ctx.imports.createBatch(user.id, {
        portfolioId,
        filename: 'conformance.csv',
        brokerId: 'trade_republic',
        content: [
          'Datum;Typ;Wertpapier;ISIN;Anzahl;Kurs;Gebühr;Betrag;Währung',
          '2026-07-24;Einzahlung;;;;;;25,00;EUR',
        ].join('\n'),
      });

      // Persist both derived snapshot kinds through the production engine. They
      // are purge-only on rehydration, but remain part of the strict document
      // and must survive request-schema + graph preflight validation.
      await harness.ctx.snapshots.recompute(portfolioId);

      return {
        userId: user.id,
        requireEveryStrictKind: true,
        focus(document) {
          return [
            {
              field: 'customAssetValue.close',
              value: entities(document, 'customAssetValue').map((entry) => entry.data.close),
            },
          ];
        },
      };
    },
  },
  {
    name: 'finite portfolio, cash, custom-asset, expense, and import vocabularies',
    options: {
      taxNow: () => TEST_NOW,
      budgetNow: () => new Date(TEST_NOW),
    },
    async arrange(harness) {
      const user = await harness.seedUser();
      const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);

      const portfolioVariantIds = new Set<string>();
      let variantIndex = 0;
      for (const visibility of portfolioVisibilitySchema.options) {
        for (const defaultPayFromCash of BOOLEAN_VARIANTS) {
          for (const lifecycle of ROW_LIFECYCLES) {
            const row = await harness.ctx.portfolio.createPortfolio(user.id, {
              name: `Portfolio variant ${variantIndex}`,
            });
            portfolioVariantIds.add(row.id);
            await harness.ctx.portfolio.updatePortfolio(user.id, row.id, {
              visibility,
              defaultPayFromCash,
            });
            if (lifecycle === 'archived') {
              await harness.ctx.portfolio.archivePortfolio(user.id, row.id);
            }
            variantIndex += 1;
          }
        }
      }

      const cashSourceVariantIds = new Set<string>();
      const activeCashSourceIds: string[] = [];
      for (const type of CASH_SOURCE_TYPES) {
        for (const lifecycle of ROW_LIFECYCLES) {
          const source = await harness.ctx.portfolio.createCashSource(user.id, portfolioId, {
            name: `Cash source ${type} ${lifecycle}`,
            type,
          });
          cashSourceVariantIds.add(source.id);
          if (lifecycle === 'archived') {
            await harness.ctx.portfolio.archiveCashSource(user.id, portfolioId, source.id);
          } else {
            activeCashSourceIds.push(source.id);
          }
        }
      }

      const customAssetVariantIds = new Set<string>();
      let importAsset:
        | Awaited<ReturnType<typeof harness.ctx.customAssets.create>>['asset']
        | undefined;
      for (const category of CUSTOM_ASSET_CATEGORIES) {
        for (const smoothing of BOOLEAN_VARIANTS) {
          const created = await harness.ctx.customAssets.create(user.id, {
            name: `Custom ${category} ${smoothing ? 'smooth' : 'raw'}`,
            category,
            currency: 'EUR',
            smoothing,
          });
          customAssetVariantIds.add(created.asset.id);
          importAsset ??= created.asset;
        }
      }
      if (!importAsset) throw new Error('expected a custom asset for finite-vocabulary writes');

      const categoryIdsByDirection = new Map<string, string>();
      for (const direction of EXPENSE_DIRECTIONS) {
        const { category } = await harness.ctx.expenses.createCategory(user.id, {
          name: `Expense direction ${direction}`,
          direction,
          color: direction === 'expense' ? '#ef4444' : '#22c55e',
        });
        categoryIdsByDirection.set(direction, category.id);
        await harness.ctx.expenses.createTransaction(user.id, {
          categoryId: category.id,
          direction,
          amount: 10,
          currency: 'EUR',
          bookedOn: '2026-07-20',
          description: `Categorized ${direction}`,
        });
        await harness.ctx.expenses.createTransaction(user.id, {
          direction,
          amount: 11,
          currency: 'EUR',
          bookedOn: '2026-07-21',
          description: `Uncategorized ${direction}`,
        });
      }
      const expenseCategoryId = categoryIdsByDirection.get('expense');
      if (!expenseCategoryId) throw new Error('expected an expense category');
      let ruleIndex = 0;
      for (const matchType of EXPENSE_RULE_MATCH_TYPES) {
        for (const enabled of BOOLEAN_VARIANTS) {
          await harness.ctx.expenses.createRule(user.id, {
            categoryId: expenseCategoryId,
            matchType,
            pattern: matchType === 'regex' ? '^market(?: place)?$' : 'market',
            priority: ruleIndex,
            enabled,
          });
          ruleIndex += 1;
        }
      }

      const main = (await harness.ctx.portfolio.listCashSources(user.id, portfolioId)).sources.find(
        (source) => source.isMain,
      );
      if (!main) throw new Error('expected the default Main cash source');
      const transferTargetId = activeCashSourceIds[0];
      if (!transferTargetId) throw new Error('expected an active secondary cash source');

      await harness.ctx.tax.updateSettings(user.id, {
        mode: 'country_specific',
        country: 'AT',
      });
      await harness.ctx.portfolio.depositCash(user.id, portfolioId, {
        sourceId: main.id,
        amountEur: 5_000,
        executedAt: '2026-01-01T10:00:00.000Z',
      });
      await harness.ctx.portfolio.withdrawCash(user.id, portfolioId, {
        sourceId: main.id,
        amountEur: 25,
        executedAt: '2026-01-02T10:00:00.000Z',
      });
      await harness.ctx.portfolio.transferCash(user.id, portfolioId, {
        fromSourceId: main.id,
        toSourceId: transferTargetId,
        amountEur: 100,
        executedAt: '2026-01-03T10:00:00.000Z',
      });
      await harness.ctx.portfolio.createTransactions(user.id, portfolioId, [
        {
          assetId: importAsset.id,
          side: 'buy',
          quantity: 100,
          price: 10,
          fee: 0,
          executedAt: '2026-01-04T10:00:00.000Z',
          payFromCash: true,
          cashSourceId: main.id,
        },
      ]);
      await harness.ctx.tax.recordDividend(user.id, portfolioId, {
        assetId: importAsset.id,
        grossAmountEur: 10,
        cashSourceId: main.id,
        executedAt: '2026-01-05T10:00:00.000Z',
      });
      await harness.ctx.portfolio.createTransactions(user.id, portfolioId, [
        {
          assetId: importAsset.id,
          side: 'sell',
          quantity: 50,
          price: 19,
          fee: 0,
          executedAt: '2026-01-06T10:00:00.000Z',
          addProceedsToCash: true,
          cashSourceId: main.id,
        },
      ]);
      await harness.ctx.portfolio.createTransactions(user.id, portfolioId, [
        {
          assetId: importAsset.id,
          side: 'sell',
          quantity: 50,
          price: 8,
          fee: 0,
          executedAt: '2026-01-07T10:00:00.000Z',
          addProceedsToCash: true,
          cashSourceId: main.id,
        },
      ]);

      const importCsv = [
        'Datum;Typ;Wertpapier;ISIN;Anzahl;Kurs;Gebühr;Betrag;Währung',
        '2026-06-01;Einzahlung;;;;;;2000,00;EUR',
        '2026-06-01;Einzahlung;;;;;;2000,00;EUR',
        `2026-06-02;Kauf;${importAsset.name};;10;10,00;0,00;-100,00;EUR`,
        `2026-06-03;Verkauf;${importAsset.name};;5;20,00;0,00;100,00;EUR`,
        `2026-06-04;Dividende;${importAsset.name};;;;;10,00;EUR`,
        '2026-06-05;Auszahlung;;;;;;50,00;EUR',
        '2026-06-06;Auszahlung;;;;;;999999,00;EUR',
        '2026-06-07;Kauf;Unknown Conformance Asset;;1;10,00;0,00;-10,00;EUR',
        '2026-06-08;Mystery;;;;;;10,00;EUR',
      ].join('\n');
      const appliedImport = await harness.ctx.imports.createBatch(user.id, {
        portfolioId,
        filename: 'finite-vocabularies.csv',
        brokerId: 'trade_republic',
        content: importCsv,
      });
      await harness.ctx.imports.applyBatch(user.id, appliedImport.batch.id, {});
      await harness.ctx.imports.createBatch(user.id, {
        portfolioId,
        filename: 'pending-vocabulary.csv',
        brokerId: 'trade_republic',
        content: [
          'Datum;Typ;Wertpapier;ISIN;Anzahl;Kurs;Gebühr;Betrag;Währung',
          '2026-06-09;Zinsen;;;;;;1,00;EUR',
        ].join('\n'),
      });

      return {
        userId: user.id,
        focus(document) {
          return [
            {
              field: 'finite portfolio/cash/custom/expense/import fields',
              value: document.entities
                .filter((entry) =>
                  [
                    'portfolio',
                    'cashSource',
                    'cashMovement',
                    'customAsset',
                    'expenseCategory',
                    'expenseTransaction',
                    'expenseRule',
                    'importBatch',
                    'importRow',
                  ].includes(entry.kind),
                )
                .map((entry) => ({ kind: entry.kind, data: entry.data })),
            },
          ];
        },
        variantDimensions(document) {
          return [
            {
              name: 'portfolio visibility/default/archive',
              expected: portfolioVisibilitySchema.options.flatMap((visibility) =>
                BOOLEAN_VARIANTS.flatMap((defaultPayFromCash) =>
                  ROW_LIFECYCLES.map((lifecycle) =>
                    portfolioVariantKey(visibility, defaultPayFromCash, lifecycle),
                  ),
                ),
              ),
              actual: entities(document, 'portfolio')
                .filter((entry) => portfolioVariantIds.has(entry.id))
                .map((entry) =>
                  portfolioVariantKey(
                    entry.data.visibility,
                    entry.data.defaultPayFromCash,
                    entry.data.archivedAt === null ? 'active' : 'archived',
                  ),
                ),
            },
            {
              name: 'cash-source type/archive',
              expected: CASH_SOURCE_TYPES.flatMap((type) =>
                ROW_LIFECYCLES.map((lifecycle) => cashSourceVariantKey(type, lifecycle)),
              ),
              actual: entities(document, 'cashSource')
                .filter((entry) => cashSourceVariantIds.has(entry.id))
                .map((entry) =>
                  cashSourceVariantKey(
                    entry.data.type,
                    entry.data.archivedAt === null ? 'active' : 'archived',
                  ),
                ),
            },
            {
              name: 'cash-movement kind',
              expected: cashMovementKindSchema.options,
              actual: entities(document, 'cashMovement').map((entry) => entry.data.kind),
            },
            {
              name: 'custom-asset category/smoothing',
              expected: CUSTOM_ASSET_CATEGORIES.flatMap((category) =>
                BOOLEAN_VARIANTS.map((smoothing) => customAssetVariantKey(category, smoothing)),
              ),
              actual: entities(document, 'customAsset')
                .filter((entry) => customAssetVariantIds.has(entry.id))
                .map((entry) =>
                  customAssetVariantKey(
                    String(objectField(entry.data.meta, 'category')),
                    objectField(entry.data.meta, 'smoothing') === true,
                  ),
                ),
            },
            {
              name: 'expense category direction',
              expected: EXPENSE_DIRECTIONS,
              actual: entities(document, 'expenseCategory').map((entry) => entry.data.direction),
            },
            {
              name: 'expense transaction direction',
              expected: EXPENSE_DIRECTIONS,
              actual: entities(document, 'expenseTransaction').map((entry) => entry.data.direction),
            },
            {
              name: 'expense transaction category nullable branch',
              expected: ['categorized', 'uncategorized'],
              actual: entities(document, 'expenseTransaction').map((entry) =>
                entry.data.categoryId === null ? 'uncategorized' : 'categorized',
              ),
            },
            {
              name: 'expense-rule match-type/enabled',
              expected: EXPENSE_RULE_MATCH_TYPES.flatMap((matchType) =>
                BOOLEAN_VARIANTS.map((enabled) => expenseRuleVariantKey(matchType, enabled)),
              ),
              actual: entities(document, 'expenseRule').map((entry) =>
                expenseRuleVariantKey(entry.data.matchType, entry.data.enabled),
              ),
            },
            {
              name: 'import-batch status',
              expected: IMPORT_BATCH_STATUSES,
              actual: entities(document, 'importBatch').map((entry) => entry.data.status),
            },
            {
              name: 'import-row kind',
              expected: IMPORT_ROW_KINDS,
              actual: entities(document, 'importRow').flatMap((entry) =>
                entry.data.kind === null ? [] : [entry.data.kind],
              ),
            },
            {
              name: 'import-row flag',
              expected: IMPORT_ROW_FLAGS,
              actual: entities(document, 'importRow').map((entry) => entry.data.flag),
            },
            {
              name: 'import-row apply result',
              expected: IMPORT_ROW_RESULTS,
              actual: entities(document, 'importRow').flatMap((entry) =>
                entry.data.result === null ? [] : [entry.data.result],
              ),
            },
          ];
        },
      };
    },
  },
  {
    name: 'standingOrder kind/cadence/asset/anchor/endDate combinations',
    async arrange(harness) {
      const user = await harness.seedUser();
      const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
      const custom = await harness.ctx.customAssets.create(user.id, {
        name: 'Standing-order asset',
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
              amount: 10 + index,
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
          return [
            {
              field: 'standingOrder.{kind,assetId,cadence,anchorDay,startDate,endDate,status}',
              value: entities(document, 'standingOrder').map((entry) => ({
                kind: entry.data.kind,
                assetId: entry.data.assetId,
                cadence: entry.data.cadence,
                anchorDay: entry.data.anchorDay,
                startDate: entry.data.startDate,
                endDate: entry.data.endDate,
                status: entry.data.status,
              })),
            },
          ];
        },
        variantDimensions(document) {
          return [
            {
              name: 'standing-order kind/cadence/status',
              expected: STANDING_ORDER_KINDS.flatMap((kind) =>
                STANDING_ORDER_CADENCES.flatMap((cadence) =>
                  STANDING_ORDER_STATUSES.map(
                    (status) => `kind=${kind},cadence=${cadence},status=${status}`,
                  ),
                ),
              ),
              actual: entities(document, 'standingOrder').map(
                (entry) =>
                  `kind=${entry.data.kind},cadence=${entry.data.cadence},status=${entry.data.status}`,
              ),
            },
          ];
        },
      };
    },
  },
  {
    name: 'transaction side/allowUncovered/uncoveredEntryPrice schema-valid combinations',
    options: { taxNow: () => TEST_NOW },
    async arrange(harness) {
      const user = await harness.seedUser();
      const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
      const custom = await harness.ctx.customAssets.create(user.id, {
        name: 'Uncovered branch matrix',
        category: 'other',
        currency: 'EUR',
        smoothing: false,
      });

      await harness.ctx.portfolio.createTransactions(
        user.id,
        portfolioId,
        TRANSACTION_VALIDATION_VARIANTS.map((variant, index) => ({
          assetId: custom.asset.id,
          side: variant.side,
          // The covered sell consumes one share. Acknowledged sells deliberately
          // exceed the remainder (and then sell from zero) so these are genuine
          // normal-path uncovered states rather than merely true flags.
          quantity: variant.side === 'buy' ? 10 : variant.allowUncovered ? 20 : 1,
          price: 10 + index,
          fee: 0,
          executedAt: `2026-07-20T10:0${index}:00.000Z`,
          allowUncovered: variant.allowUncovered,
          ...(variant.uncoveredEntryPrice === undefined
            ? {}
            : { uncoveredEntryPrice: variant.uncoveredEntryPrice }),
        })),
      );

      return {
        userId: user.id,
        focus(document) {
          return [
            {
              field: 'transaction.{side,allowUncovered,uncoveredEntryPrice}',
              value: entities(document, 'transaction').map((entry) => ({
                side: entry.data.side,
                allowUncovered: entry.data.allowUncovered,
                uncoveredEntryPrice: entry.data.uncoveredEntryPrice,
              })),
            },
          ];
        },
        variantDimensions(document) {
          return [
            {
              name: 'transaction uncovered-field',
              expected: TRANSACTION_VALIDATION_VARIANTS.map((variant) =>
                transactionVariantKey({
                  ...variant,
                  uncoveredEntryPrice: variant.uncoveredEntryPrice,
                }),
              ),
              actual: entities(document, 'transaction').map((entry) =>
                transactionVariantKey(entry.data),
              ),
            },
          ];
        },
      };
    },
  },
  {
    name: 'transaction.quantity cumulative scale-8 rounding envelope',
    options: { taxNow: () => TEST_NOW },
    async arrange(harness) {
      const user = await harness.seedUser();
      const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
      const arrangedAssets: { assetId: string; buyCount: number }[] = [];

      for (const variant of QUANTITY_ROUNDING_VARIANTS) {
        const custom = await harness.ctx.customAssets.create(user.id, {
          name: `Quantity boundary ${variant.buyCount}`,
          category: 'other',
          currency: 'EUR',
          smoothing: false,
        });
        arrangedAssets.push({ assetId: custom.asset.id, buyCount: variant.buyCount });
        await harness.ctx.portfolio.createTransactions(user.id, portfolioId, [
          ...Array.from({ length: variant.buyCount }, (_, index) => ({
            assetId: custom.asset.id,
            side: 'buy' as const,
            quantity: QUANTITY_ROUNDING_BUY,
            price: 10,
            fee: 0,
            executedAt: `2026-07-23T10:${index.toString().padStart(2, '0')}:00.000Z`,
          })),
          {
            assetId: custom.asset.id,
            side: 'sell',
            // The raw sell exceeds the accumulated raw buys by only 5e-10,
            // below QTY_EPSILON. Independent scale-8 storage rounding widens
            // the persisted shortfall as the batch grows.
            quantity: variant.buyCount * QUANTITY_ROUNDING_BUY + 0.0000000005,
            price: 11,
            fee: 0,
            executedAt: `2026-07-23T10:${variant.buyCount.toString().padStart(2, '0')}:00.000Z`,
          },
        ]);
      }

      return {
        userId: user.id,
        focus(document) {
          return [
            {
              field: 'transaction.quantity',
              value: arrangedAssets.map(({ assetId }) =>
                entities(document, 'transaction')
                  .filter((entry) => entry.data.assetId === assetId)
                  .map((entry) => ({
                    side: entry.data.side,
                    quantity: entry.data.quantity,
                  })),
              ),
            },
          ];
        },
        variantDimensions(document) {
          return [
            {
              name: 'transaction accumulated quantity-rounding',
              expected: QUANTITY_ROUNDING_VARIANTS.map((variant) =>
                quantityRoundingVariantKey(variant.buyCount, variant.expectedStoredShortfallQuanta),
              ),
              actual: arrangedAssets.map(({ assetId }) => {
                const assetTransactions = entities(document, 'transaction').filter(
                  (entry) => entry.data.assetId === assetId,
                );
                const buys = assetTransactions.filter((entry) => entry.data.side === 'buy');
                const sell = assetTransactions.find((entry) => entry.data.side === 'sell');
                if (!sell) throw new Error(`expected quantity-boundary sell for ${assetId}`);
                const persistedBuys = buys.reduce(
                  (total, entry) => total + scale8Integer(entry.data.quantity),
                  0n,
                );
                return quantityRoundingVariantKey(
                  buys.length,
                  scale8Integer(sell.data.quantity) - persistedBuys,
                );
              }),
            },
          ];
        },
      };
    },
  },
  ...QUANTITY_FLOAT_VARIANTS.map(
    (variant): ReachableStateCase => ({
      name: `transaction.quantity IEEE-754 ${variant.name}`,
      options: { taxNow: () => TEST_NOW },
      async arrange(harness) {
        const user = await harness.seedUser();
        const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
        const custom = await harness.ctx.customAssets.create(user.id, {
          name: `Quantity ${variant.name}`,
          category: 'other',
          currency: 'EUR',
          smoothing: false,
        });
        const inputs = variant.rows.map((row, index) => ({
          assetId: custom.asset.id,
          side: row.side,
          quantity: row.quantity,
          price: 10,
          fee: 0,
          executedAt: `2026-07-23T11:${index.toString().padStart(2, '0')}:00.000Z`,
        }));

        expect(
          reducePosition(inputs).quantity,
          `${variant.name} must remain reachable under the normal IEEE-754 reducer`,
        ).toBe(variant.expectedRawRemaining);
        await harness.ctx.portfolio.createTransactions(user.id, portfolioId, inputs);

        return {
          userId: user.id,
          focus(document) {
            return [
              {
                field: 'transaction.quantity',
                value: entities(document, 'transaction')
                  .filter((entry) => entry.data.assetId === custom.asset.id)
                  .map((entry) => ({
                    side: entry.data.side,
                    quantity: entry.data.quantity,
                  })),
              },
            ];
          },
          variantDimensions(document) {
            const actual = entities(document, 'transaction')
              .filter((entry) => entry.data.assetId === custom.asset.id)
              .sort(
                (a, b) =>
                  Date.parse(a.data.executedAt) - Date.parse(b.data.executedAt) ||
                  a.id.localeCompare(b.id),
              )
              .map((entry) => `${entry.data.side}:${entry.data.quantity}`);
            return [
              {
                name: `${variant.name} persisted quantity`,
                expected: variant.expectedStored,
                actual,
              },
            ];
          },
        };
      },
    }),
  ),
  {
    name: 'cashMovement.amountEur on a detached MIRRORCHAIN overdrawn fork',
    options: { taxNow: () => TEST_NOW },
    async arrange(harness) {
      const alice = await harness.seedUser({
        email: 'conformance-mirror-owner@bettertrack.test',
        username: 'conformance-mirror-owner',
      });
      const bob = await harness.seedUser({
        email: 'conformance-mirror-member@bettertrack.test',
        username: 'conformance-mirror-member',
      });
      const { row: asset } = await createAssetRepository(harness.db).upsertGlobal({
        providerId: 'test',
        providerRef: 'CONFORMANCE-MIRROR.EUR',
        type: 'stock',
        symbol: 'CMIR',
        name: 'Conformance mirror asset',
        exchange: null,
        currency: 'EUR',
      });

      const alicePortfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(alice.id);
      const { chain } = await harness.ctx.mirror.convertToChain(alice.id, alicePortfolioId, {
        name: 'Conformance family',
      });
      const { portfolioId: bobForkId } = await harness.ctx.mirror.attachMemberCopy(
        chain.id,
        bob.id,
      );
      await harness.ctx.mirror.replicateChain(chain.id);
      await harness.ctx.tax.updateSettings(bob.id, {
        mode: 'country_specific',
        country: 'AT',
      });

      await harness.ctx.mirror.submitTransactionsCreate(alice.id, alicePortfolioId, [
        {
          assetId: asset.id,
          side: 'buy',
          quantity: 1,
          price: 10,
          fee: 0,
          executedAt: '2026-07-22T10:00:00.000Z',
        },
      ]);
      await harness.ctx.mirror.replicateChain(chain.id);

      const aliceMain = (
        await harness.ctx.portfolio.listCashSources(alice.id, alicePortfolioId)
      ).sources.find((source) => source.isMain);
      if (!aliceMain) throw new Error('expected owner Main cash source');
      await harness.ctx.mirror.submitDividendRecord(alice.id, alicePortfolioId, {
        assetId: asset.id,
        grossAmountEur: 100,
        cashSourceId: aliceMain.id,
        executedAt: '2026-07-23T10:00:00.000Z',
      });
      await harness.ctx.mirror.replicateChain(chain.id);
      await harness.ctx.mirror.submitCashWithdraw(alice.id, alicePortfolioId, {
        sourceId: aliceMain.id,
        amountEur: 100,
        executedAt: '2026-07-24T10:00:00.000Z',
      });
      await harness.ctx.mirror.replicateChain(chain.id);
      expect((await harness.ctx.portfolio.getCashMovements(bob.id, bobForkId)).balanceEur).toBe(
        -27.5,
      );

      await harness.ctx.mirror.removeMember(alice.id, chain.id, bob.id);
      await expect(harness.ctx.mirror.syncedMembership(bobForkId)).resolves.toBeNull();

      return {
        userId: bob.id,
        focus(document) {
          return [
            {
              field: 'cashMovement.amountEur[source=sync:mirrorchain]',
              value: entities(document, 'cashMovement')
                .filter((entry) => entry.data.source === SOURCE_TAG_SYNC_MIRRORCHAIN)
                .map((entry) => entry.data.amountEur),
            },
            { field: 'cashSource.balanceEur', value: -27.5 },
          ];
        },
        async verifyRestored(restoredHarness) {
          expect(
            (await restoredHarness.ctx.portfolio.getCashMovements(bob.id, bobForkId)).balanceEur,
          ).toBe(-27.5);
          await expect(restoredHarness.ctx.mirror.syncedMembership(bobForkId)).resolves.toBeNull();
        },
      };
    },
  },
  {
    name: 'cashMovement manual debit exposed by a MIRRORCHAIN force-delete',
    options: { taxNow: () => TEST_NOW },
    async arrange(harness) {
      const alice = await harness.seedUser({
        email: 'conformance-mirror-delete-owner@bettertrack.test',
        username: 'conformance-mirror-delete-owner',
      });
      const bob = await harness.seedUser({
        email: 'conformance-mirror-delete-member@bettertrack.test',
        username: 'conformance-mirror-delete-member',
      });
      const { row: asset } = await createAssetRepository(harness.db).upsertGlobal({
        providerId: 'test',
        providerRef: 'CONFORMANCE-MIRROR-DELETE.EUR',
        type: 'stock',
        symbol: 'CMRD',
        name: 'Conformance mirror delete asset',
        exchange: null,
        currency: 'EUR',
      });
      const alicePortfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(alice.id);
      const { chain } = await harness.ctx.mirror.convertToChain(alice.id, alicePortfolioId, {
        name: 'Conformance delete family',
      });
      const { portfolioId: bobForkId } = await harness.ctx.mirror.attachMemberCopy(
        chain.id,
        bob.id,
      );
      await harness.ctx.mirror.replicateChain(chain.id);
      await harness.ctx.tax.updateSettings(bob.id, {
        mode: 'country_specific',
        country: 'AT',
      });
      await harness.ctx.mirror.submitTransactionsCreate(alice.id, alicePortfolioId, [
        {
          assetId: asset.id,
          side: 'buy',
          quantity: 1,
          price: 10,
          fee: 0,
          executedAt: '2026-07-20T10:00:00.000Z',
        },
      ]);
      await harness.ctx.mirror.replicateChain(chain.id);

      const aliceMain = (
        await harness.ctx.portfolio.listCashSources(alice.id, alicePortfolioId)
      ).sources.find((source) => source.isMain);
      if (!aliceMain) throw new Error('expected owner Main cash source');
      const firstDividend = await harness.ctx.mirror.submitDividendRecord(
        alice.id,
        alicePortfolioId,
        {
          assetId: asset.id,
          grossAmountEur: 100,
          cashSourceId: aliceMain.id,
          executedAt: '2026-07-21T10:00:00.000Z',
        },
      );
      await harness.ctx.mirror.submitDividendRecord(alice.id, alicePortfolioId, {
        assetId: asset.id,
        grossAmountEur: 100,
        cashSourceId: aliceMain.id,
        executedAt: '2026-07-22T10:00:00.000Z',
      });
      await harness.ctx.mirror.replicateChain(chain.id);

      const bobMain = (await harness.ctx.portfolio.listCashSources(bob.id, bobForkId)).sources.find(
        (source) => source.isMain,
      );
      if (!bobMain) throw new Error('expected member Main cash source');
      const withdrawal = await harness.ctx.mirror.submitCashWithdraw(bob.id, bobForkId, {
        sourceId: bobMain.id,
        amountEur: 80,
        executedAt: '2026-07-23T10:00:00.000Z',
      });
      await harness.ctx.mirror.replicateChain(chain.id);
      expect((await harness.ctx.portfolio.getCashMovements(bob.id, bobForkId)).balanceEur).toBe(65);

      // Alice's untaxed copy can delete one EUR 100 dividend and remain at EUR
      // 20. Replica force mode applies that deletion to Bob's Austrian copy,
      // where the surviving local-origin withdrawal becomes the first negative
      // prefix (EUR 72.50 - EUR 80 = EUR -7.50).
      await harness.ctx.mirror.submitDividendDelete(
        alice.id,
        alicePortfolioId,
        firstDividend.dividend.id,
      );
      await harness.ctx.mirror.replicateChain(chain.id);
      expect(
        (await harness.ctx.portfolio.getCashMovements(alice.id, alicePortfolioId)).balanceEur,
      ).toBe(20);
      expect((await harness.ctx.portfolio.getCashMovements(bob.id, bobForkId)).balanceEur).toBe(
        -7.5,
      );

      await harness.ctx.mirror.removeMember(alice.id, chain.id, bob.id);
      await expect(harness.ctx.mirror.syncedMembership(bobForkId)).resolves.toBeNull();

      return {
        userId: bob.id,
        focus(document) {
          const restoredWithdrawal = entities(document, 'cashMovement').find(
            (entry) => entry.id === withdrawal.movement.id,
          );
          return [
            {
              field: `cashMovement[${withdrawal.movement.id}].amountEur`,
              value: restoredWithdrawal?.data.amountEur,
            },
            { field: 'cashSource.balanceEur', value: -7.5 },
          ];
        },
        async verifyRestored(restoredHarness) {
          expect(
            (await restoredHarness.ctx.portfolio.getCashMovements(bob.id, bobForkId)).balanceEur,
          ).toBe(-7.5);
          await expect(restoredHarness.ctx.mirror.syncedMembership(bobForkId)).resolves.toBeNull();
        },
      };
    },
  },
  {
    name: 'frozen tax facts plus float/storage reversal through moving-average and FIFO replay',
    options: { taxNow: () => TEST_NOW },
    async arrange(harness) {
      const user = await harness.seedUser();
      await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
      const custom = await harness.ctx.customAssets.create(user.id, {
        name: 'Frozen-tax conformance asset',
        category: 'stock',
        currency: 'EUR',
        smoothing: false,
      });
      const portfolioByVariant = new Map<string, string>();
      const strategyByPortfolio = new Map<string, (typeof CUSTOM_COST_BASIS)[number]>();

      for (const [index, variant] of TAX_SETTING_VARIANTS.entries()) {
        const portfolio = await harness.ctx.portfolio.createPortfolio(user.id, {
          name: `Frozen tax ${index}`,
        });
        portfolioByVariant.set(variant.name, portfolio.id);
        await harness.ctx.tax.setPortfolioTaxOverride(user.id, portfolio.id, variant.input);
        await harness.ctx.portfolio.depositCash(user.id, portfolio.id, {
          amountEur: 1_000,
          executedAt: '2025-02-01T09:00:00.000Z',
        });

        const replayStrategy = TAX_REPLAY_COUNTRY_BY_STRATEGY.find(
          ({ country }) =>
            variant.input.mode === 'country_specific' && variant.input.country === country,
        )?.strategy;
        if (replayStrategy) {
          strategyByPortfolio.set(portfolio.id, replayStrategy);
          const inputs = QUANTITY_FLOAT_DIRECTION_REVERSAL.rows.map((row, rowIndex) => ({
            assetId: custom.asset.id,
            side: row.side,
            quantity: row.quantity,
            price: TAX_REPLAY_DIRECTION_REVERSAL_PRICES[rowIndex]!,
            fee: 0,
            executedAt: `2025-02-0${rowIndex + 2}T10:00:00.000Z`,
          }));
          expect(
            reducePosition(inputs).quantity,
            `${replayStrategy} tax-replay case must be reachable under the normal reducer`,
          ).toBe(0);
          await harness.ctx.portfolio.createTransactions(user.id, portfolio.id, inputs);
        } else {
          await harness.ctx.portfolio.createTransactions(user.id, portfolio.id, [
            {
              assetId: custom.asset.id,
              side: 'buy',
              quantity: 10,
              price: 10,
              fee: 0,
              executedAt: '2026-02-02T10:00:00.000Z',
            },
          ]);
          await harness.ctx.portfolio.createTransactions(user.id, portfolio.id, [
            {
              assetId: custom.asset.id,
              side: 'sell',
              quantity: 5,
              price: 20,
              fee: 0,
              executedAt: '2026-02-03T10:00:00.000Z',
            },
          ]);
        }
        await harness.ctx.tax.recordDividend(user.id, portfolio.id, {
          assetId: custom.asset.id,
          grossAmountEur: 10,
          executedAt: replayStrategy ? '2025-02-05T10:00:00.000Z' : '2026-02-05T10:00:00.000Z',
        });
      }

      return {
        userId: user.id,
        focus(document) {
          return [
            {
              field: 'transaction/dividend frozen tax facts',
              value: [...portfolioByVariant].map(([name, portfolioId]) => ({
                name,
                transactions: entities(document, 'transaction')
                  .filter((entry) => entry.data.portfolioId === portfolioId)
                  .map((entry) => entry.data),
                dividends: entities(document, 'dividend')
                  .filter((entry) => entry.data.portfolioId === portfolioId)
                  .map((entry) => entry.data),
              })),
            },
          ];
        },
        variantDimensions(document) {
          const expectedFrozenVariants = TAX_SETTING_VARIANTS.map(expectedFrozenTaxVariantKey);
          return [
            {
              name: 'transaction frozen-tax mode/country/custom-cost-basis',
              expected: expectedFrozenVariants,
              actual: [...portfolioByVariant].map(([name, portfolioId]) => {
                const sell = entities(document, 'transaction').find(
                  (entry) => entry.data.portfolioId === portfolioId && entry.data.side === 'sell',
                );
                if (!sell) throw new Error(`expected a frozen-tax sell for ${name}`);
                return frozenTaxVariantKey(name, sell.data);
              }),
            },
            {
              name: 'dividend frozen-tax mode/country/custom-cost-basis',
              expected: expectedFrozenVariants,
              actual: [...portfolioByVariant].map(([name, portfolioId]) => {
                const dividend = entities(document, 'dividend').find(
                  (entry) => entry.data.portfolioId === portfolioId,
                );
                if (!dividend) throw new Error(`expected a frozen-tax dividend for ${name}`);
                return frozenTaxVariantKey(name, dividend.data);
              }),
            },
            {
              name: 'float/storage direction reversal in every cost-basis replay strategy',
              expected: TAX_REPLAY_COUNTRY_BY_STRATEGY.map(
                ({ strategy }) =>
                  `${strategy}:${QUANTITY_FLOAT_DIRECTION_REVERSAL.expectedStored.join('|')}`,
              ),
              actual: [...strategyByPortfolio].map(([portfolioId, strategy]) => {
                const persisted = entities(document, 'transaction')
                  .filter((entry) => entry.data.portfolioId === portfolioId)
                  .sort(
                    (a, b) =>
                      Date.parse(a.data.executedAt) - Date.parse(b.data.executedAt) ||
                      a.id.localeCompare(b.id),
                  )
                  .map((entry) => `${entry.data.side}:${entry.data.quantity}`);
                return `${strategy}:${persisted.join('|')}`;
              }),
            },
          ];
        },
      };
    },
  },
  ...TAX_SETTING_VARIANTS.map(
    (variant): ReachableStateCase => ({
      name: `taxSetting/portfolioSetting normal mode variant ${variant.name}`,
      options: { taxNow: () => TEST_NOW },
      async arrange(harness) {
        const user = await harness.seedUser();
        const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
        await harness.ctx.tax.updateSettings(user.id, variant.input);
        await harness.ctx.tax.setPortfolioTaxOverride(user.id, portfolioId, variant.input);

        return {
          userId: user.id,
          focus(document) {
            return [
              {
                field: 'taxSetting mode-dependent fields',
                value: entities(document, 'taxSetting').map((entry) => entry.data),
              },
              {
                field: 'portfolioSetting[key=tax].value',
                value: entities(document, 'portfolioSetting')
                  .filter((entry) => entry.data.key === 'tax')
                  .map((entry) => entry.data.value),
              },
            ];
          },
        };
      },
    }),
  ),
];

describe('paranoid rehydration normal-write differential conformance', () => {
  it.each(REACHABLE_STATE_CASES)('$name', async (testCase) => {
    await expectReachableStateRoundTrip(testCase);
  });

  it('reports the rejected field/value and writes zero rows for an invalid complete graph', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
    const custom = await harness.ctx.customAssets.create(user.id, {
      name: 'Invalid close probe',
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
    const focus = [{ field: 'customAssetValue.close', value: value.data.close }] as const;

    await replaceNormalRowsWithServerVault(harness, user.id);
    // Validation must reject before the mutation transaction is even opened.
    // Observing this boundary distinguishes "no attempted write" from writes
    // that happened inside a transaction and disappeared only after rollback.
    const mutationTransaction = vi.spyOn(harness.db, 'transaction');
    const stages: ParanoidRehydrationStage[] = [];
    let rejection: unknown;
    let rejected: Error | undefined;
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
      rejected = conformanceFailure('invalid complete graph', sourceDocument, focus, error);
    }

    expect(rejection).toMatchObject({
      code: 'INVALID_REFERENCE',
      message: expect.stringMatching(/custom-asset close/i),
    });
    expect(rejected?.message).toMatch(
      /rejected field\/value: .*customAssetValue\[[^\]]+\]\.close="-1"/,
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
