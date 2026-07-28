import {
  cashEntryRequestSchema,
  cashMovementResponseSchema,
  cashMovementSchema,
  createPortfolioRequestSchema,
  createTransactionsRequestSchema,
  portfolioAssetSchema,
  portfolioListResponseSchema,
  portfolioSummarySchema,
  SOURCE_TAG_STANDING_ORDER,
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
  InsufficientCashError,
  projectCashLedgerBySource,
  type SourcedCashMovement,
} from '@bettertrack/domain/cashLedger';
import { OversellError, reducePosition } from '@bettertrack/domain/holdings';
import { viennaYearOf } from '@bettertrack/domain/tax';
import { uuidv7 } from 'uuidv7';

import { VaultCryptoError } from './errors';
import { standingOrderOccurrenceId } from './standingOrders/occurrenceId';
import { calendarDayInTimezone, dueStandingOrderOccurrence } from './standingOrders/schedule';
import type {
  VaultAtomicMutation,
  VaultDocumentReconcileContext,
  VaultDocumentReconcileResult,
  VaultMutationEntityDelta,
  VaultSyncEngine,
  VaultSyncState,
} from './sync';

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

export interface VaultStandingOrderOccurrenceInput {
  /** Deterministic UUID derived from `(orderId, dueDate)`. */
  occurrenceId: string;
  orderId: string;
  /** ISO `YYYY-MM-DD` schedule occurrence. */
  dueDate: string;
  /** The schedule's timezone-resolved calendar day at execution. */
  calendarDay: string;
  timezone: string;
  /** The authenticated client's wall-clock booking time. */
  executedAt: string;
  /** Required exactly for `buy-asset`, in the standing order's native currency. */
  price?: number;
  quoteCurrency?: string;
}

export interface VaultStandingOrderOccurrenceResult {
  occurrenceId: string;
  orderId: string;
  dueDate: string;
  rowKind: 'transaction' | 'cashMovement';
  status: 'created' | 'existing';
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
  materializeStandingOrderOccurrence(
    input: VaultStandingOrderOccurrenceInput,
    signal?: AbortSignal,
  ): Promise<VaultStandingOrderOccurrenceResult>;
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
      const initialCandidate = appendTransactionCandidates(
        current,
        candidates,
        engine.deviceId,
        context.now(),
      );
      assertProspectiveAssetTimelines(
        initialCandidate.document,
        portfolioId,
        candidates.map(({ input }) => input.assetId),
      );
      let expectedEntities: VaultEntity[] = [];

      const mutationState = await engine.mutate(({ document }) => {
        requirePortfolio(document, portfolioId);
        assertLocallySupportedTransactions(document, portfolioId, candidates, context.now());
        const candidate = appendTransactionCandidates(
          document,
          candidates,
          engine.deviceId,
          context.now(),
        );
        assertProspectiveAssetTimelines(
          candidate.document,
          portfolioId,
          candidates.map(({ input }) => input.assetId),
        );
        expectedEntities = candidate.entities;
        return candidate.document;
      });

      return expectedEntities.map((expected) => {
        const committed = requireCommittedMutationEntity(
          mutationState,
          'transaction',
          expected.id,
          expected,
        );
        if (committed.entity.deletedAt !== null) {
          throw storeError(
            'VAULT_DATA_UNAVAILABLE',
            'The committed vault transaction is not readable.',
          );
        }
        return transactionFromEntity(committed.document, committed.entity);
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
      if (financialEdit) {
        const prospective: VaultEntity = {
          ...currentEntity,
          rev: currentEntity.rev + 1,
          editedAt: context.now(),
          editedBy: engine.deviceId,
          data: { ...currentEntity.data, ...persistedDataPatch },
        };
        assertProspectiveAssetTimelines(
          replaceEntity(current, 'transaction', prospective),
          portfolioId,
          [stringField(currentEntity.data, 'assetId')],
        );
      }
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
        financialEdit
          ? (document) =>
              assertProspectiveAssetTimelines(document, portfolioId, [
                stringField(currentEntity.data, 'assetId'),
              ])
          : undefined,
      );
      return transactionFromEntity(requireDocument(engine), entity);
    },

    async deleteTransaction(portfolioId, transactionId) {
      const document = requireDocument(engine);
      requirePortfolio(document, portfolioId);
      const transaction = requireOwnedEntity(document, 'transaction', transactionId, portfolioId);
      assertTransactionDeleteTaxSupported(document, portfolioId, transaction, context.now());
      const prospective = tombstoneTransactionTree(
        document,
        transaction,
        engine.deviceId,
        context.now(),
      );
      assertProspectiveAssetTimelines(prospective, portfolioId, [
        stringField(transaction.data, 'assetId'),
      ]);
      await deleteTransactionTree(context, portfolioId, transactionId);
    },

    async depositCash(portfolioId, body) {
      return createCashMovement(context, portfolioId, body, 'deposit');
    },

    async withdrawCash(portfolioId, body) {
      return createCashMovement(context, portfolioId, body, 'withdrawal');
    },

    async materializeStandingOrderOccurrence(input, signal) {
      return materializeStandingOrderOccurrence(context, input, signal);
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
  if (state.status === 'conflict' || state.status === 'unresolved') {
    throw storeError(
      'VAULT_DATA_UNAVAILABLE',
      `Vault sync is ${state.status}; portfolio reads and writes are unavailable.`,
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
  let expected: VaultEntity | null = null;
  const mutationState = await context.engine.mutate(({ document }) => {
    id = safeNewId(context);
    const entity = build(document, id, context.now());
    expected = entity;
    return appendEntities(document, kind, [entity]);
  });
  if (id == null || expected == null) {
    throw storeError('VAULT_DATA_UNAVAILABLE', 'The vault mutation was not committed locally.');
  }
  const committed = requireCommittedMutationEntity(mutationState, kind, id, expected).entity;
  if (committed.deletedAt !== null) {
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
  validateDocument?: (document: VaultDocumentV1) => void,
): Promise<VaultEntity> {
  requireDocument(context.engine);
  let expected: VaultEntity | null = null;
  const mutationState = await context.engine.mutate(({ document }) => {
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
    const next = replaceEntity(document, kind, updated);
    validateDocument?.(next);
    expected = updated;
    return next;
  });
  const committed = requireCommittedMutationEntity(mutationState, kind, id, expected).entity;
  if (committed.deletedAt !== null) {
    throw storeError('VAULT_DATA_UNAVAILABLE', 'The updated vault entity is not readable.');
  }
  return committed;
}

async function deletePortfolioTree(context: StoreContext, portfolioId: string): Promise<void> {
  requireDocument(context.engine);
  const mutationState = await context.engine.mutate(({ document }) => {
    assertCascadeReferences(document);
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
    const descendants = liveCascadeDescendants(document, 'portfolio', portfolioId);
    let next = replaceEntity(
      document,
      'portfolio',
      tombstoneEntity(portfolio, context.engine.deviceId, timestamp),
    );
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
  const committedDocument = mutationState.active?.document;
  const committed =
    committedDocument == null ? undefined : findEntity(committedDocument, 'portfolio', portfolioId);
  if (
    committedDocument == null ||
    committed?.deletedAt == null ||
    liveCascadeDescendants(committedDocument, 'portfolio', portfolioId).length > 0
  ) {
    throw storeError('VAULT_DATA_UNAVAILABLE', 'The portfolio deletion was not committed locally.');
  }
  try {
    assertCascadeReferences(committedDocument);
  } catch (cause) {
    throw storeError(
      'VAULT_DATA_UNAVAILABLE',
      'The portfolio deletion left an invalid descendant reference.',
      cause,
    );
  }
}

async function deleteTransactionTree(
  context: StoreContext,
  portfolioId: string,
  transactionId: string,
): Promise<void> {
  requireDocument(context.engine);
  const mutationState = await context.engine.mutate(({ document }) => {
    requirePortfolio(document, portfolioId);
    const transaction = requireOwnedEntity(document, 'transaction', transactionId, portfolioId);
    assertTransactionDeleteTaxSupported(document, portfolioId, transaction, context.now());
    const next = tombstoneTransactionTree(
      document,
      transaction,
      context.engine.deviceId,
      context.now(),
    );
    assertProspectiveAssetTimelines(next, portfolioId, [stringField(transaction.data, 'assetId')]);
    return next;
  });
  const committedDocument = mutationState.active?.document;
  const committed =
    committedDocument == null
      ? undefined
      : findEntity(committedDocument, 'transaction', transactionId);
  if (
    committedDocument == null ||
    committed?.deletedAt == null ||
    liveEntities(committedDocument, 'cashMovement').some(
      (entity) => nullableStringField(entity.data, 'transactionId') === transactionId,
    )
  ) {
    throw storeError(
      'VAULT_DATA_UNAVAILABLE',
      'The transaction deletion was not committed locally.',
    );
  }
}

function tombstoneTransactionTree(
  document: VaultDocumentV1,
  transaction: VaultEntity,
  deviceId: string,
  timestamp: string,
): VaultDocumentV1 {
  let next = replaceEntity(
    document,
    'transaction',
    tombstoneEntity(transaction, deviceId, timestamp),
  );
  for (const movement of liveEntities(next, 'cashMovement').filter(
    (entity) => nullableStringField(entity.data, 'transactionId') === transaction.id,
  )) {
    next = replaceEntity(next, 'cashMovement', tombstoneEntity(movement, deviceId, timestamp));
  }
  return next;
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
  let expected: VaultEntity | null = null;

  const mutationState = await context.engine.mutate(({ document }) => {
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
    expected = entity;
    return appendEntities(document, 'cashMovement', [entity]);
  });

  if (createdId == null || expected == null) {
    throw storeError('VAULT_DATA_UNAVAILABLE', 'The cash movement was not committed locally.');
  }
  const committedMutation = requireCommittedMutationEntity(
    mutationState,
    'cashMovement',
    createdId,
    expected,
  );
  const committedDocument = committedMutation.document;
  const committed = committedMutation.entity;
  if (committed.deletedAt !== null) {
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

async function materializeStandingOrderOccurrence(
  context: StoreContext,
  input: VaultStandingOrderOccurrenceInput,
  signal?: AbortSignal,
): Promise<VaultStandingOrderOccurrenceResult> {
  signal?.throwIfAborted();
  assertStandingOrderOccurrenceInput(input);
  if (input.occurrenceId !== (await standingOrderOccurrenceId(input.orderId, input.dueDate))) {
    throw storeError(
      'VAULT_DATA_INVALID',
      'The standing-order occurrence id is not derived from its order and due date.',
    );
  }
  const current = requireDocument(context.engine);
  assertStandingOrderDefinition(current, requireLiveStandingOrder(current, input.orderId), input);
  const alreadyCommitted = existingStandingOrderOccurrence(current, input);
  if (alreadyCommitted != null) return alreadyCommitted;

  let created = false;
  const mutationState = await context.engine.mutate(({ document }) => {
    signal?.throwIfAborted();
    const concurrent = existingStandingOrderOccurrence(document, input);
    if (concurrent != null) return document;

    const order = requireLiveStandingOrder(document, input.orderId);
    assertStandingOrderDefinition(document, order, input);
    assertStandingOrderDue(order, input);
    const timestamp = input.executedAt;
    const rowKind = standingOrderRowKind(order);
    let ledgerEntity: VaultEntity;
    let nextDocument: VaultDocumentV1;

    if (rowKind === 'transaction') {
      const assetId = stringField(order.data, 'assetId');
      const asset = resolveTransactionAsset(document, assetId);
      const orderCurrency = stringField(order.data, 'currency');
      if (input.quoteCurrency !== orderCurrency || asset.currency !== orderCurrency) {
        throw storeError(
          'VAULT_DATA_INVALID',
          'The standing-order quote currency does not match the local asset snapshot.',
        );
      }
      const price = input.price;
      if (price == null || !Number.isFinite(price) || price <= 0) {
        throw storeError(
          'VAULT_DATA_INVALID',
          'A positive current quote is required for a buy standing order.',
        );
      }
      ledgerEntity = entityRecord(
        input.occurrenceId,
        context.engine.deviceId,
        timestamp,
        parseVaultData(
          () =>
            VAULT_ENTITY_ROW_SCHEMAS.transaction.parse({
              portfolioId: stringField(order.data, 'portfolioId'),
              assetId,
              side: 'buy',
              quantity: stringField(order.data, 'amount'),
              price: decimalStringFromNumber(price),
              fee: '0',
              executedAt: timestamp,
              note: nullableStringField(order.data, 'label'),
              taxMode: null,
              taxCountry: null,
              taxAmountEur: null,
              taxParams: null,
              allowUncovered: false,
              uncoveredEntryPrice: null,
              source: SOURCE_TAG_STANDING_ORDER,
            }),
          'A standing-order transaction does not match the strict restore contract.',
        ),
      );
      nextDocument = appendEntities(document, 'transaction', [ledgerEntity]);
      assertProspectiveAssetTimelines(nextDocument, stringField(order.data, 'portfolioId'), [
        assetId,
      ]);
    } else {
      const portfolioId = stringField(order.data, 'portfolioId');
      const sourceId = resolveCashSourceId(document, portfolioId, undefined);
      const magnitude = floorCents(numberField(order.data, 'amount'));
      const kind = stringField(order.data, 'kind');
      ledgerEntity = entityRecord(
        input.occurrenceId,
        context.engine.deviceId,
        timestamp,
        strictCashMovementData({
          portfolioId,
          sourceId,
          kind: kind === 'cash-add' ? 'deposit' : 'withdrawal',
          amountEur: decimalStringFromNumber(kind === 'cash-add' ? magnitude : -magnitude),
          transactionId: null,
          transferId: null,
          counterpartSourceId: null,
          dividendId: null,
          taxYear: null,
          executedAt: timestamp,
          note: nullableStringField(order.data, 'label'),
          source: SOURCE_TAG_STANDING_ORDER,
          createdAt: timestamp,
        }),
      );
      nextDocument = appendEntities(document, 'cashMovement', [ledgerEntity]);
      projectCashLedgerBySource(domainCashMovements(nextDocument, portfolioId));
    }

    const run = entityRecord(
      input.occurrenceId,
      context.engine.deviceId,
      timestamp,
      parseVaultData(
        () =>
          VAULT_ENTITY_ROW_SCHEMAS.standingOrderRun.parse({
            standingOrderId: input.orderId,
            periodKey: input.dueDate,
            bookedAt: timestamp,
          }),
        'A standing-order run does not match the strict restore contract.',
      ),
    );
    const updatedOrder: VaultEntity = {
      ...order,
      rev: order.rev + 1,
      editedAt: timestamp,
      editedBy: context.engine.deviceId,
      data: parseVaultData(
        () =>
          VAULT_ENTITY_ROW_SCHEMAS.standingOrder.parse({
            ...order.data,
            lastRunAt: timestamp,
            lastPeriodKey: input.dueDate,
            updatedAt: timestamp,
          }),
        'A standing order does not match the strict restore contract.',
      ),
    };
    created = true;
    return appendEntities(
      replaceEntity(nextDocument, 'standingOrder', updatedOrder),
      'standingOrderRun',
      [run],
    );
  });

  signal?.throwIfAborted();
  const committedDocument = mutationState.active?.document;
  if (committedDocument == null) {
    throw storeError(
      'VAULT_DATA_UNAVAILABLE',
      'The standing-order occurrence was not committed locally.',
    );
  }
  const committed = existingStandingOrderOccurrence(committedDocument, input);
  if (committed == null) {
    throw storeError(
      'VAULT_DATA_UNAVAILABLE',
      'The standing-order occurrence did not survive commit and reconciliation.',
    );
  }
  return { ...committed, status: created ? 'created' : 'existing' };
}

function assertStandingOrderOccurrenceInput(input: VaultStandingOrderOccurrenceInput): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (
    !uuid.test(input.occurrenceId) ||
    !uuid.test(input.orderId) ||
    !day.test(input.dueDate) ||
    !day.test(input.calendarDay) ||
    input.timezone.trim().length === 0 ||
    !Number.isFinite(Date.parse(input.executedAt))
  ) {
    throw storeError('VAULT_DATA_INVALID', 'The standing-order occurrence identity is invalid.');
  }
}

function requireLiveStandingOrder(document: VaultDocumentV1, orderId: string): VaultEntity {
  const order = findLiveEntity(document, 'standingOrder', orderId);
  if (order == null) {
    throw storeError('VAULT_ENTITY_NOT_FOUND', 'Standing order not found in the active vault.');
  }
  parseVaultData(
    () => VAULT_ENTITY_ROW_SCHEMAS.standingOrder.parse(order.data),
    'A standing order does not match the strict restore contract.',
  );
  return order;
}

function assertStandingOrderDefinition(
  document: VaultDocumentV1,
  order: VaultEntity,
  input: VaultStandingOrderOccurrenceInput,
): void {
  const portfolio = requirePortfolio(document, stringField(order.data, 'portfolioId'));
  if (stringField(order.data, 'userId') !== stringField(portfolio.data, 'userId')) {
    throw storeError('VAULT_DATA_INVALID', 'The standing order and portfolio owners do not match.');
  }
  const isBuy = stringField(order.data, 'kind') === 'buy-asset';
  const assetId = nullableStringField(order.data, 'assetId');
  if (isBuy !== (assetId !== null)) {
    throw storeError(
      'VAULT_DATA_INVALID',
      'A standing-order asset is required exactly for an asset buy.',
    );
  }
  if (
    !isBuy &&
    (stringField(order.data, 'currency') !== 'EUR' ||
      input.price !== undefined ||
      input.quoteCurrency !== undefined)
  ) {
    throw storeError(
      'VAULT_DATA_INVALID',
      'Cash standing orders must use EUR and cannot carry quote data.',
    );
  }
  const lastRunAt = nullableStringField(order.data, 'lastRunAt');
  const lastPeriodKey = nullableStringField(order.data, 'lastPeriodKey');
  if ((lastRunAt === null) !== (lastPeriodKey === null)) {
    throw storeError('VAULT_DATA_INVALID', 'A standing-order run watermark is incomplete.');
  }
}

function assertStandingOrderDue(
  order: VaultEntity,
  input: VaultStandingOrderOccurrenceInput,
): void {
  const status = stringField(order.data, 'status');
  const startDate = stringField(order.data, 'startDate');
  const endDate = nullableStringField(order.data, 'endDate');
  const lastPeriodKey = nullableStringField(order.data, 'lastPeriodKey');
  let actualCalendarDay: string;
  try {
    actualCalendarDay = calendarDayInTimezone(new Date(input.executedAt), input.timezone);
  } catch (cause) {
    throw storeError('VAULT_DATA_INVALID', 'The standing-order timezone is invalid.', cause);
  }
  let expectedDue: string | null;
  try {
    expectedDue = dueStandingOrderOccurrence(
      {
        cadence: stringField(order.data, 'cadence') as 'daily' | 'monthly',
        anchorDay: typeof order.data.anchorDay === 'number' ? order.data.anchorDay : null,
        startDate,
        endDate,
      },
      input.calendarDay,
    );
  } catch (cause) {
    throw storeError('VAULT_DATA_INVALID', 'The standing-order schedule is invalid.', cause);
  }
  if (status !== 'active') {
    throw storeError('VAULT_OPERATION_UNAVAILABLE', 'A paused standing order cannot be booked.');
  }
  if (
    input.dueDate < startDate ||
    (endDate != null && input.dueDate > endDate) ||
    input.dueDate > input.calendarDay ||
    input.calendarDay !== actualCalendarDay ||
    input.dueDate !== expectedDue
  ) {
    throw storeError(
      'VAULT_DATA_INVALID',
      'The standing-order occurrence is outside its schedule.',
    );
  }
  if (lastPeriodKey != null && lastPeriodKey >= input.dueDate) {
    throw storeError(
      'VAULT_DATA_INVALID',
      'A standing order is marked booked without its deterministic occurrence rows.',
    );
  }
}

function standingOrderRowKind(order: VaultEntity): 'transaction' | 'cashMovement' {
  return stringField(order.data, 'kind') === 'buy-asset' ? 'transaction' : 'cashMovement';
}

export function existingStandingOrderOccurrence(
  document: VaultDocumentV1,
  input: VaultStandingOrderOccurrenceInput,
): VaultStandingOrderOccurrenceResult | null {
  const order = findLiveEntity(document, 'standingOrder', input.orderId);
  const runById = findLiveEntity(document, 'standingOrderRun', input.occurrenceId);
  const semanticRuns = liveEntities(document, 'standingOrderRun').filter(
    (candidate) =>
      stringField(candidate.data, 'standingOrderId') === input.orderId &&
      stringField(candidate.data, 'periodKey') === input.dueDate,
  );
  if (semanticRuns.length > 1) {
    throw storeError(
      'VAULT_DATA_INVALID',
      'A standing-order period has more than one durable claim.',
    );
  }
  const semanticRun = semanticRuns[0];
  if (runById != null && semanticRun !== runById) {
    throw storeError(
      'VAULT_DATA_INVALID',
      'A standing-order occurrence id conflicts with another period claim.',
    );
  }
  const run = runById ?? semanticRun;
  const transaction = findLiveEntity(document, 'transaction', input.occurrenceId);
  const cashMovement = findLiveEntity(document, 'cashMovement', input.occurrenceId);
  const ledgerRows = [transaction, cashMovement].filter((entity) => entity != null);

  /*
   * Cleartext server execution predates deterministic client ids. Its
   * `(standingOrderId, periodKey)` run row is the at-most-once claim, while the
   * booked ledger row has a separate random id. A claim can intentionally have
   * no ledger row when server booking failed after the claim. Preserve either
   * legacy shape as an existing occurrence; only deterministic client claims
   * promise the atomic run + ledger + watermark aggregate validated below.
   */
  if (run != null && run.id !== input.occurrenceId) {
    if (order == null || ledgerRows.length !== 0) {
      throw storeError(
        'VAULT_DATA_INVALID',
        'A legacy standing-order claim conflicts with deterministic occurrence rows.',
      );
    }
    parseVaultData(
      () => VAULT_ENTITY_ROW_SCHEMAS.standingOrderRun.parse(run.data),
      'A standing-order run does not match the strict restore contract.',
    );
    return {
      occurrenceId: input.occurrenceId,
      orderId: input.orderId,
      dueDate: input.dueDate,
      rowKind: standingOrderRowKind(order),
      status: 'existing',
    };
  }

  if (run == null && ledgerRows.length === 0) {
    if (
      order != null &&
      nullableStringField(order.data, 'lastPeriodKey') != null &&
      nullableStringField(order.data, 'lastPeriodKey')! >= input.dueDate
    ) {
      throw storeError(
        'VAULT_DATA_INVALID',
        'A standing order is marked booked without its deterministic occurrence rows.',
      );
    }
    return null;
  }
  if (order == null || run == null || ledgerRows.length !== 1) {
    throw storeError(
      'VAULT_DATA_INVALID',
      'A standing-order occurrence is incomplete or has conflicting ledger rows.',
    );
  }
  const runData = parseVaultData(
    () => VAULT_ENTITY_ROW_SCHEMAS.standingOrderRun.parse(run.data),
    'A standing-order run does not match the strict restore contract.',
  );
  const rowKind = standingOrderRowKind(order);
  const ledger = rowKind === 'transaction' ? transaction : cashMovement;
  if (
    ledger == null ||
    runData.standingOrderId !== input.orderId ||
    runData.periodKey !== input.dueDate ||
    nullableStringField(order.data, 'lastPeriodKey') == null ||
    nullableStringField(order.data, 'lastPeriodKey')! < input.dueDate ||
    stringField(ledger.data, 'source') !== SOURCE_TAG_STANDING_ORDER
  ) {
    throw storeError(
      'VAULT_DATA_INVALID',
      'A standing-order occurrence does not match its deterministic identity.',
    );
  }
  return {
    occurrenceId: input.occurrenceId,
    orderId: input.orderId,
    dueDate: input.dueDate,
    rowKind,
    status: 'existing',
  };
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

interface VaultCascadeRelation {
  parentKind: VaultEntityKind;
  childKind: VaultEntityKind;
  field: string;
  nullable?: boolean;
}

/**
 * Complete portfolio-owned entity graph in document v1. Local deletion,
 * reconciliation, and referential validation all use the same relationships.
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
  if (committed == null || !sameVaultEntity(committed, expected)) {
    throw storeError(
      'VAULT_DATA_UNAVAILABLE',
      'The requested vault update did not survive commit and reconciliation.',
    );
  }
  return { document, entity: committed };
}

function sameVaultEntity(left: VaultEntity, right: VaultEntity): boolean {
  return (
    left.id === right.id &&
    left.rev === right.rev &&
    left.editedAt === right.editedAt &&
    left.editedBy === right.editedBy &&
    left.deletedAt === right.deletedAt &&
    sameJsonValue(left.data, right.data)
  );
}

function sameOptionalVaultEntity(
  left: VaultEntity | undefined,
  right: VaultEntity | undefined,
): boolean {
  return left === undefined || right === undefined ? left === right : sameVaultEntity(left, right);
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

interface ReconcileChange extends VaultMutationEntityDelta {
  local: VaultEntity | undefined;
  remote: VaultEntity | undefined;
}

interface ReconcileGroup {
  sequence: number;
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
 * publishes a divergent merge. Each complete mutation stays in its original
 * sequence position: collapsing overlapping mutations would move later entity
 * snapshots ahead of unrelated intervening work. A rejected group receives
 * dominating compensation, and its entity lineage remains rejected, so no
 * winning subset can reappear on a later reconnect.
 */
export function reconcilePortfolioDocument(
  document: VaultDocumentV1,
  context: VaultDocumentReconcileContext,
): VaultDocumentReconcileResult {
  const groups = reconcileGroups(context.mutations, context);
  let reconciled = document;
  for (const group of groups) {
    for (const change of group.changes) {
      reconciled = setEntity(reconciled, change.kind, change.id, change.remote);
    }
  }
  assertPortfolioDocumentInvariants(reconciled, context.remote);

  const rejectedEntityKeys = new Set<string>();
  const rebasedMutations: VaultAtomicMutation[] = [];
  for (const group of groups) {
    const beforeGroup = reconciled;
    const completeGroupWon = group.changes.every(
      (change) =>
        !rejectedEntityKeys.has(entityRefKey(change.kind, change.id)) &&
        sameOptionalVaultEntity(findEntity(document, change.kind, change.id), change.local),
    );
    if (!completeGroupWon) {
      reconciled = compensateRejectedGroup(reconciled, group, context);
      for (const change of group.changes) {
        rejectedEntityKeys.add(entityRefKey(change.kind, change.id));
      }
    } else {
      let candidate = reconciled;
      for (const change of group.changes) {
        candidate = setEntity(candidate, change.kind, change.id, change.after);
      }
      candidate = enforceDeletionCascades(candidate, context);

      try {
        assertPortfolioDocumentInvariants(candidate, context.remote);
        reconciled = candidate;
      } catch (cause) {
        if (!isAggregateConflict(cause)) throw cause;
        reconciled = compensateRejectedGroup(reconciled, group, context);
        for (const change of group.changes) {
          rejectedEntityKeys.add(entityRefKey(change.kind, change.id));
        }
      }
    }

    const rebased = rebaseReconcileGroup(group, beforeGroup, reconciled);
    if (rebased != null) rebasedMutations.push(rebased);
  }

  assertPortfolioDocumentInvariants(reconciled, context.remote);
  return { document: reconciled, mutations: rebasedMutations };
}

function reconcileGroups(
  mutations: readonly VaultAtomicMutation[],
  context: VaultDocumentReconcileContext,
): ReconcileGroup[] {
  return mutations
    .filter((mutation) => mutation.changes.length > 0)
    .map(
      (mutation): ReconcileGroup => ({
        sequence: mutation.sequence,
        changes: [...mutation.changes]
          .sort((left, right) =>
            entityRefKey(left.kind, left.id).localeCompare(entityRefKey(right.kind, right.id)),
          )
          .map((change) => ({
            ...change,
            local: findEntity(context.local, change.kind, change.id),
            remote: findEntity(context.remote, change.kind, change.id),
          })),
      }),
    )
    .sort(
      (left, right) =>
        left.sequence - right.sequence ||
        left.changes
          .map((change) => entityRefKey(change.kind, change.id))
          .join('\u0000')
          .localeCompare(
            right.changes.map((change) => entityRefKey(change.kind, change.id)).join('\u0000'),
          ),
    );
}

function rebaseReconcileGroup(
  group: ReconcileGroup,
  before: VaultDocumentV1,
  after: VaultDocumentV1,
): VaultAtomicMutation | null {
  const refs = new Map<string, VaultEntityRef>();
  for (const change of group.changes) {
    refs.set(entityRefKey(change.kind, change.id), { kind: change.kind, id: change.id });
  }

  const kinds = new Set<VaultEntityKind>([
    ...(Object.keys(before.entities) as VaultEntityKind[]),
    ...(Object.keys(after.entities) as VaultEntityKind[]),
  ]);
  for (const kind of kinds) {
    const beforeById = new Map((before.entities[kind] ?? []).map((entity) => [entity.id, entity]));
    const afterById = new Map((after.entities[kind] ?? []).map((entity) => [entity.id, entity]));
    for (const id of new Set([...beforeById.keys(), ...afterById.keys()])) {
      if (sameOptionalVaultEntity(beforeById.get(id), afterById.get(id))) continue;
      refs.set(entityRefKey(kind, id), { kind, id });
    }
  }

  const changes = [...refs.values()]
    .sort((left, right) =>
      entityRefKey(left.kind, left.id).localeCompare(entityRefKey(right.kind, right.id)),
    )
    .map(
      ({ kind, id }): VaultMutationEntityDelta => ({
        kind,
        id,
        before: findEntity(before, kind, id),
        after: findEntity(after, kind, id),
      }),
    );
  return changes.some((change) => !sameOptionalVaultEntity(change.before, change.after))
    ? { sequence: group.sequence, changes }
    : null;
}

function compensateRejectedGroup(
  document: VaultDocumentV1,
  group: ReconcileGroup,
  context: VaultDocumentReconcileContext,
): VaultDocumentV1 {
  let compensated = document;
  for (const change of group.changes) {
    const desired = findEntity(compensated, change.kind, change.id);
    if (sameOptionalVaultEntity(change.local, desired)) continue;
    compensated = setEntity(
      compensated,
      change.kind,
      change.id,
      compensationEntity(change.local, desired, context),
    );
  }
  compensated = enforceDeletionCascades(compensated, context);
  assertPortfolioDocumentInvariants(compensated, context.remote);
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

function compensationEntity(
  rejected: VaultEntity | undefined,
  desired: VaultEntity | undefined,
  context: VaultDocumentReconcileContext,
): VaultEntity | undefined {
  if (rejected == null) return desired;
  if (desired == null) {
    return tombstoneEntity(rejected, context.deviceId, context.reconciledAt);
  }
  return {
    ...desired,
    rev: Math.max(rejected.rev, desired.rev) + 1,
    editedAt: context.reconciledAt,
    editedBy: context.deviceId,
    deletedAt: desired.deletedAt === null ? null : context.reconciledAt,
  };
}

function assertPortfolioDocumentInvariants(
  document: VaultDocumentV1,
  durableBaseline: VaultDocumentV1,
): void {
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
    if (sameAssetTimeline(document, durableBaseline, portfolioId, assetId)) continue;
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

interface TransactionCreateCandidate {
  id: string;
  input: ReturnType<typeof transactionInputSchema.parse>;
  data: Record<string, unknown>;
}

function appendTransactionCandidates(
  document: VaultDocumentV1,
  candidates: readonly TransactionCreateCandidate[],
  deviceId: string,
  timestamp: string,
): { document: VaultDocumentV1; entities: VaultEntity[] } {
  const entities = candidates.map(({ id, input, data }) => {
    resolveTransactionAsset(document, input.assetId);
    return entityRecord(id, deviceId, timestamp, data);
  });
  return {
    document: appendEntities(document, 'transaction', entities),
    entities,
  };
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
    .map((entity) => ({
      entity,
      executedAtMs: transactionExecutedAtMs(entity),
    }))
    .sort(
      (left, right) =>
        left.executedAtMs - right.executedAtMs || left.entity.id.localeCompare(right.entity.id),
    )
    .map(({ entity }) => transactionFromEntity(document, entity));
  reducePosition(transactions);
}

function assertProspectiveAssetTimelines(
  document: VaultDocumentV1,
  portfolioId: string,
  assetIds: readonly string[],
): void {
  try {
    for (const assetId of new Set(assetIds)) {
      assertValidAssetTimeline(document, portfolioId, assetId);
    }
  } catch (cause) {
    if (!(cause instanceof OversellError)) throw cause;
    throw storeError(
      'VAULT_DATA_INVALID',
      'The transaction mutation would oversell the available holding.',
      cause,
    );
  }
}

function transactionExecutedAtMs(entity: VaultEntity): number {
  const executedAt = stringField(entity.data, 'executedAt');
  const executedAtMs = Date.parse(executedAt);
  if (!Number.isFinite(executedAtMs)) {
    throw storeError(
      'VAULT_DATA_INVALID',
      'A vault transaction has an invalid execution timestamp.',
    );
  }
  return executedAtMs;
}

function sameAssetTimeline(
  left: VaultDocumentV1,
  right: VaultDocumentV1,
  portfolioId: string,
  assetId: string,
): boolean {
  const timeline = (document: VaultDocumentV1) =>
    liveEntities(document, 'transaction')
      .filter(
        (entity) =>
          stringField(entity.data, 'portfolioId') === portfolioId &&
          stringField(entity.data, 'assetId') === assetId,
      )
      .sort((first, second) => first.id.localeCompare(second.id))
      .map((entity) => ({
        id: entity.id,
        side: entity.data.side,
        quantity: entity.data.quantity,
        price: entity.data.price,
        fee: entity.data.fee,
        executedAt: entity.data.executedAt,
        allowUncovered: entity.data.allowUncovered,
        uncoveredEntryPrice: entity.data.uncoveredEntryPrice,
      }));
  const leftRows = timeline(left);
  const rightRows = timeline(right);
  return (
    leftRows.length === rightRows.length &&
    leftRows.every((transaction, index) => sameJsonValue(transaction, rightRows[index]))
  );
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
