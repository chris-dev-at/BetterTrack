import type {
  ParanoidDisableRehydrationRequest,
  ParanoidDisableRehydrationResult,
  ParanoidRehydrationPostCommitPlan,
} from '@bettertrack/contracts';
import {
  customTaxParamsSchema,
  paranoidDisableRehydrationRequestSchema,
  SOURCE_TAG_SYNC_MIRRORCHAIN,
  taxSettingsResponseSchema,
  updateTaxSettingsRequestSchema,
} from '@bettertrack/contracts';
import { CASH_MOVEMENT_SIGN } from '@bettertrack/domain/cashLedger';
import { viennaYearOf } from '@bettertrack/domain/tax';

import type { Database } from '../../data/db';
import {
  createExpenseBudgetRepository,
  createExpenseCategoryRepository,
  createExpenseRuleRepository,
  createExpenseTransactionRepository,
} from '../../data/repositories/expenseRepository';
import {
  createParanoidRehydrationSourceRepository,
  type ParanoidRehydrationSourceRepository,
} from '../../data/repositories/paranoidRehydrationRepository';
import {
  createParanoidRehydrationTransactionRepository,
  withParanoidRehydrationTransaction,
} from '../../data/repositories/paranoidVaultRepository';
import { createExpenseBudgetService } from '../expenses/budgetService';
import { createExpenseService } from '../expenses/expenseService';
import type { NotificationCenter } from '../notifications/notificationCenter';
import { replayRestoredTaxState } from '../tax/replay';

/**
 * Dedicated normal-write transaction seam for PD3a. It validates the complete
 * restore-source document, delegates tax and expense reconstruction to their
 * transaction-bound service seams, and commits every source row plus transition
 * receipt in one transaction. Effectful public write paths are never called.
 * PD3b owns public routing and execution of the returned post-commit plan.
 */

const POST_COMMIT: ParanoidRehydrationPostCommitPlan = {
  invalidate: ['account', 'portfolio', 'expenses', 'standingOrders', 'tax'],
};

/** Rehydration must never emit while its database transaction is open. */
const NO_REHYDRATION_NOTIFICATIONS: NotificationCenter = {
  async emit() {
    throw new Error('rehydration attempted to emit a notification inside its transaction');
  },
};

export class ParanoidRehydrationError extends Error {
  constructor(
    readonly code:
      | 'ACCOUNT_NOT_FOUND'
      | 'NOT_PARANOID'
      | 'REHYDRATION_CONFLICT'
      | 'INVALID_REFERENCE'
      | 'INVALID_CASH_LEDGER'
      | 'INJECTED_FAILURE',
    message: string,
  ) {
    super(message);
    this.name = 'ParanoidRehydrationError';
  }
}

export interface ParanoidRehydrationServiceDeps {
  db: Database;
  now?: () => Date;
  /** Converts native amounts during tax-state replay at the historical day. */
  toCashEur?: (amount: number, currency: string, day: string) => Promise<number>;
  /** Test-only stage hook proving each transaction-stage rolls back completely. */
  afterStage?: (stage: ParanoidRehydrationStage) => void | Promise<void>;
}

export type ParanoidRehydrationStage =
  | 'customAssets'
  | 'portfolios'
  | 'cashSources'
  | 'taxSettings'
  | 'portfolioSettings'
  | 'transactions'
  | 'dividends'
  | 'cashMovements'
  | 'taxReplay'
  | 'standingOrders'
  | 'expenseCategories'
  | 'expenseTransactions'
  | 'expenseRules'
  | 'expenseBudgets'
  | 'normalMode'
  | 'ciphertextDeleted'
  | 'finish';

export interface ParanoidRehydrationService {
  rehydrate(
    userId: string,
    request: ParanoidDisableRehydrationRequest,
  ): Promise<ParanoidDisableRehydrationResult>;
}

type Entity = ParanoidDisableRehydrationRequest['document']['entities'][number];
type EntityOf<K extends Entity['kind']> = Extract<Entity, { kind: K }>;

interface ExactDecimal {
  coefficient: bigint;
  scale: number;
}

const DECIMAL_PATTERN = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/;
const pow10 = (scale: number): bigint => 10n ** BigInt(scale);
/**
 * Normal batch validation runs against the unrounded client quantities with a
 * 1e-9 epsilon, then PostgreSQL rounds each row independently to scale 8. Two
 * epsilon-valid inputs can therefore persist one scale-8 quantum apart.
 */
const PERSISTED_QUANTITY_ROUNDING_TOLERANCE = 1n;

function exactDecimal(value: string, label: string): ExactDecimal {
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) {
    throw new ParanoidRehydrationError('INVALID_REFERENCE', `${label} is not a decimal`);
  }
  const fraction = match[3] ?? '';
  const magnitude = BigInt(`${match[2]}${fraction}`);
  return {
    coefficient: match[1] === '-' ? -magnitude : magnitude,
    scale: fraction.length,
  };
}

/**
 * Convert one persisted PostgreSQL numeric to a fixed-scale integer without
 * crossing IEEE-754. Values that PostgreSQL would round or overflow are
 * rejected before the restore transaction instead of being silently changed.
 */
function persistedNumeric(value: string, precision: number, scale: number, label: string): bigint {
  const decimal = exactDecimal(value, label);
  if (decimal.scale > scale) {
    throw new ParanoidRehydrationError('INVALID_REFERENCE', `${label} exceeds its persisted scale`);
  }
  const integerDigits = value.replace(/^-/, '').split('.')[0]!.replace(/^0+/, '');
  if (integerDigits.length > precision - scale) {
    throw new ParanoidRehydrationError(
      'INVALID_REFERENCE',
      `${label} exceeds its persisted precision`,
    );
  }
  return decimal.coefficient * pow10(scale - decimal.scale);
}

function requirePositive(value: bigint, label: string): void {
  if (value <= 0n) {
    throw new ParanoidRehydrationError('INVALID_REFERENCE', `${label} must be positive`);
  }
}

function requireNonnegative(value: bigint, label: string): void {
  if (value < 0n) {
    throw new ParanoidRehydrationError('INVALID_REFERENCE', `${label} must not be negative`);
  }
}

function requirePostgresInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
    throw new ParanoidRehydrationError(
      'INVALID_REFERENCE',
      `${label} exceeds the PostgreSQL integer range`,
    );
  }
}

const POSTGRES_DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function requirePostgresDate(value: string, label: string): void {
  const match = POSTGRES_DAY_PATTERN.exec(value);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  if (
    !match ||
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (daysInMonth[month - 1] ?? 0)
  ) {
    throw new ParanoidRehydrationError(
      'INVALID_REFERENCE',
      `${label} is not a valid PostgreSQL calendar date`,
    );
  }
}

function rows<K extends Entity['kind']>(
  entities: readonly Entity[],
  kind: K,
): readonly EntityOf<K>[] {
  return entities.filter((entity): entity is EntityOf<K> => entity.kind === kind);
}

function liveEntities(document: ParanoidDisableRehydrationRequest['document']): readonly Entity[] {
  return document.entities.filter((entity) => entity.deletedAt === null);
}

function ids<K extends Entity['kind']>(entities: readonly Entity[], kind: K): Set<string> {
  return new Set(rows(entities, kind).map((entity) => entity.id));
}

const RESTORED_ID_KINDS = [
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
] as const satisfies readonly Entity['kind'][];

function validateUniqueRestoredIds(entities: readonly Entity[]): void {
  for (const kind of RESTORED_ID_KINDS) {
    const seen = new Set<string>();
    for (const entity of rows(entities, kind)) {
      if (seen.has(entity.id)) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          `${kind} persisted ids must be unique`,
        );
      }
      seen.add(entity.id);
    }
  }
}

function requireSubset(
  candidate: Iterable<string>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const id of candidate) {
    if (!allowed.has(id)) {
      throw new ParanoidRehydrationError('INVALID_REFERENCE', `${label} references missing ${id}`);
    }
  }
}

/** Portfolio tax overrides are stored in response shape but obey request invariants. */
function validTaxOverride(value: unknown): boolean {
  const stored = taxSettingsResponseSchema.safeParse(value);
  if (!stored.success) return false;
  const normalized = {
    mode: stored.data.mode,
    ...(stored.data.country === null ? {} : { country: stored.data.country }),
    ...(stored.data.custom === undefined ? {} : { custom: stored.data.custom }),
    ...(stored.data.manualDefaultAmountEur === undefined
      ? {}
      : { manualDefaultAmountEur: stored.data.manualDefaultAmountEur }),
    ...(stored.data.manualDefaultRatePct === undefined
      ? {}
      : { manualDefaultRatePct: stored.data.manualDefaultRatePct }),
  };
  return updateTaxSettingsRequestSchema.safeParse(normalized).success;
}

function validateOwnedRows(userId: string, entities: readonly Entity[]): void {
  for (const portfolio of rows(entities, 'portfolio')) {
    if (portfolio.data.userId !== userId) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'portfolio owner does not match the rehydrated account',
      );
    }
  }
  for (const asset of rows(entities, 'customAsset')) {
    if (
      asset.data.ownerId !== userId ||
      asset.data.providerId !== 'manual' ||
      asset.data.providerRef !== asset.id
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'custom asset ownership or manual-provider identity is invalid',
      );
    }
  }
  for (const setting of rows(entities, 'taxSetting')) {
    if (setting.data.userId !== userId) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'tax-setting owner does not match the rehydrated account',
      );
    }
  }
  for (const order of rows(entities, 'standingOrder')) {
    if (order.data.userId !== userId) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'standing-order owner does not match the rehydrated account',
      );
    }
  }
  for (const batch of rows(entities, 'importBatch')) {
    if (batch.data.ownerId !== userId) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'import-batch owner does not match the rehydrated account',
      );
    }
  }
  for (const kind of [
    'expenseCategory',
    'expenseTransaction',
    'expenseRule',
    'expenseBudget',
  ] as const) {
    for (const entity of rows(entities, kind)) {
      if (entity.data.userId !== userId) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          `${kind} owner does not match the rehydrated account`,
        );
      }
    }
  }
}

function validFrozenTaxShape(
  mode: EntityOf<'transaction'>['data']['taxMode'] | EntityOf<'dividend'>['data']['taxMode'],
  country: EntityOf<'transaction'>['data']['taxCountry'],
  params: EntityOf<'transaction'>['data']['taxParams'],
): boolean {
  if (mode === null) return country === null && params === null;
  if (mode === 'country_specific') return country !== null && params === null;
  if (mode === 'custom') return country === null && customTaxParamsSchema.safeParse(params).success;
  return country === null && params === null;
}

function validatePersistedDates(entities: readonly Entity[]): void {
  for (const value of rows(entities, 'customAssetValue')) {
    requirePostgresDate(value.data.date, 'custom-asset value date');
  }
  for (const order of rows(entities, 'standingOrder')) {
    requirePostgresDate(order.data.startDate, 'standing-order start date');
    if (order.data.endDate !== null) {
      requirePostgresDate(order.data.endDate, 'standing-order end date');
    }
    if (order.data.lastPeriodKey !== null) {
      requirePostgresDate(order.data.lastPeriodKey, 'standing-order last period');
    }
  }
  for (const run of rows(entities, 'standingOrderRun')) {
    requirePostgresDate(run.data.periodKey, 'standing-order run period');
  }
  for (const expense of rows(entities, 'expenseTransaction')) {
    requirePostgresDate(expense.data.bookedOn, 'expense booking date');
  }
}

function validatePersistedNumerics(entities: readonly Entity[]): void {
  for (const portfolio of rows(entities, 'portfolio')) {
    requirePostgresInteger(portfolio.data.sortOrder, 'portfolio sort order');
  }

  for (const value of rows(entities, 'customAssetValue')) {
    requireNonnegative(
      exactDecimal(value.data.close, 'custom-asset close').coefficient,
      'custom-asset close',
    );
  }

  for (const transaction of rows(entities, 'transaction')) {
    const quantity = persistedNumeric(transaction.data.quantity, 20, 8, 'transaction quantity');
    const price = persistedNumeric(transaction.data.price, 20, 6, 'transaction price');
    const fee = persistedNumeric(transaction.data.fee, 20, 6, 'transaction fee');
    requirePositive(quantity, 'transaction quantity');
    requireNonnegative(price, 'transaction price');
    requireNonnegative(fee, 'transaction fee');
    if (transaction.data.taxAmountEur !== null) {
      persistedNumeric(transaction.data.taxAmountEur, 20, 6, 'transaction tax amount');
    }
    if (transaction.data.uncoveredEntryPrice !== null) {
      requireNonnegative(
        persistedNumeric(
          transaction.data.uncoveredEntryPrice,
          20,
          6,
          'transaction uncovered entry price',
        ),
        'transaction uncovered entry price',
      );
    }
    if (
      (transaction.data.allowUncovered || transaction.data.uncoveredEntryPrice !== null) &&
      transaction.data.side !== 'sell'
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'uncovered transaction fields apply only to sells',
      );
    }
    if (transaction.data.uncoveredEntryPrice !== null && !transaction.data.allowUncovered) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'an uncovered entry price requires the uncovered-sell acknowledgement',
      );
    }
    if (
      transaction.data.side === 'buy' &&
      (transaction.data.taxMode !== null ||
        transaction.data.taxCountry !== null ||
        transaction.data.taxAmountEur !== null ||
        transaction.data.taxParams !== null)
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'buy transactions cannot carry frozen tax facts',
      );
    }
    if (
      !validFrozenTaxShape(
        transaction.data.taxMode,
        transaction.data.taxCountry,
        transaction.data.taxParams,
      )
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'transaction frozen tax facts are inconsistent',
      );
    }
    if (
      transaction.data.taxMode === 'none' &&
      transaction.data.taxAmountEur !== null &&
      persistedNumeric(transaction.data.taxAmountEur, 20, 6, 'transaction tax amount') !== 0n
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'none-mode transactions cannot carry a frozen tax amount',
      );
    }
  }

  for (const dividend of rows(entities, 'dividend')) {
    requirePositive(
      persistedNumeric(dividend.data.grossAmountEur, 20, 6, 'dividend gross amount'),
      'dividend gross amount',
    );
    if (dividend.data.taxAmountEur !== null) {
      persistedNumeric(dividend.data.taxAmountEur, 20, 6, 'dividend tax amount');
    }
    if (
      !validFrozenTaxShape(dividend.data.taxMode, dividend.data.taxCountry, dividend.data.taxParams)
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'dividend frozen tax facts are inconsistent',
      );
    }
    if (
      dividend.data.taxMode === 'none' &&
      dividend.data.taxAmountEur !== null &&
      persistedNumeric(dividend.data.taxAmountEur, 20, 6, 'dividend tax amount') !== 0n
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'none-mode dividends cannot carry a frozen tax amount',
      );
    }
  }

  for (const movement of rows(entities, 'cashMovement')) {
    persistedNumeric(movement.data.amountEur, 20, 6, 'cash-movement amount');
    if (movement.data.taxYear !== null) {
      requirePostgresInteger(movement.data.taxYear, 'cash-movement tax year');
    }
  }

  for (const setting of rows(entities, 'taxSetting')) {
    const amount =
      setting.data.manualDefaultAmountEur === null
        ? null
        : persistedNumeric(setting.data.manualDefaultAmountEur, 20, 6, 'manual tax default');
    const rate =
      setting.data.manualDefaultRatePct === null
        ? null
        : persistedNumeric(setting.data.manualDefaultRatePct, 9, 6, 'manual tax rate');
    if (amount !== null) requireNonnegative(amount, 'manual tax default');
    if (rate !== null && (rate < 0n || rate > 100n * pow10(6))) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'manual tax rate must be between zero and 100',
      );
    }
    const modeFieldsValid =
      (setting.data.mode === 'country_specific') === (setting.data.country !== null) &&
      (setting.data.mode === 'custom') === (setting.data.customParams !== null) &&
      (setting.data.mode === 'manual_per_trade' ||
        (setting.data.manualDefaultAmountEur === null &&
          setting.data.manualDefaultRatePct === null)) &&
      (setting.data.manualDefaultAmountEur === null ||
        setting.data.manualDefaultRatePct === null) &&
      (setting.data.mode !== 'custom' ||
        customTaxParamsSchema.safeParse(setting.data.customParams).success);
    if (!modeFieldsValid) {
      throw new ParanoidRehydrationError('INVALID_REFERENCE', 'tax setting is inconsistent');
    }
  }

  for (const order of rows(entities, 'standingOrder')) {
    requirePositive(
      persistedNumeric(order.data.amount, 20, 8, 'standing-order amount'),
      'standing-order amount',
    );
  }
  for (const expense of rows(entities, 'expenseTransaction')) {
    requirePositive(
      persistedNumeric(expense.data.amount, 20, 2, 'expense amount'),
      'expense amount',
    );
  }
  for (const rule of rows(entities, 'expenseRule')) {
    requirePostgresInteger(rule.data.priority, 'expense-rule priority');
  }
  for (const budget of rows(entities, 'expenseBudget')) {
    requirePositive(
      persistedNumeric(budget.data.amount, 20, 2, 'expense budget amount'),
      'expense budget amount',
    );
  }
}

/**
 * Validate every foreign-key and unique-source graph before the first insert.
 * Database checks remain defense in depth; this reports malformed decrypted vaults
 * as one clean failure and makes the no-write guarantee directly testable.
 */
interface ValidatedGraph {
  /** Sells whose apparent oversell is exactly one scale-8 storage quantum. */
  storageRoundingSellIds: ReadonlySet<string>;
}

function validateGraph(userId: string, entities: readonly Entity[]): ValidatedGraph {
  validateUniqueRestoredIds(entities);
  validateOwnedRows(userId, entities);
  validatePersistedDates(entities);
  validatePersistedNumerics(entities);

  const portfolioRows = rows(entities, 'portfolio');
  if (!portfolioRows.some((portfolio) => portfolio.data.archivedAt === null)) {
    throw new ParanoidRehydrationError(
      'INVALID_REFERENCE',
      'at least one active portfolio must be restored',
    );
  }
  const portfolioIds = new Set(portfolioRows.map((entity) => entity.id));
  const customAssetIds = ids(entities, 'customAsset');
  const sourceIds = ids(entities, 'cashSource');
  const transactionIds = ids(entities, 'transaction');
  const dividendIds = ids(entities, 'dividend');
  const standingOrderIds = ids(entities, 'standingOrder');
  const categoryIds = ids(entities, 'expenseCategory');
  const taxSettings = rows(entities, 'taxSetting');
  if (taxSettings.length > 1) {
    throw new ParanoidRehydrationError('INVALID_REFERENCE', 'only one tax setting may be restored');
  }

  const customAssetValueKeys = new Set<string>();
  for (const value of rows(entities, 'customAssetValue')) {
    const key = `${value.data.assetId}\u0000${value.data.date}`;
    if (customAssetValueKeys.has(key)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'custom asset values must be unique per asset and date',
      );
    }
    customAssetValueKeys.add(key);
  }

  const portfolioSettingKeys = new Set<string>();
  for (const setting of rows(entities, 'portfolioSetting')) {
    const key = `${setting.data.portfolioId}\u0000${setting.data.key}`;
    if (portfolioSettingKeys.has(key)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'portfolio settings must be unique per portfolio and key',
      );
    }
    portfolioSettingKeys.add(key);
    if (setting.data.key === 'tax' && !validTaxOverride(setting.data.value)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'portfolio tax override is malformed',
      );
    }
  }

  const expenseCategoryNames = new Set<string>();
  for (const category of rows(entities, 'expenseCategory')) {
    const key = `${userId}\u0000${category.data.name}`;
    if (expenseCategoryNames.has(key)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'expense category names must be unique',
      );
    }
    expenseCategoryNames.add(key);
  }

  const expenseHashes = new Set<string>();
  for (const expense of rows(entities, 'expenseTransaction')) {
    const hash = expense.data.dedupHash;
    if (hash === null) continue;
    if (expenseHashes.has(hash)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'expense rows must have unique persisted deduplication hashes',
      );
    }
    expenseHashes.add(hash);
  }

  const sourcesById = new Map(rows(entities, 'cashSource').map((entity) => [entity.id, entity]));
  const transactionsById = new Map(
    rows(entities, 'transaction').map((entity) => [entity.id, entity]),
  );
  const dividendsById = new Map(rows(entities, 'dividend').map((entity) => [entity.id, entity]));

  for (const asset of rows(entities, 'customAsset')) {
    if (asset.data.providerRef !== asset.id) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a manual asset provider reference must equal its entity id',
      );
    }
  }

  requireSubset(
    rows(entities, 'transaction').map((entity) => entity.data.portfolioId),
    portfolioIds,
    'transaction',
  );
  // Market-catalog assets are server-side global rows, while custom assets are
  // serialized here. The transaction checks their union before the first insert.
  requireSubset(
    rows(entities, 'dividend').map((entity) => entity.data.portfolioId),
    portfolioIds,
    'dividend',
  );
  // A dividend's asset may likewise be a global market asset.
  requireSubset(
    rows(entities, 'dividend').map((entity) => entity.data.cashSourceId),
    sourceIds,
    'dividend',
  );
  requireSubset(
    rows(entities, 'cashSource').map((entity) => entity.data.portfolioId),
    portfolioIds,
    'cash source',
  );
  requireSubset(
    rows(entities, 'portfolioSetting').map((entity) => entity.data.portfolioId),
    portfolioIds,
    'portfolio setting',
  );
  requireSubset(
    rows(entities, 'customAssetValue').map((entity) => entity.data.assetId),
    customAssetIds,
    'custom asset value',
  );
  requireSubset(
    rows(entities, 'standingOrder').map((entity) => entity.data.portfolioId),
    portfolioIds,
    'standing order',
  );
  requireSubset(
    rows(entities, 'standingOrderRun').map((entity) => entity.data.standingOrderId),
    standingOrderIds,
    'standing-order run',
  );
  const standingOrderRunKeys = new Set<string>();
  for (const run of rows(entities, 'standingOrderRun')) {
    const key = `${run.data.standingOrderId}\u0000${run.data.periodKey}`;
    if (standingOrderRunKeys.has(key)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'standing-order runs must be unique per order and period',
      );
    }
    standingOrderRunKeys.add(key);
  }
  for (const order of rows(entities, 'standingOrder')) {
    const isBuy = order.data.kind === 'buy-asset';
    if (isBuy !== (order.data.assetId !== null)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a standing-order asset must be present exactly for an asset buy',
      );
    }
    const isMonthly = order.data.cadence === 'monthly';
    if (isMonthly !== (order.data.anchorDay !== null)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a standing-order anchor day must be present exactly for a monthly schedule',
      );
    }
    if (order.data.anchorDay !== null && (order.data.anchorDay < 1 || order.data.anchorDay > 31)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a standing-order anchor day must be between 1 and 31',
      );
    }
    if (order.data.endDate !== null && order.data.endDate < order.data.startDate) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a standing-order end date must not precede its start date',
      );
    }
    if ((order.data.lastRunAt === null) !== (order.data.lastPeriodKey === null)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a standing-order run watermark requires both its timestamp and period key',
      );
    }
    if (order.data.lastPeriodKey !== null && order.data.lastPeriodKey < order.data.startDate) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a standing-order run watermark must not precede its schedule start',
      );
    }
    if (
      order.data.lastPeriodKey !== null &&
      !standingOrderRunKeys.has(`${order.id}\u0000${order.data.lastPeriodKey}`)
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a standing-order run watermark requires its authoritative run row',
      );
    }
  }
  requireSubset(
    rows(entities, 'expenseTransaction').flatMap((entity) =>
      entity.data.categoryId ? [entity.data.categoryId] : [],
    ),
    categoryIds,
    'expense transaction',
  );
  requireSubset(
    rows(entities, 'expenseRule').map((entity) => entity.data.categoryId),
    categoryIds,
    'expense rule',
  );
  requireSubset(
    rows(entities, 'expenseBudget').map((entity) => entity.data.categoryId),
    categoryIds,
    'expense budget',
  );

  const sourcesByPortfolio = new Map<string, EntityOf<'cashSource'>[]>();
  for (const source of rows(entities, 'cashSource')) {
    const group = sourcesByPortfolio.get(source.data.portfolioId) ?? [];
    group.push(source);
    sourcesByPortfolio.set(source.data.portfolioId, group);
  }
  for (const [portfolioId, sources] of sourcesByPortfolio) {
    const mains = sources.filter((source) => source.data.isMain);
    if (mains.length !== 1 || mains[0]!.data.archivedAt !== null) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        `portfolio ${portfolioId} must have exactly one active main cash source`,
      );
    }
  }

  const portfolioNameKeys = new Set<string>();
  for (const portfolio of rows(entities, 'portfolio')) {
    const key = `${userId}\u0000${portfolio.data.name}`;
    if (portfolioNameKeys.has(key)) {
      throw new ParanoidRehydrationError('INVALID_REFERENCE', 'portfolio names must be unique');
    }
    portfolioNameKeys.add(key);
  }
  const sourceNameKeys = new Set<string>();
  for (const source of rows(entities, 'cashSource')) {
    const key = `${source.data.portfolioId}\u0000${source.data.name}`;
    if (sourceNameKeys.has(key)) {
      throw new ParanoidRehydrationError('INVALID_REFERENCE', 'cash-source names must be unique');
    }
    sourceNameKeys.add(key);
  }

  for (const dividend of rows(entities, 'dividend')) {
    const source = sourcesById.get(dividend.data.cashSourceId)!;
    if (source.data.portfolioId !== dividend.data.portfolioId) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'dividend cash source belongs to another portfolio',
      );
    }
  }

  const movements = rows(entities, 'cashMovement');
  requireSubset(
    movements.map((entity) => entity.data.portfolioId),
    portfolioIds,
    'cash movement',
  );
  requireSubset(
    movements.map((entity) => entity.data.sourceId),
    sourceIds,
    'cash movement',
  );
  requireSubset(
    movements.flatMap((entity) => (entity.data.transactionId ? [entity.data.transactionId] : [])),
    transactionIds,
    'cash movement',
  );
  requireSubset(
    movements.flatMap((entity) => (entity.data.dividendId ? [entity.data.dividendId] : [])),
    dividendIds,
    'cash movement',
  );
  requireSubset(
    movements.flatMap((entity) =>
      entity.data.counterpartSourceId ? [entity.data.counterpartSourceId] : [],
    ),
    sourceIds,
    'cash movement',
  );

  const transfersById = new Map<string, EntityOf<'cashMovement'>[]>();
  for (const movement of movements) {
    const source = sourcesById.get(movement.data.sourceId)!;
    if (source.data.portfolioId !== movement.data.portfolioId) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'cash movement source belongs to another portfolio',
      );
    }
    if (movement.data.transactionId && movement.data.dividendId) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'cash movement cannot link both a transaction and a dividend',
      );
    }
    const isTransfer =
      movement.data.kind === 'transfer_out' || movement.data.kind === 'transfer_in';
    if (
      isTransfer !== (movement.data.transferId !== null) ||
      isTransfer !== (movement.data.counterpartSourceId !== null)
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'cash-movement transfer links do not match its kind',
      );
    }
    const isTax = movement.data.kind === 'tax_withholding' || movement.data.kind === 'tax_refund';
    if (isTax !== (movement.data.taxYear !== null)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'cash-movement tax year does not match its kind',
      );
    }
    if (movement.data.kind === 'dividend' && movement.data.dividendId === null) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a dividend cash movement requires its dividend',
      );
    }
    if (movement.data.transactionId) {
      const transaction = transactionsById.get(movement.data.transactionId)!;
      const isValidTransactionMovement =
        (movement.data.kind === 'buy' && transaction.data.side === 'buy') ||
        (movement.data.kind === 'sell_proceeds' && transaction.data.side === 'sell') ||
        ((movement.data.kind === 'tax_withholding' || movement.data.kind === 'tax_refund') &&
          transaction.data.side === 'sell');
      if (!isValidTransactionMovement) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'cash movement kind does not match its transaction',
        );
      }
      if (transaction.data.portfolioId !== movement.data.portfolioId) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'cash movement transaction belongs to another portfolio',
        );
      }
      if (transaction.data.source !== movement.data.source) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'cash movement source tag must match its transaction',
        );
      }
    }
    if (movement.data.dividendId) {
      const dividend = dividendsById.get(movement.data.dividendId)!;
      const isValidDividendMovement =
        movement.data.kind === 'dividend' ||
        movement.data.kind === 'tax_withholding' ||
        movement.data.kind === 'tax_refund';
      if (!isValidDividendMovement) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'cash movement kind does not match its dividend',
        );
      }
      if (dividend.data.portfolioId !== movement.data.portfolioId) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'cash movement dividend belongs to another portfolio',
        );
      }
      if (dividend.data.cashSourceId !== movement.data.sourceId) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'cash movement source does not match its dividend',
        );
      }
      if (dividend.data.source !== movement.data.source) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'cash movement source tag must match its dividend',
        );
      }
    }
    if (movement.data.counterpartSourceId) {
      const counterpart = sourcesById.get(movement.data.counterpartSourceId)!;
      if (counterpart.data.portfolioId !== movement.data.portfolioId) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'cash movement counterpart source belongs to another portfolio',
        );
      }
    }
    if (
      (movement.data.kind === 'buy' || movement.data.kind === 'sell_proceeds') &&
      !movement.data.transactionId
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a buy or sell-proceeds cash movement requires its transaction',
      );
    }
    if (movement.data.transferId) {
      const transfer = transfersById.get(movement.data.transferId) ?? [];
      transfer.push(movement);
      transfersById.set(movement.data.transferId, transfer);
    }
  }

  for (const transfer of transfersById.values()) {
    const outgoing = transfer.filter((movement) => movement.data.kind === 'transfer_out');
    const incoming = transfer.filter((movement) => movement.data.kind === 'transfer_in');
    const [out] = outgoing;
    const [inbound] = incoming;
    if (
      transfer.length !== 2 ||
      outgoing.length !== 1 ||
      incoming.length !== 1 ||
      !out ||
      !inbound ||
      out.data.portfolioId !== inbound.data.portfolioId ||
      out.data.sourceId === inbound.data.sourceId ||
      out.data.counterpartSourceId !== inbound.data.sourceId ||
      inbound.data.counterpartSourceId !== out.data.sourceId ||
      persistedNumeric(out.data.amountEur, 20, 6, 'transfer amount') +
        persistedNumeric(inbound.data.amountEur, 20, 6, 'transfer amount') !==
        0n ||
      Date.parse(out.data.executedAt) !== Date.parse(inbound.data.executedAt)
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'transfer movements do not form a valid pair',
      );
    }
  }

  const movementsByTransactionId = new Map<string, EntityOf<'cashMovement'>[]>();
  const movementsByDividendId = new Map<string, EntityOf<'cashMovement'>[]>();
  for (const movement of movements) {
    if (movement.data.transactionId) {
      const linked = movementsByTransactionId.get(movement.data.transactionId) ?? [];
      linked.push(movement);
      movementsByTransactionId.set(movement.data.transactionId, linked);
    }
    if (movement.data.dividendId) {
      const linked = movementsByDividendId.get(movement.data.dividendId) ?? [];
      linked.push(movement);
      movementsByDividendId.set(movement.data.dividendId, linked);
    }
  }

  for (const transaction of rows(entities, 'transaction')) {
    const linked = movementsByTransactionId.get(transaction.id) ?? [];
    const grossKind = transaction.data.side === 'buy' ? 'buy' : 'sell_proceeds';
    const gross = linked.filter((movement) => movement.data.kind === grossKind);
    if (gross.length > 1) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a transaction may have at most one linked gross cash movement',
      );
    }
    const [grossMovement] = gross;
    if (grossMovement) {
      const transactionAt = Date.parse(transaction.data.executedAt);
      const movementAt = Date.parse(grossMovement.data.executedAt);
      const invalidTimestamp =
        grossKind === 'sell_proceeds' ? movementAt !== transactionAt : movementAt < transactionAt;
      if (invalidTimestamp) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          grossKind === 'sell_proceeds'
            ? 'a sell-proceeds cash movement must share its transaction timestamp'
            : 'a buy cash movement must not precede its transaction',
        );
      }
    }
    // The persisted cash amount is authoritative. Normal writes calculate it
    // from the accepted client numbers (and, for foreign assets, that moment's
    // historical FX result) before PostgreSQL independently coerces the
    // transaction columns to their fixed scales. Recomputing from the stored
    // transaction cannot reproduce every valid row. Parent/source ownership,
    // kind/side, source tag, sign, uniqueness, and ledger solvency are all
    // validated around this loop without changing the frozen amount.
    const settlement = linked.filter(
      (movement) => movement.data.kind === 'tax_withholding' || movement.data.kind === 'tax_refund',
    );
    if (settlement.length > 1) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a transaction may have at most one linked tax settlement',
      );
    }
    if (
      settlement.some(
        (movement) =>
          Date.parse(movement.data.executedAt) !== Date.parse(transaction.data.executedAt),
      )
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a transaction tax settlement must share its transaction timestamp',
      );
    }
    const frozenTax = transaction.data.taxAmountEur;
    const frozenTaxAmount =
      frozenTax === null ? null : persistedNumeric(frozenTax, 20, 6, 'transaction tax amount');
    if (frozenTaxAmount !== null && frozenTaxAmount !== 0n) {
      const [movement] = settlement;
      if (
        !movement ||
        persistedNumeric(movement.data.amountEur, 20, 6, 'tax settlement amount') !==
          -frozenTaxAmount ||
        movement.data.taxYear !== viennaYearOf(transaction.data.executedAt)
      ) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'a nonzero transaction tax amount requires its matching tax settlement',
        );
      }
    } else if (settlement.length > 0) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a transaction tax settlement requires a nonzero frozen tax amount',
      );
    }
  }

  for (const dividend of rows(entities, 'dividend')) {
    const linked = movementsByDividendId.get(dividend.id) ?? [];
    const gross = linked.filter((movement) => movement.data.kind === 'dividend');
    if (
      gross.length !== 1 ||
      persistedNumeric(gross[0]!.data.amountEur, 20, 6, 'dividend cash amount') !==
        persistedNumeric(dividend.data.grossAmountEur, 20, 6, 'dividend gross amount') ||
      gross[0]!.data.sourceId !== dividend.data.cashSourceId ||
      Date.parse(gross[0]!.data.executedAt) !== Date.parse(dividend.data.executedAt)
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a dividend requires one matching gross cash movement',
      );
    }
    const settlement = linked.filter(
      (movement) => movement.data.kind === 'tax_withholding' || movement.data.kind === 'tax_refund',
    );
    if (settlement.length > 1) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a dividend may have at most one linked tax settlement',
      );
    }
    if (
      settlement.some(
        (movement) => Date.parse(movement.data.executedAt) !== Date.parse(dividend.data.executedAt),
      )
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a dividend tax settlement must share its dividend timestamp',
      );
    }
    const frozenTax = dividend.data.taxAmountEur;
    const frozenTaxAmount =
      frozenTax === null ? null : persistedNumeric(frozenTax, 20, 6, 'dividend tax amount');
    if (frozenTaxAmount !== null && frozenTaxAmount !== 0n) {
      const [movement] = settlement;
      if (
        !movement ||
        persistedNumeric(movement.data.amountEur, 20, 6, 'tax settlement amount') !==
          -frozenTaxAmount ||
        movement.data.taxYear !== viennaYearOf(dividend.data.executedAt)
      ) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'a nonzero dividend tax amount requires its matching tax settlement',
        );
      }
    } else if (settlement.length > 0) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a dividend tax settlement requires a nonzero frozen tax amount',
      );
    }
  }

  const budgetCategoryIds = new Set<string>();
  for (const budget of rows(entities, 'expenseBudget')) {
    if (budgetCategoryIds.has(budget.data.categoryId)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'each expense category has at most one budget',
      );
    }
    budgetCategoryIds.add(budget.data.categoryId);
  }

  // The repository's persisted replay order is `(executed_at, id)`, not the
  // arbitrary client array order. Preserve that ordering here so solvency checks
  // accept exactly the ledger history normal reads will replay after restore.
  const orderedMovements = [...movements].sort(
    (a, b) =>
      Date.parse(a.data.executedAt) - Date.parse(b.data.executedAt) || a.id.localeCompare(b.id),
  );
  // Replica application deliberately waives the ordinary solvency gate because
  // copy-local tax state can skew a source. Once that copy becomes a fork, its
  // sync-tagged rows are the only durable provenance available in the strict
  // vault document, so preserve that reachable ledger instead of stranding it.
  const mirrorReplicaSourceIds = new Set(
    movements
      .filter((movement) => movement.data.source === SOURCE_TAG_SYNC_MIRRORCHAIN)
      .map((movement) => movement.data.sourceId),
  );
  const storageRoundingSellIds = new Set<string>();

  try {
    const balancesBySource = new Map<string, bigint>();
    for (const movement of orderedMovements) {
      const amount = persistedNumeric(movement.data.amountEur, 20, 6, 'cash-movement amount');
      const requiredSign = CASH_MOVEMENT_SIGN[movement.data.kind];
      if (amount === 0n || (requiredSign === 1 ? amount < 0n : amount > 0n)) {
        throw new Error('cash-movement amount has the wrong sign');
      }
      const balance = (balancesBySource.get(movement.data.sourceId) ?? 0n) + amount;
      if (balance < 0n && !mirrorReplicaSourceIds.has(movement.data.sourceId)) {
        throw new Error('cash source would become negative');
      }
      balancesBySource.set(movement.data.sourceId, balance);
    }
    const transactionsByPortfolioAsset = new Map<string, EntityOf<'transaction'>[]>();
    for (const transaction of rows(entities, 'transaction')) {
      const key = `${transaction.data.portfolioId}\u0000${transaction.data.assetId}`;
      const group = transactionsByPortfolioAsset.get(key) ?? [];
      group.push(transaction);
      transactionsByPortfolioAsset.set(key, group);
    }
    for (const transactions of transactionsByPortfolioAsset.values()) {
      const orderedTransactions = [...transactions].sort(
        (a, b) =>
          Date.parse(a.data.executedAt) - Date.parse(b.data.executedAt) || a.id.localeCompare(b.id),
      );
      let held = 0n;
      for (const transaction of orderedTransactions) {
        const quantity = persistedNumeric(transaction.data.quantity, 20, 8, 'transaction quantity');
        if (transaction.data.side === 'buy') {
          held += quantity;
        } else {
          const shortfall = quantity - held;
          if (
            shortfall > 0n &&
            shortfall <= PERSISTED_QUANTITY_ROUNDING_TOLERANCE &&
            !transaction.data.allowUncovered
          ) {
            storageRoundingSellIds.add(transaction.id);
          }
          if (
            shortfall > PERSISTED_QUANTITY_ROUNDING_TOLERANCE &&
            !transaction.data.allowUncovered
          ) {
            throw new Error('transaction would oversell its position');
          }
          held = shortfall > 0n ? 0n : held - quantity;
        }
      }
    }
  } catch (error) {
    if (error instanceof ParanoidRehydrationError) throw error;
    throw new ParanoidRehydrationError(
      'INVALID_CASH_LEDGER',
      error instanceof Error ? error.message : 'cash ledger is invalid',
    );
  }
  return { storageRoundingSellIds };
}

interface ReferencedAsset {
  currency: string;
}

async function resolveReferencedAssets(
  sourceRows: ParanoidRehydrationSourceRepository,
  entities: readonly Entity[],
): Promise<ReadonlyMap<string, ReferencedAsset>> {
  const assetsById = new Map<string, ReferencedAsset>(
    rows(entities, 'customAsset').map((entity) => [entity.id, { currency: entity.data.currency }]),
  );
  const customAssetIds = new Set(assetsById.keys());
  const referencedAssetIds = new Set([
    ...rows(entities, 'transaction').map((entity) => entity.data.assetId),
    ...rows(entities, 'dividend').map((entity) => entity.data.assetId),
    ...rows(entities, 'standingOrder')
      .map((entity) => entity.data.assetId)
      .filter((assetId): assetId is string => assetId !== null),
  ]);
  const marketAssetIds = [...referencedAssetIds].filter((id) => !customAssetIds.has(id));
  if (marketAssetIds.length === 0) return assetsById;
  const found = await sourceRows.findReferencedGlobalAssets(marketAssetIds);
  requireSubset(marketAssetIds, new Set(found.map((asset) => asset.id)), 'restore source');
  for (const asset of found) {
    assetsById.set(asset.id, { currency: asset.currency });
  }
  return assetsById;
}

function validateStandingOrderCurrencies(
  entities: readonly Entity[],
  referencedAssets: ReadonlyMap<string, ReferencedAsset>,
): void {
  for (const order of rows(entities, 'standingOrder')) {
    if (order.data.kind !== 'buy-asset') {
      if (order.data.currency !== 'EUR') {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'cash standing orders must use EUR',
        );
      }
      continue;
    }
    const asset = order.data.assetId ? referencedAssets.get(order.data.assetId) : undefined;
    if (!asset || order.data.currency !== asset.currency) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'buy standing-order currency must match its asset',
      );
    }
  }
}

async function ensureNoExistingRestorableRows(
  sourceRows: ParanoidRehydrationSourceRepository,
  userId: string,
): Promise<void> {
  if (await sourceRows.hasExistingRestorableRows(userId)) {
    throw new ParanoidRehydrationError(
      'REHYDRATION_CONFLICT',
      'normal restore-source rows already exist for this account',
    );
  }
}

export function createParanoidRehydrationService(
  deps: ParanoidRehydrationServiceDeps,
): ParanoidRehydrationService {
  const now = deps.now ?? (() => new Date());
  const toCashEur =
    deps.toCashEur ??
    (async (amount, currency) => {
      if (currency !== 'EUR') {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'non-EUR tax replay requires a historical EUR conversion',
        );
      }
      return amount;
    });
  const stage = async (name: ParanoidRehydrationStage): Promise<void> => {
    await deps.afterStage?.(name);
  };

  return {
    async rehydrate(userId, request) {
      const parsed = paranoidDisableRehydrationRequestSchema.safeParse(request);
      if (!parsed.success) {
        throw new ParanoidRehydrationError('INVALID_REFERENCE', 'rehydration request is malformed');
      }
      const normalizedRequest = parsed.data;
      // Tombstones exist for client-side merge convergence only. Construct and
      // validate the restore graph from live facts before any database mutation.
      const entities = liveEntities(normalizedRequest.document);
      const validatedGraph = validateGraph(userId, entities);

      return withParanoidRehydrationTransaction(deps.db, async (tx) => {
        const transition = createParanoidRehydrationTransactionRepository(tx);
        const state = await transition.getState(userId);
        if (!state)
          throw new ParanoidRehydrationError('ACCOUNT_NOT_FOUND', 'account does not exist');
        if (state.receipt) {
          if (state.receipt.rehydrationId !== normalizedRequest.rehydrationId) {
            throw new ParanoidRehydrationError(
              'REHYDRATION_CONFLICT',
              'a different rehydration is complete',
            );
          }
          return {
            rehydrationId: state.receipt.rehydrationId,
            completedAt: state.receipt.completedAt.toISOString(),
            idempotent: true,
            postCommit: POST_COMMIT,
          };
        }
        if (state.privacyMode !== 'paranoid') {
          throw new ParanoidRehydrationError('NOT_PARANOID', 'account is not in paranoid mode');
        }

        const sourceRows = createParanoidRehydrationSourceRepository(tx);
        await ensureNoExistingRestorableRows(sourceRows, userId);
        const referencedAssets = await resolveReferencedAssets(sourceRows, entities);
        validateStandingOrderCurrencies(entities, referencedAssets);

        await sourceRows.restoreCustomAssets(rows(entities, 'customAsset'));
        await sourceRows.restoreCustomAssetValues(rows(entities, 'customAssetValue'));
        await stage('customAssets');

        await sourceRows.restorePortfolios(rows(entities, 'portfolio'));
        await stage('portfolios');

        await sourceRows.restoreCashSources(rows(entities, 'cashSource'));
        await stage('cashSources');

        const taxSettings = rows(entities, 'taxSetting');
        if (taxSettings.length > 1) {
          throw new ParanoidRehydrationError(
            'INVALID_REFERENCE',
            'only one tax setting may be restored',
          );
        }
        await sourceRows.restoreTaxSettings(taxSettings[0]);
        await stage('taxSettings');

        await sourceRows.restorePortfolioSettings(rows(entities, 'portfolioSetting'));
        await stage('portfolioSettings');

        await sourceRows.restoreTransactions(rows(entities, 'transaction'));
        await stage('transactions');

        await sourceRows.restoreDividends(rows(entities, 'dividend'));
        await stage('dividends');

        await sourceRows.restoreCashMovements(rows(entities, 'cashMovement'));
        await stage('cashMovements');

        await replayRestoredTaxState(tx, {
          userId,
          portfolioIds: rows(entities, 'portfolio').map((portfolio) => portfolio.id),
          now: now(),
          toEur: toCashEur,
          storageRoundingSellIds: validatedGraph.storageRoundingSellIds,
        });
        await stage('taxReplay');

        const standingOrderRows = rows(entities, 'standingOrder');
        await sourceRows.restoreStandingOrders(standingOrderRows);
        await sourceRows.restoreStandingOrderRuns(rows(entities, 'standingOrderRun'));
        await stage('standingOrders');

        const categoryRepo = createExpenseCategoryRepository(tx);
        const expenseTransactionRepo = createExpenseTransactionRepository(tx);
        const expenseRuleRepo = createExpenseRuleRepository(tx);
        const expenseBudgetRepo = createExpenseBudgetRepository(tx);
        const expenseService = createExpenseService({
          categories: categoryRepo,
          transactions: expenseTransactionRepo,
          rules: expenseRuleRepo,
        });
        const expenseBudgetService = createExpenseBudgetService({
          categories: categoryRepo,
          transactions: expenseTransactionRepo,
          budgets: expenseBudgetRepo,
          notify: NO_REHYDRATION_NOTIFICATIONS,
          now,
        });

        await sourceRows.restoreExpenseCategories(rows(entities, 'expenseCategory'));
        await stage('expenseCategories');

        await sourceRows.restoreExpenseRules(rows(entities, 'expenseRule'));
        await stage('expenseRules');

        await sourceRows.restoreExpenseBudgets(rows(entities, 'expenseBudget'));
        await stage('expenseBudgets');

        const restoredExpenseTransactions = rows(entities, 'expenseTransaction').map((entity) => ({
          ...entity,
          categoryId: entity.data.categoryId,
          bookedOn: entity.data.bookedOn,
        }));
        await expenseService.restoreTransactions(userId, restoredExpenseTransactions, {
          ownsCategory: (ownerId, categoryId) => categoryRepo.ownsCategory(ownerId, categoryId),
          insertTransactions: (_ownerId, restoredRows) =>
            sourceRows.restoreExpenseTransactions(restoredRows),
          reconcileBudgets: (ownerId, periods) =>
            expenseBudgetService.reconcileRestore(ownerId, periods).then(() => undefined),
        });
        await stage('expenseTransactions');

        const completedAt = now();
        await transition.setNormalAndClearMedia(userId);
        await stage('normalMode');
        await transition.deleteServerCiphertext(userId);
        await stage('ciphertextDeleted');
        await transition.insertReceipt(userId, normalizedRequest.rehydrationId, completedAt);
        await stage('finish');

        return {
          rehydrationId: normalizedRequest.rehydrationId,
          completedAt: completedAt.toISOString(),
          idempotent: false,
          postCommit: POST_COMMIT,
        };
      });
    },
  };
}
