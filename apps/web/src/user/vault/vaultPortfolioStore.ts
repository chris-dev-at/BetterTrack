import {
  cashEntryRequestSchema,
  cashMovementResponseSchema,
  cashMovementSchema,
  createPortfolioRequestSchema,
  createTransactionsRequestSchema,
  portfolioAssetSchema,
  portfolioListResponseSchema,
  portfolioResponseSchema,
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
  type PortfolioResponse,
  type PortfolioSummary,
  type Transaction,
  type UpdateTransactionRequest,
  type VaultDocumentV1,
  type VaultEntity,
  type VaultEntityKind,
} from '@bettertrack/contracts';
import {
  cashBalance,
  cashBalancesBySource,
  floorCents,
  InsufficientCashError,
  projectCashLedgerBySource,
  type SourcedCashMovement,
} from '@bettertrack/domain/cashLedger';
import { OversellError, reducePosition } from '@bettertrack/domain/holdings';
import { viennaYearOf } from '@bettertrack/domain/tax';
import { uuidv7 } from 'uuidv7';

import type { PortfolioStore } from '../../lib/portfolioStore';

import { VaultCryptoError } from './errors';
import type { VaultDocumentReconcileContext, VaultSyncEngine, VaultSyncState } from './sync';

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
  newMutationId?: () => string;
}

interface StoreContext {
  engine: VaultSyncEngine;
  now: () => string;
  newId: () => string;
  newMutationId: () => string;
}

type TransactionDataPatch = Omit<UpdateTransactionRequest, 'baseSeq'>;

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
    newMutationId: options.newMutationId ?? generateId,
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
      return portfolioResponseFromDocument(requireDocument(engine), portfolioId);
    },

    async updatePortfolio(portfolioId, patch) {
      const current = requirePortfolio(requireDocument(engine), portfolioId);
      const parsedPatch = definedFields(updatePortfolioRequestSchema.parse(patch));
      if (Object.keys(parsedPatch).length === 0) {
        return portfolioSummaryFromEntity(current);
      }
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
        .filter(
          (entity) =>
            parsedParams.source == null ||
            stringField(entity.data, 'source', 'manual') === parsedParams.source,
        )
        .filter((entity) => parsedParams.cursor == null || entity.id < parsedParams.cursor)
        .sort((left, right) => {
          if (left.id < right.id) return 1;
          if (left.id > right.id) return -1;
          return 0;
        });
      const limit = parsedParams.limit ?? 50;
      const page = all.slice(0, limit);
      return parseVaultData(
        () =>
          transactionListResponseSchema.parse({
            items: page.map((entity) => transactionFromEntity(document, entity)),
            nextCursor: page.length < all.length ? (page.at(-1)?.id ?? null) : null,
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
      }));
      assertLocallySupportedTransactions(current, portfolioId, candidates, context.now());

      await mutateDocument(context, (document) => {
        requirePortfolio(document, portfolioId);
        assertLocallySupportedTransactions(document, portfolioId, candidates, context.now());
        const timestamp = context.now();
        const entities = candidates.map(({ id, input }) => {
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
        const next = appendEntities(document, 'transaction', entities);
        for (const assetId of new Set(parsedInputs.map((input) => input.assetId))) {
          assertValidAssetTimeline(next, portfolioId, assetId);
        }
        return next;
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
      const financialEdit = hasFinancialTransactionPatch(dataPatch);
      const current = requireDocument(engine);
      requirePortfolio(current, portfolioId);
      const currentEntity = requireOwnedEntity(current, 'transaction', transactionId, portfolioId);
      const currentTransaction = transactionFromEntity(current, currentEntity);
      assertTransactionUpdateTaxSupported(
        current,
        portfolioId,
        currentEntity,
        dataPatch,
        financialEdit,
        context.now(),
      );
      assertFinancialEditSupported(current, transactionId, financialEdit);
      if (Object.keys(dataPatch).length === 0) {
        return currentTransaction;
      }

      let expected: VaultEntity | null = null;
      const mutationState = await mutateDocument(context, (document) => {
        requirePortfolio(document, portfolioId);
        const existing = requireOwnedEntity(document, 'transaction', transactionId, portfolioId);
        transactionFromEntity(document, existing);
        assertTransactionUpdateTaxSupported(
          document,
          portfolioId,
          existing,
          dataPatch,
          financialEdit,
          context.now(),
        );
        assertFinancialEditSupported(document, transactionId, financialEdit);
        const updated: VaultEntity = {
          ...existing,
          rev: existing.rev + 1,
          editedAt: context.now(),
          editedBy: engine.deviceId,
          data: definedFields({
            ...existing.data,
            ...dataPatch,
          }),
        };
        expected = updated;
        const next = replaceEntity(document, 'transaction', updated);
        assertValidAssetTimeline(next, portfolioId, stringField(updated.data, 'assetId'));
        return next;
      });

      const committed = requireCommittedMutationEntity(
        mutationState,
        'transaction',
        transactionId,
        expected,
      );
      return transactionFromEntity(committed.document, committed.entity);
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
  await mutateDocument(context, (document) => {
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
  let expected: VaultEntity | null = null;
  const mutationState = await mutateDocument(context, (document) => {
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
      data: definedFields(mutateData(existing.data)),
    };
    expected = updated;
    return replaceEntity(document, kind, updated);
  });
  return requireCommittedMutationEntity(mutationState, kind, id, expected).entity;
}

async function deletePortfolioTree(context: StoreContext, portfolioId: string): Promise<void> {
  requireDocument(context.engine);
  await mutateDocument(context, (document) => {
    assertCascadeReferences(document);
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
    const descendants = liveCascadeDescendants(document, 'portfolio', portfolioId);
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
    for (const descendant of descendants) {
      const entity = findLiveEntity(next, descendant.kind, descendant.id);
      if (entity == null) continue;
      next = replaceEntity(
        next,
        descendant.kind,
        tombstoneEntity(entity, context.engine.deviceId, timestamp),
      );
    }
    assertCascadeReferences(next);
    return next;
  });
  const committedDocument = requireDocument(context.engine);
  try {
    assertCascadeReferences(committedDocument);
  } catch (cause) {
    throw storeError(
      'VAULT_DATA_UNAVAILABLE',
      'The portfolio deletion left an invalid descendant reference.',
      cause,
    );
  }
  const committed = findEntity(committedDocument, 'portfolio', portfolioId);
  if (
    committed?.deletedAt == null ||
    liveCascadeDescendants(committedDocument, 'portfolio', portfolioId).length > 0
  ) {
    throw storeError('VAULT_DATA_UNAVAILABLE', 'The portfolio deletion was not committed locally.');
  }
}

async function deleteTransactionTree(
  context: StoreContext,
  portfolioId: string,
  transactionId: string,
): Promise<void> {
  requireDocument(context.engine);
  await mutateDocument(context, (document) => {
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
    assertValidAssetTimeline(next, portfolioId, stringField(transaction.data, 'assetId'));
    projectCashLedgerBySource(domainCashMovements(next, portfolioId));
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

  await mutateDocument(context, (document) => {
    requirePortfolio(document, portfolioId);
    const timestamp = context.now();
    const resolved = resolveOrCreateCashSource(
      context,
      document,
      portfolioId,
      parsedBody.sourceId,
      timestamp,
    );
    const sourceId = resolved.sourceId;
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
    const next = appendEntities(resolved.document, 'cashMovement', [entity]);
    projectCashLedgerBySource(domainCashMovements(next, portfolioId));
    createdId = id;
    return next;
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
  const sourceBalanceEur = floorCents(balances.get(sourceId) ?? 0);
  const balanceEur = floorCents(cashBalance(movements));
  return parseVaultData(
    () =>
      cashMovementResponseSchema.parse({
        movement: cashMovementFromEntity(committed),
        sourceBalanceEur,
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

async function mutateDocument(
  context: StoreContext,
  mutator: (document: VaultDocumentV1) => VaultDocumentV1,
): Promise<VaultSyncState> {
  return context.engine.mutate(({ document }) => {
    const next = mutator(document);
    const changed: { kind: VaultEntityKind; entity: VaultEntity }[] = [];
    for (const [kind, entities] of Object.entries(next.entities) as [
      VaultEntityKind,
      VaultEntity[],
    ][]) {
      for (const entity of entities) {
        const previous = findEntity(document, kind, entity.id);
        if (previous == null || !sameVaultEntity(previous, entity)) {
          changed.push({ kind, entity });
        }
      }
    }
    if (changed.length === 0) return next;

    const mutationId = safeNewMutationId(context);
    const isAtomic = changed.length > 1;
    let stamped = next;
    for (const { kind, entity } of changed) {
      const atomicMutationIds = isAtomic
        ? [...new Set([...(entity.atomicMutationIds ?? []), mutationId])]
        : entity.atomicMutationIds;
      stamped = replaceEntity(stamped, kind, {
        ...entity,
        mutationId,
        ...(atomicMutationIds === undefined ? {} : { atomicMutationIds }),
      });
    }
    return stamped;
  });
}

function entityRecord(
  id: string,
  deviceId: string,
  timestamp: string,
  data: Record<string, unknown>,
): VaultEntity {
  return {
    id,
    rev: 0,
    editedAt: timestamp,
    editedBy: deviceId,
    deletedAt: null,
    data: definedFields(data),
  };
}

interface VaultCascadeRelation {
  parentKind: VaultEntityKind;
  childKind: VaultEntityKind;
  field: string;
  nullable?: boolean;
}

/**
 * Complete portfolio-owned entity graph in document v1. Keeping direct and
 * transitive relationships in one table makes delete, merge repair, and
 * referential assertions evolve together.
 */
const VAULT_PORTFOLIO_CASCADE_RELATIONS = [
  { parentKind: 'portfolio', childKind: 'transaction', field: 'portfolioId' },
  { parentKind: 'portfolio', childKind: 'dividend', field: 'portfolioId' },
  { parentKind: 'portfolio', childKind: 'cashSource', field: 'portfolioId' },
  { parentKind: 'portfolio', childKind: 'cashMovement', field: 'portfolioId' },
  { parentKind: 'portfolio', childKind: 'portfolioSetting', field: 'portfolioId' },
  { parentKind: 'portfolio', childKind: 'standingOrder', field: 'portfolioId' },
  { parentKind: 'portfolio', childKind: 'importBatch', field: 'portfolioId' },
  { parentKind: 'portfolio', childKind: 'portfolioDailySnapshot', field: 'portfolioId' },
  { parentKind: 'portfolio', childKind: 'portfolioSnapshotState', field: 'portfolioId' },
  {
    parentKind: 'transaction',
    childKind: 'cashMovement',
    field: 'transactionId',
    nullable: true,
  },
  { parentKind: 'standingOrder', childKind: 'standingOrderRun', field: 'standingOrderId' },
  { parentKind: 'importBatch', childKind: 'importRow', field: 'batchId' },
] as const satisfies readonly VaultCascadeRelation[];

interface VaultEntityRef {
  kind: VaultEntityKind;
  id: string;
}

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

function liveCascadeDescendants(
  document: VaultDocumentV1,
  rootKind: VaultEntityKind,
  rootId: string,
): VaultEntityRef[] {
  const queue: VaultEntityRef[] = [{ kind: rootKind, id: rootId }];
  const visited = new Set([entityRefKey(rootKind, rootId)]);
  const live: VaultEntityRef[] = [];

  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index]!;
    for (const relation of VAULT_PORTFOLIO_CASCADE_RELATIONS) {
      if (relation.parentKind !== parent.kind) continue;
      for (const child of document.entities[relation.childKind] ?? []) {
        if (cascadeReference(child, relation) !== parent.id) continue;
        const key = entityRefKey(relation.childKind, child.id);
        if (visited.has(key)) continue;
        visited.add(key);
        const ref = { kind: relation.childKind, id: child.id };
        queue.push(ref);
        if (child.deletedAt === null) live.push(ref);
      }
    }
  }
  return live;
}

function cascadeReference(entity: VaultEntity, relation: VaultCascadeRelation): string | null {
  return relation.nullable
    ? nullableStringField(entity.data, relation.field)
    : stringField(entity.data, relation.field);
}

function entityRefKey(kind: VaultEntityKind, id: string): string {
  return `${kind}\u0000${id}`;
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

function requireCommittedMutationEntity(
  state: VaultSyncState,
  kind: VaultEntityKind,
  id: string,
  expected: VaultEntity | null,
): { document: VaultDocumentV1; entity: VaultEntity } {
  const document = state.active?.document;
  if (document == null || expected == null) {
    throw storeError(
      'VAULT_DATA_UNAVAILABLE',
      'The requested vault update did not survive commit and reconciliation.',
    );
  }
  const committed = findEntity(document, kind, id);
  if (committed == null || !sameMutationResultEntity(committed, expected)) {
    throw storeError(
      'VAULT_DATA_UNAVAILABLE',
      'The requested vault update did not survive commit and reconciliation.',
    );
  }
  return { document, entity: committed };
}

function sameMutationResultEntity(left: VaultEntity, right: VaultEntity): boolean {
  return (
    left.id === right.id &&
    left.rev === right.rev &&
    left.editedAt === right.editedAt &&
    left.editedBy === right.editedBy &&
    left.deletedAt === right.deletedAt &&
    sameJsonValue(left.data, right.data)
  );
}

function sameVaultEntity(left: VaultEntity, right: VaultEntity): boolean {
  return (
    sameMutationResultEntity(left, right) &&
    left.mutationId === right.mutationId &&
    sameStringArray(left.atomicMutationIds, right.atomicMutationIds)
  );
}

function sameStringArray(left: string[] | undefined, right: string[] | undefined): boolean {
  return (
    left === right ||
    (left != null &&
      right != null &&
      left.length === right.length &&
      left.every((value, index) => value === right[index]))
  );
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]))
    );
  }
  if (left == null || right == null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && sameJsonValue(leftRecord[key], rightRecord[key]),
    )
  );
}

interface ReconcileChange {
  kind: VaultEntityKind;
  local: VaultEntity;
  remote: VaultEntity | undefined;
  localWon: boolean;
}

interface ReconcileGroup {
  orderAt: string;
  orderKey: string;
  changes: ReconcileChange[];
}

class VaultAggregateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultAggregateConflictError';
  }
}

/**
 * Reconcile portfolio-domain mutations before the sync engine encrypts or
 * publishes a divergent merge. The observed durable document is the baseline;
 * each complete local atomic edit group is admitted only when all of its
 * members won the entity merge and the complete candidate still satisfies
 * holdings, cash, active-portfolio and cascade invariants. Rejected entities
 * receive a dominating compensation so a partial group cannot be unioned back
 * in on the next reconnect.
 */
export function reconcilePortfolioDocument(
  document: VaultDocumentV1,
  context: VaultDocumentReconcileContext,
): VaultDocumentV1 {
  const changes = localMutationChanges(document, context);
  let reconciled = document;
  for (const change of changes) {
    reconciled = setEntity(reconciled, change.kind, change.local.id, change.remote);
  }

  reconciled = normalizeReconciledStructure(reconciled, context);
  assertPortfolioDocumentInvariants(reconciled);

  for (const group of reconcileGroups(changes)) {
    if (group.changes.some((change) => !change.localWon)) {
      reconciled = compensateRejectedGroup(reconciled, group, context);
      continue;
    }

    let candidate = reconciled;
    for (const change of group.changes) {
      candidate = setEntity(candidate, change.kind, change.local.id, change.local);
    }
    candidate = normalizeReconciledStructure(candidate, context);

    try {
      assertPortfolioDocumentInvariants(candidate);
      reconciled = candidate;
    } catch (cause) {
      if (!isAggregateConflict(cause)) throw cause;
      reconciled = compensateRejectedGroup(reconciled, group, context);
    }
  }

  return reconciled;
}

function localMutationChanges(
  document: VaultDocumentV1,
  context: VaultDocumentReconcileContext,
): ReconcileChange[] {
  const changes: ReconcileChange[] = [];
  for (const [kind, entities] of Object.entries(context.local.entities) as [
    VaultEntityKind,
    VaultEntity[],
  ][]) {
    for (const local of entities) {
      const merged = findEntity(document, kind, local.id);
      const remote = findEntity(context.remote, kind, local.id);
      if (remote == null || !sameVaultEntity(remote, local)) {
        changes.push({
          kind,
          local,
          remote,
          localWon: merged != null && sameVaultEntity(merged, local),
        });
      }
    }
  }
  return changes;
}

function reconcileGroups(changes: ReconcileChange[]): ReconcileGroup[] {
  const components: { tokens: Set<string>; changes: ReconcileChange[] }[] = [];
  for (const change of changes) {
    const tokens = new Set(reconcileOperationTokens(change));
    const matching = components.filter((component) =>
      [...tokens].some((token) => component.tokens.has(token)),
    );
    if (matching.length === 0) {
      components.push({ tokens, changes: [change] });
      continue;
    }

    const target = matching[0]!;
    target.changes.push(change);
    for (const token of tokens) target.tokens.add(token);
    for (const component of matching.slice(1)) {
      target.changes.push(...component.changes);
      for (const token of component.tokens) target.tokens.add(token);
      components.splice(components.indexOf(component), 1);
    }
  }

  return components
    .map((component): ReconcileGroup => {
      const orderedTokens = [...component.tokens].sort();
      return {
        orderAt: component.changes
          .map((change) => change.local.editedAt)
          .sort((left, right) => Date.parse(left) - Date.parse(right))[0]!,
        orderKey: orderedTokens.join('\u0000'),
        changes: component.changes,
      };
    })
    .sort(
      (left, right) =>
        Date.parse(left.orderAt) - Date.parse(right.orderAt) ||
        left.orderKey.localeCompare(right.orderKey),
    )
    .map((group) => ({
      ...group,
      changes: group.changes.sort(
        (left, right) =>
          left.kind.localeCompare(right.kind) || left.local.id.localeCompare(right.local.id),
      ),
    }));
}

function reconcileOperationTokens(change: ReconcileChange): string[] {
  const tokens: string[] = [];
  if (change.local.mutationId != null && change.local.mutationId !== change.remote?.mutationId) {
    tokens.push(`mutation:${change.local.mutationId}`);
  }

  const remoteAtomicIds = new Set(change.remote?.atomicMutationIds ?? []);
  for (const mutationId of change.local.atomicMutationIds ?? []) {
    if (!remoteAtomicIds.has(mutationId)) tokens.push(`atomic:${mutationId}`);
  }

  return tokens.length > 0
    ? tokens
    : [`legacy:${change.local.editedAt}\u0000${change.local.editedBy}`];
}

function compensateRejectedGroup(
  document: VaultDocumentV1,
  group: ReconcileGroup,
  context: VaultDocumentReconcileContext,
): VaultDocumentV1 {
  let compensated = document;
  for (const change of group.changes) {
    const desired = findEntity(compensated, change.kind, change.local.id);
    compensated = setEntity(
      compensated,
      change.kind,
      change.local.id,
      compensationEntity(change.local, desired, context),
    );
  }
  compensated = normalizeReconciledStructure(compensated, context);
  assertPortfolioDocumentInvariants(compensated);
  return compensated;
}

function setEntity(
  document: VaultDocumentV1,
  kind: VaultEntityKind,
  id: string,
  entity: VaultEntity | undefined,
): VaultDocumentV1 {
  const existing = document.entities[kind] ?? [];
  const next =
    entity == null
      ? existing.filter((candidate) => candidate.id !== id)
      : existing.some((candidate) => candidate.id === id)
        ? existing.map((candidate) => (candidate.id === id ? entity : candidate))
        : [...existing, entity].sort((left, right) => left.id.localeCompare(right.id));
  return {
    ...document,
    entities: {
      ...document.entities,
      [kind]: next,
    },
  };
}

function normalizeReconciledStructure(
  document: VaultDocumentV1,
  context: VaultDocumentReconcileContext,
): VaultDocumentV1 {
  const cascaded = enforceDeletionCascades(document, context);
  const withDefault = normalizeDefaultPortfolio(cascaded, context);
  return normalizeMainCashSources(withDefault, context);
}

function enforceDeletionCascades(
  document: VaultDocumentV1,
  context: VaultDocumentReconcileContext,
): VaultDocumentV1 {
  let next = document;
  let changed: boolean;
  do {
    changed = false;
    for (const relation of VAULT_PORTFOLIO_CASCADE_RELATIONS) {
      const deletedParentIds = new Set(
        (next.entities[relation.parentKind] ?? [])
          .filter((entity) => entity.deletedAt !== null)
          .map((entity) => entity.id),
      );
      if (deletedParentIds.size === 0) continue;

      for (const child of liveEntities(next, relation.childKind)) {
        const parentId = cascadeReference(child, relation);
        if (parentId == null || !deletedParentIds.has(parentId)) continue;
        next = replaceEntity(
          next,
          relation.childKind,
          tombstoneEntity(child, context.deviceId, context.reconciledAt),
        );
        changed = true;
      }
    }
  } while (changed);
  return next;
}

function normalizeDefaultPortfolio(
  document: VaultDocumentV1,
  context: VaultDocumentReconcileContext,
): VaultDocumentV1 {
  const portfolios = liveEntities(document, 'portfolio');
  const defaultId =
    portfolios
      .filter((entity) => nullableStringField(entity.data, 'archivedAt') === null)
      .sort(
        (left, right) =>
          numberField(left.data, 'sortOrder', 0) - numberField(right.data, 'sortOrder', 0) ||
          left.id.localeCompare(right.id),
      )[0]?.id ?? null;
  let next = document;

  for (const portfolio of portfolios) {
    const shouldBeDefault = portfolio.id === defaultId;
    if (booleanField(portfolio.data, 'isDefault', false) === shouldBeDefault) continue;
    next = replaceEntity(
      next,
      'portfolio',
      rewriteEntityData(portfolio, { ...portfolio.data, isDefault: shouldBeDefault }, context),
    );
  }
  return next;
}

function normalizeMainCashSources(
  document: VaultDocumentV1,
  context: VaultDocumentReconcileContext,
): VaultDocumentV1 {
  const mainsByPortfolio = new Map<string, VaultEntity[]>();
  for (const source of liveEntities(document, 'cashSource')) {
    if (!booleanField(source.data, 'isMain', false)) continue;
    const portfolioId = stringField(source.data, 'portfolioId');
    const mains = mainsByPortfolio.get(portfolioId);
    if (mains == null) {
      mainsByPortfolio.set(portfolioId, [source]);
    } else {
      mains.push(source);
    }
  }

  const replacementSourceIds = new Map<string, string>();
  let next = document;
  for (const [, mains] of [...mainsByPortfolio].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (mains.length <= 1) continue;
    const [canonical, ...duplicates] = mains.sort(
      (left, right) =>
        Number(nullableStringField(left.data, 'archivedAt') !== null) -
          Number(nullableStringField(right.data, 'archivedAt') !== null) ||
        left.id.localeCompare(right.id),
    );
    if (canonical == null) continue;
    for (const duplicate of duplicates) {
      replacementSourceIds.set(duplicate.id, canonical.id);
      next = replaceEntity(
        next,
        'cashSource',
        tombstoneEntity(duplicate, context.deviceId, context.reconciledAt),
      );
    }
  }

  if (replacementSourceIds.size === 0) return next;
  for (const [kind, fields] of CASH_SOURCE_REFERENCE_FIELDS) {
    for (const entity of liveEntities(next, kind)) {
      let changed = false;
      const data = { ...entity.data };
      for (const field of fields) {
        const current = nullableStringField(data, field);
        const replacement = current == null ? null : replacementSourceIds.get(current);
        if (replacement != null && replacement !== current) {
          data[field] = replacement;
          changed = true;
        }
      }
      if (changed) {
        next = replaceEntity(next, kind, rewriteEntityData(entity, data, context));
      }
    }
  }
  return next;
}

const CASH_SOURCE_REFERENCE_FIELDS = [
  ['transaction', ['cashSourceId']],
  ['dividend', ['cashSourceId']],
  ['cashMovement', ['sourceId', 'counterpartSourceId']],
] as const satisfies readonly [VaultEntityKind, readonly string[]][];

function rewriteEntityData(
  entity: VaultEntity,
  data: Record<string, unknown>,
  context: VaultDocumentReconcileContext,
): VaultEntity {
  return {
    ...entity,
    rev: entity.rev + 1,
    editedAt: context.reconciledAt,
    editedBy: context.deviceId,
    data,
  };
}

function compensationEntity(
  rejected: VaultEntity,
  desired: VaultEntity | undefined,
  context: VaultDocumentReconcileContext,
): VaultEntity {
  if (desired == null) {
    return tombstoneEntity(rejected, context.deviceId, context.reconciledAt);
  }
  const deletedAt = desired.deletedAt === null ? null : context.reconciledAt;
  return {
    ...desired,
    rev: Math.max(rejected.rev, desired.rev) + 1,
    editedAt: context.reconciledAt,
    editedBy: context.deviceId,
    deletedAt,
  };
}

function assertPortfolioDocumentInvariants(document: VaultDocumentV1): void {
  assertCascadeReferences(document);

  const activePortfolioRows = (document.entities.portfolio ?? []).filter(
    (entity) => nullableStringField(entity.data, 'archivedAt') === null,
  );
  if (
    activePortfolioRows.length > 0 &&
    activePortfolioRows.every((entity) => entity.deletedAt !== null)
  ) {
    throw new VaultAggregateConflictError(
      'A reconciled vault must retain at least one active portfolio.',
    );
  }
  const livePortfolios = liveEntities(document, 'portfolio');
  const expectedDefaultId =
    livePortfolios
      .filter((entity) => nullableStringField(entity.data, 'archivedAt') === null)
      .sort(
        (left, right) =>
          numberField(left.data, 'sortOrder', 0) - numberField(right.data, 'sortOrder', 0) ||
          left.id.localeCompare(right.id),
      )[0]?.id ?? null;
  if (
    livePortfolios.some(
      (entity) =>
        booleanField(entity.data, 'isDefault', false) !== (entity.id === expectedDefaultId),
    )
  ) {
    throw new VaultAggregateConflictError(
      'A reconciled vault must have exactly one deterministic active default portfolio.',
    );
  }

  const mainCounts = new Map<string, number>();
  for (const source of liveEntities(document, 'cashSource')) {
    if (!booleanField(source.data, 'isMain', false)) continue;
    const portfolioId = stringField(source.data, 'portfolioId');
    mainCounts.set(portfolioId, (mainCounts.get(portfolioId) ?? 0) + 1);
  }
  if ([...mainCounts.values()].some((count) => count > 1)) {
    throw new VaultAggregateConflictError(
      'A reconciled vault must have at most one live Main cash source per portfolio.',
    );
  }

  const assetTimelines = new Set<string>();
  for (const entity of liveEntities(document, 'transaction')) {
    const portfolioId = stringField(entity.data, 'portfolioId');
    const assetId = stringField(entity.data, 'assetId');
    assetTimelines.add(`${portfolioId}\u0000${assetId}`);
  }
  for (const timeline of assetTimelines) {
    const [portfolioId, assetId] = timeline.split('\u0000');
    if (portfolioId == null || assetId == null) {
      throw storeError('VAULT_DATA_INVALID', 'A vault transaction timeline is malformed.');
    }
    assertValidAssetTimeline(document, portfolioId, assetId);
  }

  const cashPortfolioIds = new Set(
    liveEntities(document, 'cashMovement').map((entity) => stringField(entity.data, 'portfolioId')),
  );
  for (const portfolioId of cashPortfolioIds) {
    projectCashLedgerBySource(domainCashMovements(document, portfolioId));
  }
}

function assertCascadeReferences(document: VaultDocumentV1): void {
  for (const relation of VAULT_PORTFOLIO_CASCADE_RELATIONS) {
    for (const child of liveEntities(document, relation.childKind)) {
      const parentId = cascadeReference(child, relation);
      if (parentId == null) continue;
      if (findLiveEntity(document, relation.parentKind, parentId) != null) continue;
      throw new VaultAggregateConflictError(
        `A live ${relation.childKind} must reference a live ${relation.parentKind}.`,
      );
    }
  }
}

function isAggregateConflict(cause: unknown): boolean {
  return (
    cause instanceof OversellError ||
    cause instanceof InsufficientCashError ||
    cause instanceof VaultAggregateConflictError
  );
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

function resolveOrCreateCashSource(
  context: StoreContext,
  document: VaultDocumentV1,
  portfolioId: string,
  requestedSourceId: string | undefined,
  timestamp: string,
): { document: VaultDocumentV1; sourceId: string } {
  if (requestedSourceId !== undefined) {
    return {
      document,
      sourceId: resolveCashSourceId(document, portfolioId, requestedSourceId),
    };
  }

  const main = liveEntities(document, 'cashSource').find(
    (entity) =>
      stringField(entity.data, 'portfolioId') === portfolioId &&
      nullableStringField(entity.data, 'archivedAt') === null &&
      booleanField(entity.data, 'isMain', false),
  );
  if (main != null) {
    return { document, sourceId: main.id };
  }

  const sourceId = safeNewId(context);
  const source = entityRecord(sourceId, context.engine.deviceId, timestamp, {
    portfolioId,
    name: 'Main',
    type: 'cash',
    isMain: true,
    archivedAt: null,
    createdAt: timestamp,
  });
  return {
    document: appendEntities(document, 'cashSource', [source]),
    sourceId,
  };
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

/**
 * Build the binding overview entirely from the authenticated document. The
 * PortfolioStore seam deliberately has no market-provider dependency yet, so
 * quote-dependent fields degrade to `null`, exactly as the API overview does
 * when a quote is unavailable. PD7 can supply client-side quotes without
 * changing this transport boundary; positions and cash are already truthful.
 */
function portfolioResponseFromDocument(
  document: VaultDocumentV1,
  portfolioId: string,
): PortfolioResponse {
  requirePortfolio(document, portfolioId);
  return parseVaultData(() => {
    const transactions = liveEntities(document, 'transaction')
      .filter((entity) => stringField(entity.data, 'portfolioId') === portfolioId)
      .map((entity) => ({ entity, transaction: transactionFromEntity(document, entity) }))
      .sort(
        (left, right) =>
          Date.parse(left.transaction.executedAt) - Date.parse(right.transaction.executedAt) ||
          left.entity.id.localeCompare(right.entity.id),
      );
    const byAsset = new Map<string, { asset: PortfolioAsset; transactions: Transaction[] }>();
    for (const { transaction } of transactions) {
      const group = byAsset.get(transaction.assetId);
      if (group == null) {
        byAsset.set(transaction.assetId, {
          asset: transaction.asset,
          transactions: [transaction],
        });
      } else {
        group.transactions.push(transaction);
      }
    }
    const holdings = [...byAsset.values()].map(({ asset, transactions: assetTransactions }) => {
      const position = reducePosition(assetTransactions);
      return {
        asset,
        quantity: position.quantity,
        avgCost: position.avgCost,
        realizedPnl: position.realizedPnl,
        price: null,
        marketValueEur: null,
        costBasisEur: null,
        unrealizedPnlEur: null,
        unrealizedPnlPct: null,
        dayChangeEur: null,
        dayChangePct: null,
      };
    });
    const cashEur = floorCents(cashBalance(domainCashMovements(document, portfolioId)));

    return portfolioResponseSchema.parse({
      baseCurrency: 'EUR',
      holdings,
      totals: {
        marketValueEur: 0,
        investedEur: 0,
        unrealizedPnlEur: 0,
        unrealizedPnlPct: null,
        dayChangeEur: 0,
        dayChangePct: null,
        cashEur,
        totalValueEur: cashEur,
      },
    });
  }, 'Vault holdings do not match the portfolio contract.');
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
    .sort(compareExecutionOrder)
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

function assertValidAssetTimeline(
  document: VaultDocumentV1,
  portfolioId: string,
  assetId: string,
): void {
  const transactions = liveEntities(document, 'transaction')
    .filter(
      (entity) =>
        stringField(entity.data, 'portfolioId') === portfolioId &&
        stringField(entity.data, 'assetId') === assetId,
    )
    .sort(compareExecutionOrder)
    .map((entity) => transactionFromEntity(document, entity));
  reducePosition(transactions);
}

/**
 * Canonical money replay order shared with the persisted API repositories:
 * normalized execution instant first, then UUIDv7 id for equal instants.
 */
function compareExecutionOrder(left: VaultEntity, right: VaultEntity): number {
  const leftAt = executionTime(left);
  const rightAt = executionTime(right);
  return leftAt - rightAt || left.id.localeCompare(right.id);
}

function executionTime(entity: VaultEntity): number {
  const executedAt = stringField(entity.data, 'executedAt', entity.editedAt);
  const parsed = Date.parse(executedAt);
  if (!Number.isFinite(parsed)) {
    throw storeError('VAULT_DATA_INVALID', 'A vault money row has an invalid execution date.');
  }
  return parsed;
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

function assertFinancialEditSupported(
  document: VaultDocumentV1,
  transactionId: string,
  financialEdit: boolean,
): void {
  if (
    financialEdit &&
    liveEntities(document, 'cashMovement').some(
      (entity) => nullableStringField(entity.data, 'transactionId') === transactionId,
    )
  ) {
    throw storeError(
      'VAULT_OPERATION_UNAVAILABLE',
      'A cash-linked transaction must be deleted and re-added to change its financial fields.',
    );
  }
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
  const effectiveTaxMode = effectivePortfolioTaxMode(document, portfolioId);
  const openFromYear = taxEngineOpenFromYear(effectiveTaxMode, now);
  const recordsEngineTax = candidates.some(
    ({ input }) => input.side === 'sell' && effectiveTaxMode !== 'none',
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
  if (requiresDerivedEngine || recordsEngineTax || reshapesFrozenTax) {
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
  if (!financialEdit) return;
  const assetId = stringField(transaction.data, 'assetId');
  const openFromYear = taxEngineOpenFromYear(effectivePortfolioTaxMode(document, portfolioId), now);
  const prospectiveTransaction: VaultEntity = {
    ...transaction,
    data: definedFields({
      ...transaction.data,
      ...patch,
    }),
  };
  if (
    isFrozenTaxSensitiveSell(transaction) ||
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
  const openFromYear = taxEngineOpenFromYear(effectivePortfolioTaxMode(document, portfolioId), now);
  if (
    isFrozenTaxSensitiveSell(transaction) ||
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

function effectivePortfolioTaxMode(
  document: VaultDocumentV1,
  portfolioId: string,
): 'none' | 'manual_per_trade' | 'country_specific' | 'custom' {
  const override = liveEntities(document, 'portfolioSetting').find(
    (entity) =>
      stringField(entity.data, 'portfolioId') === portfolioId &&
      stringField(entity.data, 'key') === 'tax',
  );
  const overrideMode = taxModeField(override == null ? null : recordField(override.data, 'value'));
  if (overrideMode != null) return overrideMode;

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
  return taxModeField(userDefault?.data ?? null) ?? 'none';
}

function taxModeField(
  data: Record<string, unknown> | null,
): 'none' | 'manual_per_trade' | 'country_specific' | 'custom' | null {
  const mode = data?.mode;
  return mode === 'none' ||
    mode === 'manual_per_trade' ||
    mode === 'country_specific' ||
    mode === 'custom'
    ? mode
    : null;
}

function taxEngineOpenFromYear(
  mode: ReturnType<typeof effectivePortfolioTaxMode>,
  now: string,
): number | null {
  return mode === 'country_specific' || mode === 'custom' ? viennaYearOf(now) : null;
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
  return mode === 'manual_per_trade' || mode === 'country_specific' || mode === 'custom';
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

function safeNewMutationId(context: StoreContext): string {
  try {
    return context.newMutationId();
  } catch (cause) {
    throw new VaultCryptoError('unsupported-crypto', 'Mutation UUID generation is unavailable.', {
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
