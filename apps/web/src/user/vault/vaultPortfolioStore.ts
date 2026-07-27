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
  VAULT_ENTITY_ROW_SCHEMAS,
  type CashEntryRequest,
  type CashMovementResponse,
  type CreatePortfolioRequest,
  type PortfolioAsset,
  type PortfolioListResponse,
  type PortfolioResponse,
  type PortfolioSummary,
  type Transaction,
  type TransactionInput,
  type TransactionListResponse,
  type UpdatePortfolioRequest,
  type UpdateTransactionRequest,
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
import { viennaYearOf } from '@bettertrack/domain/tax';
import { uuidv7 } from 'uuidv7';

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

/**
 * The decrypted portfolio-data boundary used by the paranoid-mode bootstrap.
 * It deliberately describes the vault's capabilities without selecting an
 * application-wide transport; that composition belongs to the later bootstrap
 * work, not the tax fence.
 */
export interface VaultPortfolioStore {
  listPortfolios(signal?: AbortSignal, includeArchived?: boolean): Promise<PortfolioListResponse>;
  createPortfolio(name: CreatePortfolioRequest['name']): Promise<PortfolioSummary>;
  getPortfolio(portfolioId: string, signal?: AbortSignal): Promise<PortfolioResponse>;
  updatePortfolio(portfolioId: string, patch: UpdatePortfolioRequest): Promise<PortfolioSummary>;
  deletePortfolio(portfolioId: string): Promise<void>;
  listTransactions(
    portfolioId: string,
    params?: { cursor?: string; limit?: number; source?: string },
    signal?: AbortSignal,
  ): Promise<TransactionListResponse>;
  createTransactions(portfolioId: string, inputs: TransactionInput[]): Promise<Transaction[]>;
  updateTransaction(
    portfolioId: string,
    transactionId: string,
    patch: UpdateTransactionRequest,
  ): Promise<Transaction>;
  deleteTransaction(
    portfolioId: string,
    transactionId: string,
    options?: { baseSeq?: number },
  ): Promise<void>;
  depositCash(portfolioId: string, body: CashEntryRequest): Promise<CashMovementResponse>;
  withdrawCash(portfolioId: string, body: CashEntryRequest): Promise<CashMovementResponse>;
}

interface StoreContext {
  engine: VaultSyncEngine;
  now: () => string;
  newId: () => string;
}

type TransactionDataPatch = Omit<UpdateTransactionRequest, 'baseSeq'>;
type VaultTaxMode = 'none' | 'manual_per_trade' | 'country_specific' | 'custom';

interface EffectivePortfolioTaxSettings {
  mode: VaultTaxMode;
  hasManualDefault: boolean;
}

/**
 * PortfolioStore for paranoid accounts. The only mutable dependency is the
 * authenticated sync engine: reads use its in-memory active document and every
 * write goes through `mutate`, which persists the next encrypted CAS version.
 */
export function createVaultPortfolioStore(
  engine: VaultSyncEngine,
  options: VaultPortfolioStoreOptions = {},
): VaultPortfolioStore {
  const context: StoreContext = {
    engine,
    now: options.now ?? (() => new Date().toISOString()),
    newId: options.newId ?? generateId,
  };

  return {
    async listPortfolios(signal, includeArchived = false) {
      signal?.throwIfAborted();
      const portfolios = portfolioSummariesFromDocument(requireDocument(engine))
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
        const portfolios = portfolioSummariesFromDocument(document);
        const highestSortOrder = portfolios.reduce(
          (highest, portfolio) => Math.max(highest, portfolio.sortOrder),
          -1,
        );
        return entityRecord(
          id,
          engine.deviceId,
          timestamp,
          strictPortfolioData({
            userId: portfolioOwnerUserId(document),
            name: parsedName,
            visibility: 'private',
            sortOrder: highestSortOrder + 1,
            defaultPayFromCash: false,
            archivedAt: null,
          }),
        );
      });
      return portfolioSummaryForId(requireDocument(engine), entity.id);
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
      portfolioSummaryForId(requireDocument(engine), portfolioId);
      const parsedPatch = updatePortfolioRequestSchema.parse(patch);
      const entity = await updateEntity(context, 'portfolio', portfolioId, (data) => ({
        ...data,
        ...parsedPatch,
      }));
      return portfolioSummaryForId(requireDocument(engine), entity.id);
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
      const current = requireDocument(engine);
      requirePortfolio(current, portfolioId);
      const parsedRequest = createTransactionsRequestSchema.parse({ transactions: inputs });
      const parsedInputs =
        'transactions' in parsedRequest ? parsedRequest.transactions : [parsedRequest];
      const candidates = parsedInputs.map((input) => ({
        id: safeNewId(context),
        input,
        data: transactionDataForStorage(portfolioId, input),
      }));
      assertLocallySupportedTransactions(current, portfolioId, candidates, context.now());

      await engine.mutate(({ document }) => {
        requirePortfolio(document, portfolioId);
        assertLocallySupportedTransactions(document, portfolioId, candidates, context.now());
        const timestamp = context.now();
        const entities = candidates.map(({ id, input, data }) => {
          resolveTransactionAsset(document, input.assetId);
          return entityRecord(id, engine.deviceId, timestamp, data);
        });
        return appendEntities(document, 'transaction', entities);
      });

      const committed = requireDocument(engine);
      return candidates.map(({ id }) => {
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
      const { baseSeq: _baseSeq, ...parsedDataPatch } = parsedPatch;
      const dataPatch = definedFields(parsedDataPatch);
      const persistedDataPatch = transactionPatchForStorage(dataPatch);
      const financialEdit = hasFinancialTransactionPatch(dataPatch);
      const current = requireDocument(engine);
      requirePortfolio(current, portfolioId);
      const currentEntity = requireOwnedEntity(current, 'transaction', transactionId, portfolioId);
      transactionFromEntity(current, currentEntity);
      assertTransactionUpdateTaxSupported(
        current,
        portfolioId,
        currentEntity,
        dataPatch,
        financialEdit,
        context.now(),
      );
      const entity = await updateEntity(
        context,
        'transaction',
        transactionId,
        (data, document, existing) => {
          assertTransactionUpdateTaxSupported(
            document,
            portfolioId,
            existing,
            dataPatch,
            financialEdit,
            context.now(),
          );
          return { ...data, ...persistedDataPatch };
        },
      );
      return transactionFromEntity(requireDocument(engine), entity);
    },

    async deleteTransaction(portfolioId, transactionId) {
      const document = requireDocument(engine);
      requirePortfolio(document, portfolioId);
      const transaction = requireOwnedEntity(document, 'transaction', transactionId, portfolioId);
      assertTransactionDeleteTaxSupported(document, portfolioId, transaction, context.now());
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
  mutateData: (
    data: Record<string, unknown>,
    document: VaultDocumentV1,
    entity: VaultEntity,
  ) => Record<string, unknown>,
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
      data: mutateData(existing.data, document, existing),
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
    const summaries = portfolioSummariesFromDocument(document);
    const summary = summaries.find((candidate) => candidate.id === portfolio.id);
    if (summary == null) {
      throw storeError('VAULT_DATA_INVALID', 'The selected vault portfolio has no summary.');
    }
    const activePortfolios = summaries.filter((candidate) => candidate.archivedAt === null);
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
    assertTransactionDeleteTaxSupported(document, portfolioId, transaction, context.now());
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
    const entity = entityRecord(
      id,
      context.engine.deviceId,
      timestamp,
      strictCashMovementData({
        portfolioId,
        sourceId,
        kind,
        amountEur: decimalStringFromNumber(kind === 'withdrawal' ? -amountEur : amountEur),
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: parsedBody.executedAt ?? timestamp,
        note: parsedBody.note ?? null,
        source: 'manual',
        createdAt: timestamp,
      }),
    );
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

function portfolioSummariesFromDocument(document: VaultDocumentV1): PortfolioSummary[] {
  const portfolios = liveEntities(document, 'portfolio');
  const defaultId = defaultPortfolioId(portfolios);
  return portfolios.map((entity) => portfolioSummaryFromEntity(entity, entity.id === defaultId));
}

function portfolioSummaryForId(document: VaultDocumentV1, portfolioId: string): PortfolioSummary {
  requirePortfolio(document, portfolioId);
  const summary = portfolioSummariesFromDocument(document).find(
    (candidate) => candidate.id === portfolioId,
  );
  if (summary == null) {
    throw storeError('VAULT_DATA_INVALID', 'The selected vault portfolio has no summary.');
  }
  return summary;
}

function defaultPortfolioId(portfolios: readonly VaultEntity[]): string | null {
  let best: VaultEntity | null = null;
  for (const portfolio of portfolios) {
    if (nullableStringField(portfolio.data, 'archivedAt') !== null) continue;
    if (
      best == null ||
      numberField(portfolio.data, 'sortOrder', 0) < numberField(best.data, 'sortOrder', 0) ||
      (numberField(portfolio.data, 'sortOrder', 0) === numberField(best.data, 'sortOrder', 0) &&
        portfolio.id < best.id)
    ) {
      best = portfolio;
    }
  }
  return best?.id ?? null;
}

function portfolioOwnerUserId(document: VaultDocumentV1): string {
  const owner = liveEntities(document, 'portfolio')[0];
  if (owner == null) {
    throw storeError(
      'VAULT_OPERATION_UNAVAILABLE',
      'A portfolio owner is required before another vault portfolio can be created.',
    );
  }
  return stringField(owner.data, 'userId');
}

function portfolioSummaryFromEntity(entity: VaultEntity, isDefault: boolean): PortfolioSummary {
  return parseVaultData(
    () =>
      portfolioSummarySchema.parse({
        id: entity.id,
        name: stringField(entity.data, 'name'),
        visibility: stringField(entity.data, 'visibility', 'private'),
        sortOrder: numberField(entity.data, 'sortOrder', 0),
        isDefault,
        defaultPayFromCash: booleanField(entity.data, 'defaultPayFromCash', false),
        archivedAt: nullableStringField(entity.data, 'archivedAt'),
      }),
    'A vault portfolio does not match the portfolio contract.',
  );
}

function strictPortfolioData(data: Record<string, unknown>): Record<string, unknown> {
  return parseVaultData(
    () => VAULT_ENTITY_ROW_SCHEMAS.portfolio.parse(data),
    'A vault portfolio does not match the strict restore contract.',
  );
}

function strictCashMovementData(data: Record<string, unknown>): Record<string, unknown> {
  return parseVaultData(
    () => VAULT_ENTITY_ROW_SCHEMAS.cashMovement.parse(data),
    'A vault cash movement does not match the strict restore contract.',
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

/**
 * Persist the transaction in the exact restore-source row shape. The live
 * transaction API deliberately uses numbers, while an encrypted vault stores
 * PostgreSQL-compatible decimal strings so strict rehydration can replay it
 * without coercion.
 */
function transactionDataForStorage(
  portfolioId: string,
  input: ReturnType<typeof transactionInputSchema.parse>,
): Record<string, unknown> {
  return parseVaultData(
    () =>
      VAULT_ENTITY_ROW_SCHEMAS.transaction.parse({
        portfolioId,
        assetId: input.assetId,
        side: input.side,
        quantity: decimalStringFromNumber(input.quantity),
        price: decimalStringFromNumber(input.price),
        fee: decimalStringFromNumber(input.fee),
        executedAt: input.executedAt,
        note: input.note ?? null,
        taxMode: null,
        taxCountry: null,
        taxAmountEur: null,
        taxParams: null,
        allowUncovered: input.allowUncovered ?? false,
        uncoveredEntryPrice:
          input.uncoveredEntryPrice === undefined
            ? null
            : decimalStringFromNumber(input.uncoveredEntryPrice),
        source: 'manual',
      }),
    'A vault transaction does not match the strict restore contract.',
  );
}

/** Keep financial patches in the same persisted decimal representation as creates. */
function transactionPatchForStorage(patch: TransactionDataPatch): Record<string, unknown> {
  return {
    ...patch,
    ...(patch.quantity === undefined ? {} : { quantity: decimalStringFromNumber(patch.quantity) }),
    ...(patch.price === undefined ? {} : { price: decimalStringFromNumber(patch.price) }),
    ...(patch.fee === undefined ? {} : { fee: decimalStringFromNumber(patch.fee) }),
  };
}

/** Expand JavaScript's exponential notation into the strict decimal grammar. */
function decimalStringFromNumber(value: number): string {
  const source = String(value);
  if (!/[eE]/.test(source)) return source;

  const [coefficient, exponentSource] = source.toLowerCase().split('e');
  const exponent = Number(exponentSource);
  if (coefficient == null || !Number.isInteger(exponent)) {
    throw storeError('VAULT_DATA_INVALID', 'A vault numeric field is not a finite decimal.');
  }

  const negative = coefficient.startsWith('-');
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const [whole = '', fraction = ''] = unsigned.split('.');
  const digits = `${whole}${fraction}`;
  const decimalIndex = whole.length + exponent;
  const result =
    decimalIndex <= 0
      ? `0.${'0'.repeat(-decimalIndex)}${digits}`
      : decimalIndex >= digits.length
        ? `${digits}${'0'.repeat(decimalIndex - digits.length)}`
        : `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  return negative && result !== '0' ? `-${result}` : result;
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

function hasFinancialTransactionPatch(patch: TransactionDataPatch): boolean {
  return (
    patch.side !== undefined ||
    patch.quantity !== undefined ||
    patch.price !== undefined ||
    patch.fee !== undefined ||
    patch.executedAt !== undefined
  );
}

function definedFields<T extends Record<string, unknown>>(
  value: T,
): { [Key in keyof T]?: Exclude<T[Key], undefined> } {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, Exclude<unknown, undefined>] => {
      return entry[1] !== undefined;
    }),
  ) as { [Key in keyof T]?: Exclude<T[Key], undefined> };
}

function assertLocallySupportedTransactions(
  document: VaultDocumentV1,
  portfolioId: string,
  candidates: {
    id: string;
    input: ReturnType<typeof transactionInputSchema.parse>;
  }[],
  now: string,
): void {
  const requiresDerivedEngine = candidates.some(
    ({ input }) =>
      input.payFromCash === true ||
      input.addProceedsToCash === true ||
      input.settleCashAsOfToday === true ||
      input.taxAmountEur !== undefined ||
      input.taxRatePct !== undefined,
  );
  const effectiveTaxSettings = effectivePortfolioTaxSettings(document, portfolioId);
  const effectiveTaxMode = effectiveTaxSettings.mode;
  const openFromYear = taxEngineOpenFromYear(effectiveTaxMode, now);
  const recordsManualDefaultTax =
    effectiveTaxSettings.hasManualDefault && candidates.some(({ input }) => input.side === 'sell');
  const recordsEngineTax = candidates.some(
    ({ input }) => input.side === 'sell' && isAutomaticTaxMode(effectiveTaxMode),
  );
  const existingTransactions = liveEntities(document, 'transaction');
  const reshapesFrozenTax = candidates.some(({ id, input }) =>
    existingTransactions.some(
      (entity) =>
        stringField(entity.data, 'portfolioId') === portfolioId &&
        stringField(entity.data, 'assetId') === input.assetId &&
        sellRequiresClientTaxEngine(entity, openFromYear) &&
        taxSellFollowsTransaction(entity, input.executedAt, id),
    ),
  );
  if (requiresDerivedEngine || recordsManualDefaultTax || recordsEngineTax || reshapesFrozenTax) {
    throw storeError(
      'VAULT_OPERATION_UNAVAILABLE',
      'Cash-linked and tax-computed transactions require the client portfolio engine.',
    );
  }
}

function assertTransactionUpdateTaxSupported(
  document: VaultDocumentV1,
  portfolioId: string,
  transaction: VaultEntity,
  patch: TransactionDataPatch,
  financialEdit: boolean,
  now: string,
): void {
  if (isFrozenTaxSensitiveSell(transaction)) {
    throw taxOperationUnavailable();
  }
  if (!financialEdit) return;
  const assetId = stringField(transaction.data, 'assetId');
  const effectiveTaxMode = effectivePortfolioTaxSettings(document, portfolioId).mode;
  const openFromYear = taxEngineOpenFromYear(effectiveTaxMode, now);
  const prospectiveTransaction: VaultEntity = {
    ...transaction,
    data: definedFields({ ...transaction.data, ...patch }),
  };
  if (
    (isAutomaticTaxMode(effectiveTaxMode) &&
      stringField(prospectiveTransaction.data, 'side') === 'sell') ||
    isFrozenTaxSensitiveSell(prospectiveTransaction) ||
    sellRequiresClientTaxEngine(transaction, openFromYear) ||
    sellRequiresClientTaxEngine(prospectiveTransaction, openFromYear) ||
    liveEntities(document, 'transaction').some(
      (entity) =>
        entity.id !== transaction.id &&
        stringField(entity.data, 'portfolioId') === portfolioId &&
        stringField(entity.data, 'assetId') === assetId &&
        sellRequiresClientTaxEngine(entity, openFromYear) &&
        (taxSellFollowsTransaction(
          entity,
          stringField(transaction.data, 'executedAt'),
          transaction.id,
        ) ||
          taxSellFollowsTransaction(
            entity,
            stringField(prospectiveTransaction.data, 'executedAt'),
            prospectiveTransaction.id,
          )),
    )
  ) {
    throw taxOperationUnavailable();
  }
}

function assertTransactionDeleteTaxSupported(
  document: VaultDocumentV1,
  portfolioId: string,
  transaction: VaultEntity,
  now: string,
): void {
  const assetId = stringField(transaction.data, 'assetId');
  const effectiveTaxMode = effectivePortfolioTaxSettings(document, portfolioId).mode;
  const openFromYear = taxEngineOpenFromYear(effectiveTaxMode, now);
  if (
    isFrozenTaxSensitiveSell(transaction) ||
    (isAutomaticTaxMode(effectiveTaxMode) && stringField(transaction.data, 'side') === 'sell') ||
    sellRequiresClientTaxEngine(transaction, openFromYear) ||
    liveEntities(document, 'transaction').some(
      (entity) =>
        entity.id !== transaction.id &&
        stringField(entity.data, 'portfolioId') === portfolioId &&
        stringField(entity.data, 'assetId') === assetId &&
        sellRequiresClientTaxEngine(entity, openFromYear) &&
        taxSellFollowsTransaction(
          entity,
          stringField(transaction.data, 'executedAt'),
          transaction.id,
        ),
    )
  ) {
    throw taxOperationUnavailable();
  }
}

function effectivePortfolioTaxSettings(
  document: VaultDocumentV1,
  portfolioId: string,
): EffectivePortfolioTaxSettings {
  const override = liveEntities(document, 'portfolioSetting').find(
    (entity) =>
      stringField(entity.data, 'portfolioId') === portfolioId &&
      stringField(entity.data, 'key') === 'tax',
  );
  const overrideSettings = taxSettingsFromData(
    override == null ? null : recordField(override.data, 'value'),
  );
  if (overrideSettings != null) return overrideSettings;

  const portfolio = requirePortfolio(document, portfolioId);
  const userId = nullableStringField(portfolio.data, 'userId');
  const userDefault = liveEntities(document, 'taxSetting')
    .filter(
      (entity) =>
        userId == null ||
        nullableStringField(entity.data, 'userId') == null ||
        nullableStringField(entity.data, 'userId') === userId,
    )
    .sort(
      (left, right) =>
        stringField(left.data, 'updatedAt', left.editedAt).localeCompare(
          stringField(right.data, 'updatedAt', right.editedAt),
        ) || left.id.localeCompare(right.id),
    )
    .at(-1);
  return (
    taxSettingsFromData(userDefault?.data ?? null) ?? { mode: 'none', hasManualDefault: false }
  );
}

function taxSettingsFromData(
  data: Record<string, unknown> | null,
): EffectivePortfolioTaxSettings | null {
  const mode = taxModeField(data);
  if (mode == null) return null;
  return {
    mode,
    hasManualDefault:
      mode === 'manual_per_trade' &&
      (data?.manualDefaultAmountEur != null || data?.manualDefaultRatePct != null),
  };
}

function taxModeField(data: Record<string, unknown> | null): VaultTaxMode | null {
  const mode = data?.mode;
  return mode === 'none' ||
    mode === 'manual_per_trade' ||
    mode === 'country_specific' ||
    mode === 'custom'
    ? mode
    : null;
}

function taxEngineOpenFromYear(mode: VaultTaxMode, now: string): number | null {
  return isAutomaticTaxMode(mode) ? viennaYearOf(now) : null;
}

function isAutomaticTaxMode(mode: VaultTaxMode): mode is 'country_specific' | 'custom' {
  return mode === 'country_specific' || mode === 'custom';
}

function sellRequiresClientTaxEngine(entity: VaultEntity, openFromYear: number | null): boolean {
  if (isEngineTaxedSell(entity)) return true;
  if (
    openFromYear == null ||
    stringField(entity.data, 'side') !== 'sell' ||
    frozenTransactionTaxMode(entity) === 'manual_per_trade'
  ) {
    return false;
  }
  return viennaYearOf(stringField(entity.data, 'executedAt')) >= openFromYear;
}

/**
 * A transaction can only reshape a frozen sell when it precedes that sell in
 * the same deterministic order used by persisted transaction replay.
 */
function taxSellFollowsTransaction(
  sell: VaultEntity,
  transactionExecutedAt: string,
  transactionId: string,
): boolean {
  const sellExecutedAt = Date.parse(stringField(sell.data, 'executedAt'));
  const affectedExecutedAt = Date.parse(transactionExecutedAt);
  if (!Number.isFinite(sellExecutedAt) || !Number.isFinite(affectedExecutedAt)) {
    throw storeError('VAULT_DATA_INVALID', 'A vault transaction has an invalid execution date.');
  }
  const timeDelta = sellExecutedAt - affectedExecutedAt;
  if (timeDelta !== 0) return timeDelta > 0;
  return transactionId.localeCompare(sell.id) < 0;
}

function isEngineTaxedSell(entity: VaultEntity): boolean {
  if (stringField(entity.data, 'side') !== 'sell') return false;
  const mode = frozenTransactionTaxMode(entity);
  return mode === 'country_specific' || mode === 'custom';
}

function isFrozenTaxSensitiveSell(entity: VaultEntity): boolean {
  if (stringField(entity.data, 'side') !== 'sell') return false;
  const mode = frozenTransactionTaxMode(entity);
  return (
    mode === 'manual_per_trade' ||
    mode === 'country_specific' ||
    mode === 'custom' ||
    hasNonzeroFrozenTaxAmount(entity)
  );
}

function hasNonzeroFrozenTaxAmount(entity: VaultEntity): boolean {
  const amount = nullableNumberField(entity.data, 'taxAmountEur');
  return amount !== null && amount !== 0;
}

function frozenTransactionTaxMode(
  entity: VaultEntity,
): 'none' | 'manual_per_trade' | 'country_specific' | 'custom' | null {
  const mode = entity.data.taxMode;
  return mode === 'none' ||
    mode === 'manual_per_trade' ||
    mode === 'country_specific' ||
    mode === 'custom'
    ? mode
    : null;
}

function taxOperationUnavailable(): VaultPortfolioStoreError {
  return storeError(
    'VAULT_OPERATION_UNAVAILABLE',
    'This transaction requires the client tax engine to preserve frozen tax state.',
  );
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
