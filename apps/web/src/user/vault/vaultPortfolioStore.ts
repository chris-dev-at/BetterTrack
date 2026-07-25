import {
  cashEntryRequestSchema,
  cashMovementResponseSchema,
  cashMovementSchema,
  createPortfolioRequestSchema,
  createTransactionsRequestSchema,
  portfolioAssetSchema,
  portfolioListResponseSchema,
  portfolioSummarySchema,
  transactionInputSchema,
  transactionListQuerySchema,
  transactionListResponseSchema,
  transactionSchema,
  updatePortfolioRequestSchema,
  updateTransactionRequestSchema,
  type CashEntryRequest,
  type CashMovementResponse,
  type PortfolioAsset,
  type PortfolioSummary,
  type Transaction,
  type VaultDocumentV1,
  type VaultEntity,
  type VaultEntityKind,
} from '@bettertrack/contracts';
import {
  cashBalancesBySource,
  floorCents,
  projectCashLedgerBySource,
  type SourcedCashMovement,
} from '@bettertrack/domain/cashLedger';
import { uuidv7 } from 'uuidv7';

import type { PortfolioStore } from '../../lib/portfolioStore';

import { VaultCryptoError } from './errors';
import type { VaultSyncEngine } from './sync';

export const VAULT_PORTFOLIO_STORE_ERROR_CODES = [
  'VAULT_LOCKED',
  'VAULT_CORRUPT',
  'VAULT_DATA_UNAVAILABLE',
  'VAULT_ENTITY_NOT_FOUND',
  'VAULT_OPERATION_UNAVAILABLE',
  'VAULT_DATA_INVALID',
  'VAULT_LAST_ACTIVE_PORTFOLIO',
] as const;

export type VaultPortfolioStoreErrorCode = (typeof VAULT_PORTFOLIO_STORE_ERROR_CODES)[number];

/** A fail-closed error from the decrypted portfolio-data boundary. */
export class VaultPortfolioStoreError extends Error {
  constructor(
    public readonly code: VaultPortfolioStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'VaultPortfolioStoreError';
  }
}

export interface VaultPortfolioStoreOptions {
  now?: () => string;
  newId?: () => string;
}

interface StoreContext {
  engine: VaultSyncEngine;
  now: () => string;
  newId: () => string;
}

/**
 * PortfolioStore for paranoid accounts. The only mutable dependency is the
 * authenticated sync engine: reads use its in-memory active document and every
 * write goes through `mutate`, which persists the next encrypted CAS version.
 */
export function createVaultPortfolioStore(
  engine: VaultSyncEngine,
  options: VaultPortfolioStoreOptions = {},
): PortfolioStore {
  const context: StoreContext = {
    engine,
    now: options.now ?? (() => new Date().toISOString()),
    newId: options.newId ?? generateId,
  };

  return {
    async listPortfolios(signal, includeArchived = false) {
      signal?.throwIfAborted();
      const portfolios = liveEntities(requireDocument(engine), 'portfolio')
        .map(portfolioSummaryFromEntity)
        .filter((portfolio) => includeArchived || portfolio.archivedAt === null)
        .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
      return parseVaultData(
        () => portfolioListResponseSchema.parse({ portfolios }),
        'Vault portfolios do not match the portfolio contract.',
      );
    },

    async createPortfolio(name) {
      const parsedName = createPortfolioRequestSchema.parse({ name }).name;
      const entity = await appendEntity(context, 'portfolio', (document, id, timestamp) => {
        const portfolios = liveEntities(document, 'portfolio').map(portfolioSummaryFromEntity);
        const active = portfolios.filter((portfolio) => portfolio.archivedAt === null);
        const highestSortOrder = portfolios.reduce(
          (highest, portfolio) => Math.max(highest, portfolio.sortOrder),
          -1,
        );
        return entityRecord(id, engine.deviceId, timestamp, {
          name: parsedName,
          visibility: 'private',
          sortOrder: highestSortOrder + 1,
          isDefault: active.length === 0,
          defaultPayFromCash: false,
          archivedAt: null,
        });
      });
      return portfolioSummaryFromEntity(entity);
    },

    async getPortfolio(portfolioId, signal) {
      signal?.throwIfAborted();
      requirePortfolio(requireDocument(engine), portfolioId);
      throw storeError(
        'VAULT_OPERATION_UNAVAILABLE',
        'Client-side holdings and valuation are not available from this store yet.',
      );
    },

    async updatePortfolio(portfolioId, patch) {
      portfolioSummaryFromEntity(requirePortfolio(requireDocument(engine), portfolioId));
      const parsedPatch = updatePortfolioRequestSchema.parse(patch);
      const entity = await updateEntity(context, 'portfolio', portfolioId, (data) => ({
        ...data,
        ...parsedPatch,
      }));
      return portfolioSummaryFromEntity(entity);
    },

    async deletePortfolio(portfolioId) {
      await deletePortfolioTree(context, portfolioId);
    },

    async listTransactions(portfolioId, params = {}, signal) {
      signal?.throwIfAborted();
      const document = requireDocument(engine);
      requirePortfolio(document, portfolioId);
      const parsedParams = transactionListQuerySchema.parse(params);
      const all = liveEntities(document, 'transaction')
        .filter((entity) => stringField(entity.data, 'portfolioId') === portfolioId)
        .map((entity) => ({ entity, transaction: transactionFromEntity(document, entity) }))
        .filter(
          ({ transaction }) =>
            parsedParams.source == null || transaction.source === parsedParams.source,
        )
        .sort(
          (left, right) =>
            right.transaction.executedAt.localeCompare(left.transaction.executedAt) ||
            right.entity.id.localeCompare(left.entity.id),
        );
      const cursorIndex =
        parsedParams.cursor == null
          ? -1
          : all.findIndex(({ entity }) => entity.id === parsedParams.cursor);
      const start = cursorIndex < 0 ? 0 : cursorIndex + 1;
      const limit = parsedParams.limit ?? 50;
      const page = all.slice(start, start + limit);
      return parseVaultData(
        () =>
          transactionListResponseSchema.parse({
            items: page.map(({ transaction }) => transaction),
            nextCursor: start + page.length < all.length ? (page.at(-1)?.entity.id ?? null) : null,
          }),
        'Vault transactions do not match the transaction-list contract.',
      );
    },

    async createTransactions(portfolioId, inputs) {
      requireDocument(engine);
      const parsedRequest = createTransactionsRequestSchema.parse({ transactions: inputs });
      const parsedInputs =
        'transactions' in parsedRequest ? parsedRequest.transactions : [parsedRequest];
      assertLocallySupportedTransactions(parsedInputs);
      const createdIds: string[] = [];

      await engine.mutate(({ document }) => {
        requirePortfolio(document, portfolioId);
        const timestamp = context.now();
        const entities = parsedInputs.map((input) => {
          const id = safeNewId(context);
          createdIds.push(id);
          resolveTransactionAsset(document, input.assetId);
          return entityRecord(id, engine.deviceId, timestamp, {
            ...input,
            portfolioId,
            note: input.note ?? null,
            allowUncovered: input.allowUncovered ?? false,
            uncoveredEntryPrice: input.uncoveredEntryPrice ?? null,
            source: 'manual',
          });
        });
        return appendEntities(document, 'transaction', entities);
      });

      const committed = requireDocument(engine);
      return createdIds.map((id) => {
        const entity = findLiveEntity(committed, 'transaction', id);
        if (entity == null) {
          throw storeError(
            'VAULT_DATA_UNAVAILABLE',
            'The committed vault transaction is not readable.',
          );
        }
        return transactionFromEntity(committed, entity);
      });
    },

    async updateTransaction(portfolioId, transactionId, patch) {
      const parsedPatch = updateTransactionRequestSchema.parse(patch);
      const { baseSeq: _baseSeq, ...dataPatch } = parsedPatch;
      const current = requireDocument(engine);
      requirePortfolio(current, portfolioId);
      transactionFromEntity(
        current,
        requireOwnedEntity(current, 'transaction', transactionId, portfolioId),
      );
      const entity = await updateEntity(context, 'transaction', transactionId, (data) => ({
        ...data,
        ...dataPatch,
      }));
      return transactionFromEntity(requireDocument(engine), entity);
    },

    async deleteTransaction(portfolioId, transactionId) {
      const document = requireDocument(engine);
      requirePortfolio(document, portfolioId);
      requireOwnedEntity(document, 'transaction', transactionId, portfolioId);
      await deleteTransactionTree(context, portfolioId, transactionId);
    },

    async depositCash(portfolioId, body) {
      return createCashMovement(context, portfolioId, body, 'deposit');
    },

    async withdrawCash(portfolioId, body) {
      return createCashMovement(context, portfolioId, body, 'withdrawal');
    },
  };
}

/** Public name used by the architecture note. */
export const vaultPortfolioStore = createVaultPortfolioStore;

function requireDocument(engine: VaultSyncEngine): VaultDocumentV1 {
  const state = engine.state;
  if (state.status === 'locked') {
    throw storeError('VAULT_LOCKED', 'The vault must be unlocked before portfolio data is read.');
  }
  if (state.status === 'corrupt') {
    throw storeError(
      'VAULT_CORRUPT',
      'Corrupt vault data cannot be exposed to portfolio features.',
    );
  }
  if (state.active == null) {
    throw storeError('VAULT_DATA_UNAVAILABLE', 'No authenticated vault document is available.');
  }
  return state.active.document;
}

function requirePortfolio(document: VaultDocumentV1, portfolioId: string): VaultEntity {
  const portfolio = findLiveEntity(document, 'portfolio', portfolioId);
  if (portfolio == null) {
    throw storeError('VAULT_ENTITY_NOT_FOUND', 'Portfolio not found in the active vault document.');
  }
  return portfolio;
}

function requireOwnedEntity(
  document: VaultDocumentV1,
  kind: VaultEntityKind,
  id: string,
  portfolioId: string,
): VaultEntity {
  const entity = findLiveEntity(document, kind, id);
  if (entity == null || stringField(entity.data, 'portfolioId') !== portfolioId) {
    throw storeError('VAULT_ENTITY_NOT_FOUND', `${kind} not found in the selected portfolio.`);
  }
  return entity;
}

async function appendEntity(
  context: StoreContext,
  kind: VaultEntityKind,
  build: (document: VaultDocumentV1, id: string, timestamp: string) => VaultEntity,
): Promise<VaultEntity> {
  requireDocument(context.engine);
  let id: string | null = null;
  await context.engine.mutate(({ document }) => {
    id = safeNewId(context);
    const entity = build(document, id, context.now());
    return appendEntities(document, kind, [entity]);
  });
  const committed = id == null ? null : findLiveEntity(requireDocument(context.engine), kind, id);
  if (committed == null) {
    throw storeError('VAULT_DATA_UNAVAILABLE', 'The vault mutation was not committed locally.');
  }
  return committed;
}

async function updateEntity(
  context: StoreContext,
  kind: VaultEntityKind,
  id: string,
  mutateData: (data: Record<string, unknown>) => Record<string, unknown>,
): Promise<VaultEntity> {
  requireDocument(context.engine);
  await context.engine.mutate(({ document }) => {
    const entities = document.entities[kind] ?? [];
    const existing = entities.find((entity) => entity.id === id && entity.deletedAt === null);
    if (existing == null) {
      throw storeError('VAULT_ENTITY_NOT_FOUND', `${kind} no longer exists in the vault.`);
    }
    const updated: VaultEntity = {
      ...existing,
      rev: existing.rev + 1,
      editedAt: context.now(),
      editedBy: context.engine.deviceId,
      data: mutateData(existing.data),
    };
    return replaceEntity(document, kind, updated);
  });
  const committed = findLiveEntity(requireDocument(context.engine), kind, id);
  if (committed == null) {
    throw storeError('VAULT_DATA_UNAVAILABLE', 'The updated vault entity is not readable.');
  }
  return committed;
}

async function deletePortfolioTree(context: StoreContext, portfolioId: string): Promise<void> {
  requireDocument(context.engine);
  await context.engine.mutate(({ document }) => {
    const portfolio = requirePortfolio(document, portfolioId);
    const summary = portfolioSummaryFromEntity(portfolio);
    const activePortfolios = liveEntities(document, 'portfolio')
      .map(portfolioSummaryFromEntity)
      .filter((candidate) => candidate.archivedAt === null);
    if (summary.archivedAt === null && activePortfolios.length <= 1) {
      throw storeError(
        'VAULT_LAST_ACTIVE_PORTFOLIO',
        'The last active portfolio cannot be deleted.',
      );
    }
    const timestamp = context.now();
    let next = replaceEntity(
      document,
      'portfolio',
      tombstoneEntity(portfolio, context.engine.deviceId, timestamp),
    );
    if (summary.isDefault) {
      const successorSummary = activePortfolios
        .filter((candidate) => candidate.id !== portfolioId)
        .sort(
          (left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id),
        )[0];
      const successor =
        successorSummary == null ? null : findLiveEntity(next, 'portfolio', successorSummary.id);
      if (successor != null) {
        next = replaceEntity(next, 'portfolio', {
          ...successor,
          rev: successor.rev + 1,
          editedAt: timestamp,
          editedBy: context.engine.deviceId,
          data: { ...successor.data, isDefault: true },
        });
      }
    }
    for (const kind of PORTFOLIO_CHILD_ENTITY_KINDS) {
      const children = liveEntities(next, kind).filter(
        (entity) => stringField(entity.data, 'portfolioId') === portfolioId,
      );
      for (const child of children) {
        next = replaceEntity(
          next,
          kind,
          tombstoneEntity(child, context.engine.deviceId, timestamp),
        );
      }
    }
    return next;
  });
  const committed = findEntity(requireDocument(context.engine), 'portfolio', portfolioId);
  if (committed?.deletedAt == null) {
    throw storeError('VAULT_DATA_UNAVAILABLE', 'The portfolio deletion was not committed locally.');
  }
}

async function deleteTransactionTree(
  context: StoreContext,
  portfolioId: string,
  transactionId: string,
): Promise<void> {
  requireDocument(context.engine);
  await context.engine.mutate(({ document }) => {
    requirePortfolio(document, portfolioId);
    const transaction = requireOwnedEntity(document, 'transaction', transactionId, portfolioId);
    const timestamp = context.now();
    let next = replaceEntity(
      document,
      'transaction',
      tombstoneEntity(transaction, context.engine.deviceId, timestamp),
    );
    for (const movement of liveEntities(next, 'cashMovement').filter(
      (entity) => nullableStringField(entity.data, 'transactionId') === transactionId,
    )) {
      next = replaceEntity(
        next,
        'cashMovement',
        tombstoneEntity(movement, context.engine.deviceId, timestamp),
      );
    }
    return next;
  });
  const committed = findEntity(requireDocument(context.engine), 'transaction', transactionId);
  if (committed?.deletedAt == null) {
    throw storeError(
      'VAULT_DATA_UNAVAILABLE',
      'The transaction deletion was not committed locally.',
    );
  }
}

async function createCashMovement(
  context: StoreContext,
  portfolioId: string,
  body: CashEntryRequest,
  kind: 'deposit' | 'withdrawal',
): Promise<CashMovementResponse> {
  requireDocument(context.engine);
  const parsedBody = cashEntryRequestSchema.parse(body);
  const amountEur = floorCents(parsedBody.amountEur);
  let createdId: string | null = null;

  await context.engine.mutate(({ document }) => {
    requirePortfolio(document, portfolioId);
    const sourceId = resolveCashSourceId(document, portfolioId, parsedBody.sourceId);
    const timestamp = context.now();
    const id = safeNewId(context);
    const entity = entityRecord(id, context.engine.deviceId, timestamp, {
      ...parsedBody,
      amountEur: kind === 'withdrawal' ? -amountEur : amountEur,
      portfolioId,
      kind,
      source: 'manual',
      sourceId,
      executedAt: parsedBody.executedAt ?? timestamp,
      createdAt: timestamp,
      note: parsedBody.note ?? null,
      transactionId: null,
      transferId: null,
      counterpartSourceId: null,
      dividendId: null,
      taxYear: null,
    });
    projectCashLedgerBySource([
      ...domainCashMovements(document, portfolioId),
      domainCashMovement(entity),
    ]);
    createdId = id;
    return appendEntities(document, 'cashMovement', [entity]);
  });

  const committedDocument = requireDocument(context.engine);
  const committed =
    createdId == null ? null : findLiveEntity(committedDocument, 'cashMovement', createdId);
  if (committed == null) {
    throw storeError('VAULT_DATA_UNAVAILABLE', 'The cash movement was not committed locally.');
  }

  const movements = domainCashMovements(committedDocument, portfolioId);
  projectCashLedgerBySource(movements);
  const balances = cashBalancesBySource(movements);
  const sourceId = stringField(committed.data, 'sourceId');
  const balanceEur = [...balances.values()].reduce((sum, value) => sum + value, 0);
  return parseVaultData(
    () =>
      cashMovementResponseSchema.parse({
        movement: cashMovementFromEntity(committed),
        sourceBalanceEur: balances.get(sourceId) ?? 0,
        balanceEur,
      }),
    'The committed cash movement does not match the cash response contract.',
  );
}

function appendEntities(
  document: VaultDocumentV1,
  kind: VaultEntityKind,
  entities: VaultEntity[],
): VaultDocumentV1 {
  return {
    ...document,
    entities: {
      ...document.entities,
      [kind]: [...(document.entities[kind] ?? []), ...entities],
    },
  };
}

function replaceEntity(
  document: VaultDocumentV1,
  kind: VaultEntityKind,
  replacement: VaultEntity,
): VaultDocumentV1 {
  return {
    ...document,
    entities: {
      ...document.entities,
      [kind]: (document.entities[kind] ?? []).map((entity) =>
        entity.id === replacement.id ? replacement : entity,
      ),
    },
  };
}

function entityRecord(
  id: string,
  deviceId: string,
  timestamp: string,
  data: Record<string, unknown>,
): VaultEntity {
  return { id, rev: 0, editedAt: timestamp, editedBy: deviceId, deletedAt: null, data };
}

const PORTFOLIO_CHILD_ENTITY_KINDS = [
  'transaction',
  'dividend',
  'cashSource',
  'cashMovement',
  'portfolioSetting',
  'standingOrder',
] as const satisfies readonly VaultEntityKind[];

function tombstoneEntity(entity: VaultEntity, deviceId: string, timestamp: string): VaultEntity {
  return {
    ...entity,
    rev: entity.rev + 1,
    editedAt: timestamp,
    editedBy: deviceId,
    deletedAt: timestamp,
  };
}

function liveEntities(document: VaultDocumentV1, kind: VaultEntityKind): VaultEntity[] {
  return (document.entities[kind] ?? []).filter((entity) => entity.deletedAt === null);
}

function findEntity(
  document: VaultDocumentV1,
  kind: VaultEntityKind,
  id: string,
): VaultEntity | undefined {
  return (document.entities[kind] ?? []).find((entity) => entity.id === id);
}

function findLiveEntity(
  document: VaultDocumentV1,
  kind: VaultEntityKind,
  id: string,
): VaultEntity | undefined {
  const entity = findEntity(document, kind, id);
  return entity?.deletedAt === null ? entity : undefined;
}

function resolveCashSourceId(
  document: VaultDocumentV1,
  portfolioId: string,
  requestedSourceId: string | undefined,
): string {
  const source = liveEntities(document, 'cashSource').find(
    (entity) =>
      stringField(entity.data, 'portfolioId') === portfolioId &&
      nullableStringField(entity.data, 'archivedAt') === null &&
      (requestedSourceId == null
        ? booleanField(entity.data, 'isMain', false)
        : entity.id === requestedSourceId),
  );
  if (source == null) {
    throw storeError(
      'VAULT_ENTITY_NOT_FOUND',
      requestedSourceId == null
        ? 'The selected portfolio has no active Main cash source.'
        : 'The selected cash source is not active in this portfolio.',
    );
  }
  return source.id;
}

function portfolioSummaryFromEntity(entity: VaultEntity): PortfolioSummary {
  return parseVaultData(
    () =>
      portfolioSummarySchema.parse({
        id: entity.id,
        name: stringField(entity.data, 'name'),
        visibility: stringField(entity.data, 'visibility', 'private'),
        sortOrder: numberField(entity.data, 'sortOrder', 0),
        isDefault: booleanField(entity.data, 'isDefault', false),
        defaultPayFromCash: booleanField(entity.data, 'defaultPayFromCash', false),
        archivedAt: nullableStringField(entity.data, 'archivedAt'),
      }),
    'A vault portfolio does not match the portfolio contract.',
  );
}

function resolveTransactionAsset(document: VaultDocumentV1, assetId: string): PortfolioAsset {
  const asset = findLiveEntity(document, 'customAsset', assetId);
  if (asset == null) {
    throw storeError(
      'VAULT_OPERATION_UNAVAILABLE',
      'A local asset snapshot is required before a vault transaction can be created.',
    );
  }
  return portfolioAssetFromEntity(asset);
}

function portfolioAssetFromEntity(entity: VaultEntity): PortfolioAsset {
  const meta = recordField(entity.data, 'meta');
  const isCustom =
    typeof entity.data.isCustom === 'boolean'
      ? entity.data.isCustom
      : entity.data.ownerId != null ||
        stringField(entity.data, 'providerId', 'manual') === 'manual' ||
        stringField(entity.data, 'type') === 'custom';
  return parseVaultData(
    () =>
      portfolioAssetSchema.parse({
        id: entity.id,
        symbol: stringField(entity.data, 'symbol'),
        name: stringField(entity.data, 'name'),
        exchange: nullableStringField(entity.data, 'exchange'),
        currency: stringField(entity.data, 'currency'),
        type: stringField(entity.data, 'type'),
        isCustom,
        category: isCustom
          ? (nullableStringField(entity.data, 'category') ??
            (meta == null ? null : nullableStringField(meta, 'category')))
          : null,
        smoothing:
          typeof entity.data.smoothing === 'boolean'
            ? entity.data.smoothing
            : meta == null
              ? undefined
              : booleanField(meta, 'smoothing', false),
      }),
    'The local vault asset snapshot does not match the portfolio asset contract.',
  );
}

function transactionFromEntity(document: VaultDocumentV1, entity: VaultEntity): Transaction {
  const assetId = stringField(entity.data, 'assetId');
  const assetEntity = findLiveEntity(document, 'customAsset', assetId);
  const embeddedAsset = recordField(entity.data, 'asset');
  const asset =
    assetEntity != null
      ? portfolioAssetFromEntity(assetEntity)
      : embeddedAsset != null
        ? embeddedAsset
        : null;
  if (asset == null) {
    throw storeError('VAULT_DATA_INVALID', 'A vault transaction has no local asset snapshot.');
  }
  return parseVaultData(
    () =>
      transactionSchema.parse({
        id: entity.id,
        assetId,
        side: stringField(entity.data, 'side'),
        quantity: numberField(entity.data, 'quantity'),
        price: numberField(entity.data, 'price'),
        fee: numberField(entity.data, 'fee', 0),
        executedAt: stringField(entity.data, 'executedAt'),
        note: nullableStringField(entity.data, 'note'),
        allowUncovered: booleanField(entity.data, 'allowUncovered', false),
        uncoveredEntryPrice: nullableNumberField(entity.data, 'uncoveredEntryPrice'),
        source: stringField(entity.data, 'source', 'manual'),
        asset,
      }),
    'A vault transaction does not match the transaction contract.',
  );
}

function cashMovementFromEntity(entity: VaultEntity): CashMovementResponse['movement'] {
  return parseVaultData(
    () =>
      cashMovementSchema.parse({
        id: entity.id,
        kind: stringField(entity.data, 'kind'),
        amountEur: numberField(entity.data, 'amountEur'),
        sourceId: stringField(entity.data, 'sourceId'),
        transactionId: nullableStringField(entity.data, 'transactionId'),
        transferId: nullableStringField(entity.data, 'transferId'),
        counterpartSourceId: nullableStringField(entity.data, 'counterpartSourceId'),
        dividendId: nullableStringField(entity.data, 'dividendId'),
        taxYear: nullableNumberField(entity.data, 'taxYear'),
        executedAt: stringField(entity.data, 'executedAt', entity.editedAt),
        note: nullableStringField(entity.data, 'note'),
        source: stringField(entity.data, 'source', 'manual'),
        createdAt: stringField(entity.data, 'createdAt', entity.editedAt),
      }),
    'A vault cash movement does not match the cash-movement contract.',
  );
}

function domainCashMovements(
  document: VaultDocumentV1,
  portfolioId: string,
): SourcedCashMovement[] {
  return liveEntities(document, 'cashMovement')
    .filter((entity) => stringField(entity.data, 'portfolioId') === portfolioId)
    .map(domainCashMovement);
}

function domainCashMovement(entity: VaultEntity): SourcedCashMovement {
  const movement = cashMovementFromEntity(entity);
  return {
    kind: movement.kind,
    amountEur: movement.amountEur,
    occurredAt: movement.executedAt,
    sourceId: movement.sourceId,
  };
}

function assertLocallySupportedTransactions(
  inputs: ReturnType<typeof transactionInputSchema.parse>[],
): void {
  const requiresDerivedEngine = inputs.some(
    (input) =>
      input.payFromCash === true ||
      input.addProceedsToCash === true ||
      input.settleCashAsOfToday === true ||
      input.taxAmountEur !== undefined ||
      input.taxRatePct !== undefined,
  );
  if (requiresDerivedEngine) {
    throw storeError(
      'VAULT_OPERATION_UNAVAILABLE',
      'Cash-linked and tax-computed transactions require the client portfolio engine.',
    );
  }
}

function recordField(data: Record<string, unknown>, field: string): Record<string, unknown> | null {
  const value = data[field];
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(data: Record<string, unknown>, field: string, fallback?: string): string {
  const value = data[field];
  if (typeof value === 'string') return value;
  if (fallback !== undefined) return fallback;
  throw storeError('VAULT_DATA_INVALID', `Vault entity field ${field} is missing.`);
}

function nullableStringField(data: Record<string, unknown>, field: string): string | null {
  const value = data[field];
  return typeof value === 'string' ? value : null;
}

function numberField(data: Record<string, unknown>, field: string, fallback?: number): number {
  const value = data[field];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (fallback !== undefined) return fallback;
  throw storeError('VAULT_DATA_INVALID', `Vault entity field ${field} is not numeric.`);
}

function nullableNumberField(data: Record<string, unknown>, field: string): number | null {
  const value = data[field];
  if (value == null) return null;
  return numberField(data, field);
}

function booleanField(data: Record<string, unknown>, field: string, fallback: boolean): boolean {
  return typeof data[field] === 'boolean' ? data[field] : fallback;
}

function safeNewId(context: StoreContext): string {
  try {
    return context.newId();
  } catch (cause) {
    throw new VaultCryptoError('unsupported-crypto', 'UUIDv7 generation is unavailable.', {
      cause,
    });
  }
}

function generateId(): string {
  return uuidv7();
}

function parseVaultData<T>(parse: () => T, message: string): T {
  try {
    return parse();
  } catch (cause) {
    if (cause instanceof VaultPortfolioStoreError) throw cause;
    throw storeError('VAULT_DATA_INVALID', message, cause);
  }
}

function storeError(
  code: VaultPortfolioStoreErrorCode,
  message: string,
  cause?: unknown,
): VaultPortfolioStoreError {
  return new VaultPortfolioStoreError(code, message, cause === undefined ? undefined : { cause });
}
