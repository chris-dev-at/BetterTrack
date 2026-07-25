import {
  customTaxParamsSchema,
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
import {
  dePotCategoryForAssetType,
  realizedSellsEur,
  type SellRealizationEur,
  type TaxableTransaction,
  viennaYearOf,
} from '@bettertrack/domain/tax';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { Database } from '../../data/db';
import { expenseDedupHash } from '../../data/expenseDedup';
import type { CashMovementRecord } from '../../data/repositories/cashMovementRepository';
import { createParanoidRehydrationSourceRepository } from '../../data/repositories/paranoidRehydrationRepository';
import type { DividendRecord } from '../../data/repositories/taxRepository';
import type { TransactionRecord } from '../../data/repositories/transactionRepository';
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
import { reducePosition } from '../../domain/holdings';
import { hasActivePortfolio } from '../portfolio/portfolioService';
import { buildFrozenComponentState, lockedResidueForYear } from '../tax/closedSettlement';
import { portfolioHasDeRows, portfolioHasFiRows } from '../tax/countryState';
import { customParamsKey, portfolioHasCustomRows } from '../tax/customState';
import {
  closedYearSlice,
  openDerivableYears,
  settleOpenYears,
  type OpenRegime,
} from '../tax/openYear';

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
  const portfolioRows = rows(entities, 'portfolio');
  if (!hasActivePortfolio(portfolioRows.map((portfolio) => portfolio.data))) {
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

interface ReferencedAsset {
  currency: string;
  type: string;
}

async function resolveReferencedAssets(
  tx: Database,
  entities: readonly Entity[],
): Promise<ReadonlyMap<string, ReferencedAsset>> {
  const assetsById = new Map<string, ReferencedAsset>(
    rows(entities, 'customAsset').map((entity) => [
      entity.id,
      { currency: entity.data.currency, type: entity.data.type },
    ]),
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
  const found = await tx
    .select({ id: assets.id, currency: assets.currency, type: assets.type })
    .from(assets)
    .where(and(inArray(assets.id, marketAssetIds), isNull(assets.ownerId)));
  requireSubset(marketAssetIds, new Set(found.map((asset) => asset.id)), 'restore source');
  for (const asset of found) {
    assetsById.set(asset.id, { currency: asset.currency, type: asset.type });
  }
  return assetsById;
}

/**
 * Normal transaction writes derive a linked gross movement from the immutable
 * trade facts. A decrypted document may not substitute its own amount: doing so
 * would manufacture cash while retaining an otherwise valid transaction.
 */
async function validateTradeCashLinks(
  entities: readonly Entity[],
  referencedAssets: ReadonlyMap<string, ReferencedAsset>,
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
    const asset = referencedAssets.get(transaction.data.assetId);
    if (!asset) {
      throw new ParanoidRehydrationError('INVALID_REFERENCE', 'transaction asset is unavailable');
    }
    const nativeAmount =
      transaction.data.side === 'buy'
        ? transaction.data.quantity * transaction.data.price + transaction.data.fee
        : transaction.data.quantity * transaction.data.price - transaction.data.fee;
    const day = new Date(transaction.data.executedAt).toISOString().slice(0, 10);
    const expectedMagnitude = floorCents(await toCashEur(nativeAmount, asset.currency, day));
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

function toTransactionRecord(entity: EntityOf<'transaction'>): TransactionRecord {
  return {
    id: entity.id,
    portfolioId: entity.data.portfolioId,
    assetId: entity.data.assetId,
    side: entity.data.side,
    quantity: entity.data.quantity,
    price: entity.data.price,
    fee: entity.data.fee,
    executedAt: new Date(entity.data.executedAt),
    note: entity.data.note,
    taxMode: entity.data.taxMode,
    taxCountry: entity.data.taxCountry,
    taxAmountEur: entity.data.taxAmountEur,
    taxParams: entity.data.taxParams,
    allowUncovered: entity.data.allowUncovered,
    uncoveredEntryPrice: entity.data.uncoveredEntryPrice,
    source: entity.data.source,
  };
}

function toDividendRecord(entity: EntityOf<'dividend'>): DividendRecord {
  return {
    id: entity.id,
    portfolioId: entity.data.portfolioId,
    assetId: entity.data.assetId,
    cashSourceId: entity.data.cashSourceId,
    grossAmountEur: entity.data.grossAmountEur,
    executedAt: new Date(entity.data.executedAt),
    note: entity.data.note,
    taxMode: entity.data.taxMode,
    taxCountry: entity.data.taxCountry,
    taxAmountEur: entity.data.taxAmountEur,
    taxParams: entity.data.taxParams,
    source: entity.data.source,
    createdAt: new Date(entity.editedAt),
  };
}

function toCashMovementRecord(entity: EntityOf<'cashMovement'>): CashMovementRecord {
  return {
    id: entity.id,
    portfolioId: entity.data.portfolioId,
    sourceId: entity.data.sourceId,
    kind: entity.data.kind,
    amountEur: entity.data.amountEur,
    transactionId: entity.data.transactionId,
    transferId: entity.data.transferId,
    counterpartSourceId: entity.data.counterpartSourceId,
    dividendId: entity.data.dividendId,
    taxYear: entity.data.taxYear,
    executedAt: new Date(entity.data.executedAt),
    note: entity.data.note,
    source: entity.data.source,
    createdAt: new Date(entity.editedAt),
  };
}

function validateFrozenEngineTaxFacts(
  entity: EntityOf<'transaction'> | EntityOf<'dividend'>,
): boolean {
  if (entity.data.taxMode !== 'country_specific' && entity.data.taxMode !== 'custom') return false;
  if (entity.data.taxMode === 'country_specific') {
    if (
      entity.data.taxCountry !== 'AT' &&
      entity.data.taxCountry !== 'DE' &&
      entity.data.taxCountry !== 'FI'
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        `country tax row ${entity.id} has an unsupported frozen country`,
      );
    }
    return true;
  }
  if (!customTaxParamsSchema.safeParse(entity.data.taxParams).success) {
    throw new ParanoidRehydrationError(
      'INVALID_REFERENCE',
      `custom tax row ${entity.id} has invalid frozen parameters`,
    );
  }
  return true;
}

function taxOpenRegimeFromSettings(entities: readonly Entity[], portfolioId: string): OpenRegime {
  const setting = rows(entities, 'portfolioSetting').find(
    (entity) => entity.data.portfolioId === portfolioId && entity.data.key === 'tax',
  );
  if (!setting) return { kind: 'none' };
  const value = setting.data.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ParanoidRehydrationError('INVALID_REFERENCE', 'portfolio tax override is malformed');
  }
  const raw = value as Record<string, unknown>;
  if (raw.mode === 'none') return { kind: 'none' };
  if (raw.mode === 'manual_per_trade') return { kind: 'manual' };
  if (raw.mode === 'country_specific') {
    if (raw.country === 'AT' || raw.country === 'DE' || raw.country === 'FI') {
      return { kind: 'country', country: raw.country };
    }
    throw new ParanoidRehydrationError(
      'INVALID_REFERENCE',
      'country tax override needs a supported country',
    );
  }
  if (raw.mode === 'custom') {
    const params = customTaxParamsSchema.safeParse(raw.custom);
    if (params.success) return { kind: 'custom', params: params.data };
  }
  throw new ParanoidRehydrationError('INVALID_REFERENCE', 'portfolio tax override is malformed');
}

function validateTaxSettingsRehydration(entities: readonly Entity[]): void {
  for (const setting of rows(entities, 'taxSetting')) {
    const value = setting.data;
    if (
      (value.mode === 'country_specific') !== (value.country !== null) ||
      (value.mode === 'custom') !== (value.customParams !== null) ||
      (value.mode !== 'manual_per_trade' &&
        (value.manualDefaultAmountEur !== null || value.manualDefaultRatePct !== null)) ||
      (value.manualDefaultAmountEur !== null && value.manualDefaultRatePct !== null)
    ) {
      throw new ParanoidRehydrationError('INVALID_REFERENCE', 'tax setting is malformed');
    }
    if (value.mode === 'custom' && !customTaxParamsSchema.safeParse(value.customParams).success) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'tax setting custom parameters are invalid',
      );
    }
  }

  for (const setting of rows(entities, 'portfolioSetting')) {
    if (setting.data.key === 'tax') taxOpenRegimeFromSettings(entities, setting.data.portfolioId);
  }
}

function openTaxTarget(
  transactions: readonly TransactionRecord[],
  dividends: readonly DividendRecord[],
  movements: readonly CashMovementRecord[],
  frozen: ReturnType<typeof buildFrozenComponentState>,
  regime: Exclude<OpenRegime, { kind: 'manual' }>,
  openFrom: number,
  categoryOf: (assetId: string) => ReturnType<typeof dePotCategoryForAssetType>,
  movingAverageRealizations: ReadonlyMap<string, SellRealizationEur>,
  fifoRealizations: ReadonlyMap<string, SellRealizationEur>,
): void {
  const years = openDerivableYears(
    { transactions, dividendRows: dividends, yearOf: (at) => viennaYearOf(at.toISOString()) },
    movements,
    openFrom,
  );
  if (years.length === 0) return;
  const settlements = settleOpenYears({
    regime,
    view: {
      transactions,
      dividendRows: dividends,
      realizationsFor: (strategy) =>
        strategy === 'fifo' ? fifoRealizations : movingAverageRealizations,
      categoryOf,
      yearOf: (at) => viennaYearOf(at.toISOString()),
    },
    years,
    heldOf: (_year) => 0,
    closedDeEvents:
      regime.kind === 'country' && regime.country === 'DE'
        ? closedYearSlice(frozen.deEvents, openFrom)
        : undefined,
    closedCustomEvents:
      regime.kind === 'custom'
        ? closedYearSlice(
            frozen.customGroups.get(customParamsKey(regime.params))?.eventsByYear ?? new Map(),
            openFrom,
          )
        : undefined,
  });
  for (const settlement of settlements) {
    if (settlement.targetAfterEur < 0) {
      throw new ParanoidRehydrationError('INVALID_REFERENCE', 'open tax target is invalid');
    }
  }
}

async function validateTaxRehydration(
  entities: readonly Entity[],
  referencedAssets: ReadonlyMap<string, ReferencedAsset>,
  toCashEur: (amount: number, currency: string, day: string) => Promise<number>,
  now: Date,
): Promise<void> {
  validateTaxSettingsRehydration(entities);
  const transactions = rows(entities, 'transaction').map(toTransactionRecord);
  const dividends = rows(entities, 'dividend').map(toDividendRecord);
  const movements = rows(entities, 'cashMovement').map(toCashMovementRecord);
  const transactionsById = new Map(
    transactions.map((transaction) => [transaction.id, transaction]),
  );
  const dividendsById = new Map(dividends.map((dividend) => [dividend.id, dividend]));

  const linkedTaxMovements = new Set<string>();
  for (const movement of movements) {
    if (movement.kind !== 'tax_withholding' && movement.kind !== 'tax_refund') continue;
    const linked = movement.transactionId
      ? transactionsById.get(movement.transactionId)
      : movement.dividendId
        ? dividendsById.get(movement.dividendId)
        : undefined;
    if (!linked) continue;
    const frozenTax = linked.taxAmountEur;
    if (
      frozenTax === null ||
      frozenTax === 0 ||
      movement.amountEur !== -frozenTax ||
      movement.taxYear !== viennaYearOf(linked.executedAt.toISOString())
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'linked tax movement does not match its frozen tax fact',
      );
    }
    linkedTaxMovements.add(movement.id);
  }

  for (const entity of [...rows(entities, 'transaction'), ...rows(entities, 'dividend')]) {
    if (!validateFrozenEngineTaxFacts(entity)) continue;
    const linked = movements.filter(
      (movement) =>
        (entity.kind === 'transaction'
          ? movement.transactionId === entity.id
          : movement.dividendId === entity.id) &&
        (movement.kind === 'tax_withholding' || movement.kind === 'tax_refund'),
    );
    if (linked.length > 1 || (linked.length === 1 && !linkedTaxMovements.has(linked[0]!.id))) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'engine tax rows require exactly their matching tax settlement',
      );
    }
  }

  const assetById = referencedAssets;
  const taxables: TaxableTransaction[] = await Promise.all(
    transactions.map(async (transaction): Promise<TaxableTransaction> => {
      const asset = assetById.get(transaction.assetId);
      if (!asset) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'tax transaction asset is unavailable',
        );
      }
      const day = transaction.executedAt.toISOString().slice(0, 10);
      return {
        id: transaction.id,
        assetId: transaction.assetId,
        side: transaction.side,
        quantity: transaction.quantity,
        priceEur:
          transaction.price === 0 ? 0 : await toCashEur(transaction.price, asset.currency, day),
        feeEur: transaction.fee === 0 ? 0 : await toCashEur(transaction.fee, asset.currency, day),
        executedAt: transaction.executedAt.toISOString(),
        allowUncovered: transaction.allowUncovered,
        uncoveredEntryPriceEur:
          transaction.uncoveredEntryPrice === null || transaction.uncoveredEntryPrice === 0
            ? transaction.uncoveredEntryPrice
            : await toCashEur(transaction.uncoveredEntryPrice, asset.currency, day),
      };
    }),
  );
  const movingAverageRealizations = new Map<string, SellRealizationEur>();
  for (const realization of realizedSellsEur(taxables)) {
    movingAverageRealizations.set(realization.id, realization);
  }
  const fifoRealizations = new Map<string, SellRealizationEur>();
  for (const realization of realizedSellsEur(taxables, 'fifo')) {
    fifoRealizations.set(realization.id, realization);
  }
  const categoryOf = (assetId: string) => {
    const asset = assetById.get(assetId);
    if (!asset) throw new ParanoidRehydrationError('INVALID_REFERENCE', 'tax asset is unavailable');
    return dePotCategoryForAssetType(asset.type);
  };

  for (const portfolio of rows(entities, 'portfolio')) {
    const portfolioId = portfolio.id;
    const portfolioTransactions = transactions.filter(
      (transaction) => transaction.portfolioId === portfolioId,
    );
    const portfolioDividends = dividends.filter((dividend) => dividend.portfolioId === portfolioId);
    const portfolioMovements = movements.filter((movement) => movement.portfolioId === portfolioId);
    const engineTransactions = portfolioTransactions.filter(
      (transaction) =>
        transaction.side === 'sell' &&
        (transaction.taxMode === 'country_specific' || transaction.taxMode === 'custom'),
    );
    const engineDividends = portfolioDividends.filter(
      (dividend) => dividend.taxMode === 'country_specific' || dividend.taxMode === 'custom',
    );
    if (engineTransactions.length === 0 && engineDividends.length === 0) continue;

    const involveDe = portfolioHasDeRows(portfolioTransactions, portfolioDividends);
    const involveFi = portfolioHasFiRows(portfolioTransactions, portfolioDividends);
    const involveCustom = portfolioHasCustomRows(portfolioTransactions, portfolioDividends);
    const frozen = buildFrozenComponentState({
      transactions: portfolioTransactions,
      dividendRows: portfolioDividends,
      realizations: movingAverageRealizations,
      fifoRealizations,
      categoryOf,
      involveDe,
      involveFi,
      involveCustom,
    });

    const activeOpenRegime = taxOpenRegimeFromSettings(entities, portfolioId);
    const openFrom =
      activeOpenRegime.kind === 'manual'
        ? Number.POSITIVE_INFINITY
        : viennaYearOf(now.toISOString());
    const closedYears = new Set<number>();
    for (const transaction of engineTransactions) {
      const year = viennaYearOf(transaction.executedAt.toISOString());
      if (year < openFrom) closedYears.add(year);
    }
    for (const dividend of engineDividends) {
      const year = viennaYearOf(dividend.executedAt.toISOString());
      if (year < openFrom) closedYears.add(year);
    }
    for (const movement of portfolioMovements) {
      if (
        (movement.kind === 'tax_withholding' || movement.kind === 'tax_refund') &&
        movement.taxYear !== null &&
        movement.taxYear < openFrom
      ) {
        closedYears.add(movement.taxYear);
      }
    }

    for (const year of closedYears) {
      const residue = lockedResidueForYear(frozen, portfolioMovements, year);
      if (!Number.isFinite(residue)) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          `tax year ${year} carries an invalid frozen tax residue`,
        );
      }
    }
    if (activeOpenRegime.kind !== 'manual') {
      openTaxTarget(
        portfolioTransactions,
        portfolioDividends,
        portfolioMovements,
        frozen,
        activeOpenRegime,
        openFrom,
        categoryOf,
        movingAverageRealizations,
        fifoRealizations,
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
        const referencedAssets = await resolveReferencedAssets(tx, entities);
        validateStandingOrderCurrencies(entities, referencedAssets);
        await validateTradeCashLinks(entities, referencedAssets, toCashEur);
        await validateTaxRehydration(entities, referencedAssets, toCashEur, now());

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
