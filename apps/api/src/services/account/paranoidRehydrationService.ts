import {
  type ParanoidDisableRehydrationRequest,
  type ParanoidDisableRehydrationResult,
  type ParanoidRehydrationPostCommitPlan,
  vaultDocumentV1Schema,
} from '@bettertrack/contracts';
import {
  cashBalancesBySource,
  floorCents,
  projectCashLedgerBySource,
} from '@bettertrack/domain/cashLedger';
import { viennaYearOf } from '@bettertrack/domain/tax';

import { expenseDedupHash } from '../../data/expenseDedup';
import { reducePosition } from '../../domain/holdings';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { Database } from '../../data/db';
import { createParanoidRehydrationSourceRepository } from '../../data/repositories/paranoidRehydrationRepository';
import {
  createParanoidRehydrationTransactionRepository,
  withParanoidRehydrationTransaction,
} from '../../data/repositories/paranoidVaultRepository';
import {
  assets,
  expenseCategories,
  expenseTransactions,
  portfolios,
  standingOrders,
  userTaxSettings,
} from '../../data/schema';

/**
 * Dedicated normal-write transaction seam for PD3a. It validates exactly the
 * restore-source document and then inserts only through this single transaction;
 * public services are intentionally not called because they own independent
 * transactions and effects. PD3b owns public routing and post-commit execution.
 */

const POST_COMMIT: ParanoidRehydrationPostCommitPlan = {
  invalidate: ['account', 'portfolio', 'expenses', 'standingOrders', 'tax'],
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
  /** Converts a native trade amount into the EUR cash ledger at the trade day. */
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
  | 'standingOrders'
  | 'expenseCategories'
  | 'expenseTransactions'
  | 'expenseRules'
  | 'expenseBudgets'
  | 'finish';

export interface ParanoidRehydrationService {
  rehydrate(
    userId: string,
    request: ParanoidDisableRehydrationRequest,
  ): Promise<ParanoidDisableRehydrationResult>;
}

type Entity = ParanoidDisableRehydrationRequest['document']['entities'][number];
type EntityOf<K extends Entity['kind']> = Extract<Entity, { kind: K }>;

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

/**
 * Validate every foreign-key and unique-source graph before the first insert.
 * Database checks remain defense in depth; this reports malformed decrypted vaults
 * as one clean failure and makes the no-write guarantee directly testable.
 */
function validateGraph(userId: string, entities: readonly Entity[]): void {
  const portfolioIds = ids(entities, 'portfolio');
  const customAssetIds = ids(entities, 'customAsset');
  const sourceIds = ids(entities, 'cashSource');
  const transactionIds = ids(entities, 'transaction');
  const dividendIds = ids(entities, 'dividend');
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

  const importedExpenseHashes = new Set<string>();
  for (const expense of rows(entities, 'expenseTransaction')) {
    if (!expense.data.source.startsWith('import:')) continue;
    const hash = expenseDedupHash(expense.data);
    if (importedExpenseHashes.has(hash)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'imported expense rows must have unique deduplication facts',
      );
    }
    importedExpenseHashes.add(hash);
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
  for (const order of rows(entities, 'standingOrder')) {
    if ((order.data.lastRunAt === null) !== (order.data.lastPeriodKey === null)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a standing-order run watermark requires both its timestamp and period key',
      );
    }
    if (
      order.data.lastPeriodKey !== null &&
      (order.data.lastPeriodKey < order.data.startDate ||
        (order.data.endDate !== null && order.data.lastPeriodKey > order.data.endDate))
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a standing-order run watermark must fall within its schedule window',
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
      out.data.amountEur + inbound.data.amountEur !== 0 ||
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
    const settlement = linked.filter(
      (movement) => movement.data.kind === 'tax_withholding' || movement.data.kind === 'tax_refund',
    );
    if (settlement.length > 1) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a transaction may have at most one linked tax settlement',
      );
    }
    const frozenTax = transaction.data.taxAmountEur;
    if (frozenTax !== null && frozenTax !== 0) {
      const [movement] = settlement;
      if (
        !movement ||
        movement.data.amountEur !== -frozenTax ||
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
      gross[0]!.data.amountEur !== dividend.data.grossAmountEur ||
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
    const frozenTax = dividend.data.taxAmountEur;
    if (frozenTax !== null && frozenTax !== 0) {
      const [movement] = settlement;
      if (
        !movement ||
        movement.data.amountEur !== -frozenTax ||
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
  const ledgerMovements = orderedMovements.map((entity) => ({
    sourceId: entity.data.sourceId,
    kind: entity.data.kind,
    amountEur: entity.data.amountEur,
    occurredAt: entity.data.executedAt,
  }));

  try {
    projectCashLedgerBySource(ledgerMovements);
    const balancesBySource = cashBalancesBySource(ledgerMovements);
    for (const source of rows(entities, 'cashSource')) {
      if (source.data.archivedAt !== null && (balancesBySource.get(source.id) ?? 0) !== 0) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'an archived cash source must have an exactly zero balance',
        );
      }
    }
    const transactionsByPortfolioAsset = new Map<string, EntityOf<'transaction'>[]>();
    for (const transaction of rows(entities, 'transaction')) {
      const key = `${transaction.data.portfolioId}\u0000${transaction.data.assetId}`;
      const group = transactionsByPortfolioAsset.get(key) ?? [];
      group.push(transaction);
      transactionsByPortfolioAsset.set(key, group);
    }
    for (const transactions of transactionsByPortfolioAsset.values()) {
      reducePosition(
        transactions.map((transaction) => ({
          assetId: transaction.data.assetId,
          side: transaction.data.side,
          quantity: transaction.data.quantity,
          price: transaction.data.price,
          fee: transaction.data.fee,
          executedAt: transaction.data.executedAt,
          allowUncovered: transaction.data.allowUncovered,
          uncoveredEntryPrice: transaction.data.uncoveredEntryPrice,
        })),
      );
    }
  } catch (error) {
    if (error instanceof ParanoidRehydrationError) throw error;
    throw new ParanoidRehydrationError(
      'INVALID_CASH_LEDGER',
      error instanceof Error ? error.message : 'cash ledger is invalid',
    );
  }
}

async function resolveReferencedAssetCurrencies(
  tx: Database,
  entities: readonly Entity[],
): Promise<ReadonlyMap<string, string>> {
  const currencies = new Map(
    rows(entities, 'customAsset').map((entity) => [entity.id, entity.data.currency]),
  );
  const customAssetIds = new Set(currencies.keys());
  const referencedAssetIds = new Set([
    ...rows(entities, 'transaction').map((entity) => entity.data.assetId),
    ...rows(entities, 'dividend').map((entity) => entity.data.assetId),
    ...rows(entities, 'standingOrder')
      .map((entity) => entity.data.assetId)
      .filter((assetId): assetId is string => assetId !== null),
  ]);
  const marketAssetIds = [...referencedAssetIds].filter((id) => !customAssetIds.has(id));
  if (marketAssetIds.length === 0) return currencies;
  const found = await tx
    .select({ id: assets.id, currency: assets.currency })
    .from(assets)
    .where(and(inArray(assets.id, marketAssetIds), isNull(assets.ownerId)));
  requireSubset(marketAssetIds, new Set(found.map((asset) => asset.id)), 'restore source');
  for (const asset of found) currencies.set(asset.id, asset.currency);
  return currencies;
}

/**
 * Normal transaction writes derive a linked gross movement from the immutable
 * trade facts. A decrypted document may not substitute its own amount: doing so
 * would manufacture cash while retaining an otherwise valid transaction.
 */
async function validateTradeCashLinks(
  entities: readonly Entity[],
  assetCurrencies: ReadonlyMap<string, string>,
  toCashEur: (amount: number, currency: string, day: string) => Promise<number>,
): Promise<void> {
  const movementsByTransactionId = new Map<string, EntityOf<'cashMovement'>[]>();
  for (const movement of rows(entities, 'cashMovement')) {
    if (!movement.data.transactionId) continue;
    const linked = movementsByTransactionId.get(movement.data.transactionId) ?? [];
    linked.push(movement);
    movementsByTransactionId.set(movement.data.transactionId, linked);
  }

  for (const transaction of rows(entities, 'transaction')) {
    const grossKind = transaction.data.side === 'buy' ? 'buy' : 'sell_proceeds';
    const gross = (movementsByTransactionId.get(transaction.id) ?? []).filter(
      (movement) => movement.data.kind === grossKind,
    );
    if (gross.length === 0) continue;
    const currency = assetCurrencies.get(transaction.data.assetId);
    if (!currency) {
      throw new ParanoidRehydrationError('INVALID_REFERENCE', 'transaction asset is unavailable');
    }
    const nativeAmount =
      transaction.data.side === 'buy'
        ? transaction.data.quantity * transaction.data.price + transaction.data.fee
        : transaction.data.quantity * transaction.data.price - transaction.data.fee;
    const day = new Date(transaction.data.executedAt).toISOString().slice(0, 10);
    const expectedMagnitude = floorCents(await toCashEur(nativeAmount, currency, day));
    const expectedAmount = transaction.data.side === 'buy' ? -expectedMagnitude : expectedMagnitude;
    if (
      expectedMagnitude <= 0 ||
      gross.length !== 1 ||
      gross[0]!.data.amountEur !== expectedAmount
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'linked transaction cash movement does not match normal trade economics',
      );
    }
  }
}

async function ownedAssetIds(tx: Database, userId: string): Promise<Set<string>> {
  const records = await tx
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.ownerId, userId), eq(assets.providerId, 'manual')));
  return new Set(records.map((record) => record.id));
}

async function ensureNoExistingRestorableRows(tx: Database, userId: string): Promise<void> {
  const ownedAssets = await ownedAssetIds(tx, userId);
  const portfolioRows = await tx
    .select({ id: portfolios.id })
    .from(portfolios)
    .where(eq(portfolios.userId, userId));
  const portfolioIds = portfolioRows.map((row) => row.id);
  const present = await Promise.all([
    Promise.resolve(ownedAssets.size),
    Promise.resolve(portfolioIds.length),
    tx
      .select({ id: expenseCategories.id })
      .from(expenseCategories)
      .where(eq(expenseCategories.userId, userId))
      .limit(1),
    tx
      .select({ id: expenseTransactions.id })
      .from(expenseTransactions)
      .where(eq(expenseTransactions.userId, userId))
      .limit(1),
    tx
      .select({ id: standingOrders.id })
      .from(standingOrders)
      .where(eq(standingOrders.userId, userId))
      .limit(1),
    tx
      .select({ userId: userTaxSettings.userId })
      .from(userTaxSettings)
      .where(eq(userTaxSettings.userId, userId))
      .limit(1),
  ]);
  if (
    present[0] !== 0 ||
    present[1] !== 0 ||
    present[2].length ||
    present[3].length ||
    present[4].length ||
    present[5].length
  ) {
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
          'non-EUR trade cash links require a historical EUR conversion',
        );
      }
      return amount;
    });
  const stage = async (name: ParanoidRehydrationStage): Promise<void> => {
    await deps.afterStage?.(name);
  };

  return {
    async rehydrate(userId, request) {
      const parsed = vaultDocumentV1Schema.safeParse(request.document);
      if (!parsed.success) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'rehydration document is malformed',
        );
      }
      const normalizedRequest = { ...request, document: parsed.data };
      // Tombstones exist for client-side merge convergence only. Construct and
      // validate the restore graph from live facts before any database mutation.
      const entities = liveEntities(normalizedRequest.document);
      validateGraph(userId, entities);

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

        await ensureNoExistingRestorableRows(tx, userId);
        const assetCurrencies = await resolveReferencedAssetCurrencies(tx, entities);
        await validateTradeCashLinks(entities, assetCurrencies, toCashEur);

        const sourceRows = createParanoidRehydrationSourceRepository(tx);
        await sourceRows.restoreCustomAssets(userId, rows(entities, 'customAsset'));
        await sourceRows.restoreCustomAssetValues(rows(entities, 'customAssetValue'));
        await stage('customAssets');

        await sourceRows.restorePortfolios(userId, rows(entities, 'portfolio'));
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
        await sourceRows.restoreTaxSettings(userId, taxSettings[0]);
        await stage('taxSettings');

        await sourceRows.restorePortfolioSettings(rows(entities, 'portfolioSetting'));
        await stage('portfolioSettings');

        await sourceRows.restoreTransactions(rows(entities, 'transaction'));
        await stage('transactions');

        await sourceRows.restoreDividends(rows(entities, 'dividend'));
        await stage('dividends');

        await sourceRows.restoreCashMovements(rows(entities, 'cashMovement'));
        await stage('cashMovements');

        const standingOrderRows = rows(entities, 'standingOrder');
        await sourceRows.restoreStandingOrders(userId, standingOrderRows);
        await sourceRows.restoreStandingOrderRuns(standingOrderRows);
        await stage('standingOrders');

        await sourceRows.restoreExpenseCategories(userId, rows(entities, 'expenseCategory'));
        await stage('expenseCategories');

        await sourceRows.restoreExpenseTransactions(userId, rows(entities, 'expenseTransaction'));
        await stage('expenseTransactions');

        await sourceRows.restoreExpenseRules(userId, rows(entities, 'expenseRule'));
        await stage('expenseRules');

        await sourceRows.restoreExpenseBudgets(userId, rows(entities, 'expenseBudget'));
        await stage('expenseBudgets');

        const completedAt = now();
        await transition.setNormalAndClearMedia(userId);
        await transition.deleteServerCiphertext(userId);
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
