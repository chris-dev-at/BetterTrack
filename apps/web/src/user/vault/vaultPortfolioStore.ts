import {
  cashEntryRequestSchema,
  cashMovementsResponseSchema,
  cashMovementResponseSchema,
  cashMovementSchema,
  cashPreviewRequestSchema,
  cashPreviewResponseSchema,
  cashSourceListResponseSchema,
  cashSourceSchema,
  cashTransferRequestSchema,
  cashTransferResponseSchema,
  createCustomAssetRequestSchema,
  createCustomAssetResponseSchema,
  createStandingOrderRequestSchema,
  createCashSourceRequestSchema,
  createPortfolioRequestSchema,
  createTransactionsRequestSchema,
  customAssetListResponseSchema,
  customAssetSchema,
  portfolioAssetSchema,
  portfolioListResponseSchema,
  portfolioSummarySchema,
  portfolioTaxSettingsResponseSchema,
  setCashBalanceRequestSchema,
  setCashBalanceResponseSchema,
  SOURCE_TAG_STANDING_ORDER,
  standingOrderListResponseSchema,
  standingOrderSchema,
  taxSettingsResponseSchema,
  transactionInputSchema,
  transactionListQuerySchema,
  transactionListResponseSchema,
  transactionSchema,
  updateCashSourceRequestSchema,
  updateCustomAssetRequestSchema,
  updatePortfolioRequestSchema,
  updateStandingOrderRequestSchema,
  updateTaxSettingsRequestSchema,
  updateTransactionRequestSchema,
  valuePointsResponseSchema,
  VAULT_ENTITY_KINDS,
  VAULT_ENTITY_ROW_SCHEMAS,
  type CashEntryRequest,
  type CashMovementsResponse,
  type CashMovementResponse,
  type CashPreviewRequest,
  type CashPreviewResponse,
  type CashSource,
  type CashSourceListResponse,
  type CashTransferRequest,
  type CashTransferResponse,
  type CreateStandingOrderRequest,
  type CreateCashSourceRequest,
  type CreateCustomAssetRequest,
  type CreateCustomAssetResponse,
  type CreatePortfolioRequest,
  type AssetSummary,
  type CustomAsset,
  type CustomAssetListResponse,
  type PortfolioAsset,
  type PortfolioListResponse,
  type PortfolioResponse,
  type PortfolioSummary,
  type PortfolioTaxSettingsResponse,
  type SetCashBalanceRequest,
  type SetCashBalanceResponse,
  type StandingOrder,
  type StandingOrderListResponse,
  type TaxSettingsResponse,
  type Transaction,
  type TransactionInput,
  type TransactionListResponse,
  type UpdateCashSourceRequest,
  type UpdateCustomAssetRequest,
  type UpdatePortfolioRequest,
  type UpdateStandingOrderRequest,
  type UpdateTaxSettingsRequest,
  type UpdateTransactionRequest,
  type VaultDocument,
  type VaultEntity,
  type VaultEntityKind,
  type ValuePoint,
  type ValuePointsResponse,
} from '@bettertrack/contracts';
import {
  cashBalance,
  cashBalancesBySource,
  CASH_EPSILON,
  CASH_MOVEMENT_SIGN,
  floorCents,
  InsufficientCashError,
  projectCashLedgerBySource,
  spendableAsOf,
  type SourcedCashMovement,
} from '@bettertrack/domain/cashLedger';
import { OversellError, reducePosition } from '@bettertrack/domain/holdings';
import { viennaYearOf } from '@bettertrack/domain/tax';
import { uuidv7 } from 'uuidv7';

import { getAssetDetail } from '../../lib/assetApi';
import { marketAssetSnapshotRow, ownedAssetSnapshotRow } from './assetSnapshot';
import { VaultCryptoError } from './errors';
import { standingOrderOccurrenceId } from './standingOrders/occurrenceId';
import {
  calendarDayInTimezone,
  dueStandingOrderOccurrence,
  nextStandingOrderRunDate,
} from './standingOrders/schedule';
import type {
  VaultAtomicMutation,
  VaultDocumentReconcileContext,
  VaultDocumentReconcileResult,
  VaultMutationEntityDelta,
  VaultSyncEngine,
  VaultSyncState,
} from './sync';

/** The server stores transaction prices as numeric(20,6) (schema.ts). */
const TRANSACTION_PRICE_SCALE = 6;

export const VAULT_PORTFOLIO_STORE_ERROR_CODES = [
  'VAULT_LOCKED',
  'VAULT_CORRUPT',
  'VAULT_DATA_UNAVAILABLE',
  'VAULT_ENTITY_NOT_FOUND',
  'VAULT_OPERATION_ABORTED',
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
  /**
   * Resolve one asset the vault's local asset table has never seen
   * (`GET /assets/:id` by default). The §8 kept search/detail surfaces stay
   * server-backed, so this is the one read the unlocked store performs outside
   * the vault: when a transaction or `buy-asset` standing order references a
   * market asset for the first time, its catalog snapshot is written into the
   * document so the client engine can price and label the position offline.
   * Return `null` for an unknown id.
   */
  resolveMarketAsset?: (assetId: string, signal?: AbortSignal) => Promise<AssetSummary | null>;
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
  /** Authenticated candidate from which the due occurrence and quote were selected. */
  expectedCandidate: {
    vaultVersion: number;
    vaultKeyId: string;
    writeId: string;
  };
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
  archivePortfolio(portfolioId: string): Promise<PortfolioSummary>;
  restorePortfolio(portfolioId: string): Promise<PortfolioSummary>;
  deletePortfolio(portfolioId: string): Promise<void>;
  getTaxSettings(signal?: AbortSignal): Promise<TaxSettingsResponse>;
  updateTaxSettings(body: UpdateTaxSettingsRequest): Promise<TaxSettingsResponse>;
  getPortfolioTaxSettings(
    portfolioId: string,
    signal?: AbortSignal,
  ): Promise<PortfolioTaxSettingsResponse>;
  setPortfolioTaxOverride(
    portfolioId: string,
    body: UpdateTaxSettingsRequest,
  ): Promise<PortfolioTaxSettingsResponse>;
  clearPortfolioTaxOverride(portfolioId: string): Promise<PortfolioTaxSettingsResponse>;
  listCustomAssets(signal?: AbortSignal): Promise<CustomAssetListResponse>;
  createCustomAsset(body: CreateCustomAssetRequest): Promise<CreateCustomAssetResponse>;
  updateCustomAsset(id: string, patch: UpdateCustomAssetRequest): Promise<CustomAsset>;
  getValuePoints(id: string, signal?: AbortSignal): Promise<ValuePointsResponse>;
  putValuePoints(id: string, points: ValuePoint[]): Promise<ValuePointsResponse>;
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
  listCashSources(
    portfolioId: string,
    includeArchived?: boolean,
    signal?: AbortSignal,
  ): Promise<CashSourceListResponse>;
  createCashSource(portfolioId: string, body: CreateCashSourceRequest): Promise<CashSource>;
  updateCashSource(
    portfolioId: string,
    sourceId: string,
    patch: UpdateCashSourceRequest,
  ): Promise<CashSource>;
  archiveCashSource(
    portfolioId: string,
    sourceId: string,
    options?: { baseSeq?: number },
  ): Promise<CashSource>;
  restoreCashSource(
    portfolioId: string,
    sourceId: string,
    options?: { baseSeq?: number },
  ): Promise<CashSource>;
  getCashMovements(portfolioId: string, signal?: AbortSignal): Promise<CashMovementsResponse>;
  previewCash(
    portfolioId: string,
    body: CashPreviewRequest,
    signal?: AbortSignal,
  ): Promise<CashPreviewResponse>;
  depositCash(portfolioId: string, body: CashEntryRequest): Promise<CashMovementResponse>;
  withdrawCash(portfolioId: string, body: CashEntryRequest): Promise<CashMovementResponse>;
  /**
   * Record a standing custody/account fee (V5, §16 2026-07-30). Kept at parity
   * with the API store so the fee surface cannot work in normal mode and silently
   * fail in paranoid mode once the bootstrap composes this seam.
   */
  chargeCashFee(portfolioId: string, body: CashEntryRequest): Promise<CashMovementResponse>;
  transferCash(portfolioId: string, body: CashTransferRequest): Promise<CashTransferResponse>;
  setCashBalance(
    portfolioId: string,
    sourceId: string,
    body: SetCashBalanceRequest,
  ): Promise<SetCashBalanceResponse>;
  listStandingOrders(
    portfolioId?: string,
    signal?: AbortSignal,
  ): Promise<StandingOrderListResponse>;
  createStandingOrder(body: CreateStandingOrderRequest): Promise<StandingOrder>;
  updateStandingOrder(id: string, patch: UpdateStandingOrderRequest): Promise<StandingOrder>;
  pauseStandingOrder(id: string): Promise<StandingOrder>;
  resumeStandingOrder(id: string): Promise<StandingOrder>;
  deleteStandingOrder(id: string): Promise<void>;
  materializeStandingOrderOccurrence(
    input: VaultStandingOrderOccurrenceInput,
    signal?: AbortSignal,
  ): Promise<VaultStandingOrderOccurrenceResult>;
  /**
   * "Start fresh" (docs/paranoid-design.md §3): empty the vault while KEEPING
   * it, for a user who wants their encrypted account to begin again.
   *
   * It tombstones every live entity rather than dropping the buckets, because
   * the vault merge is an entity-atomic UNION: absence carries no delete
   * signal, and an empty document does not dominate a populated one
   * (`mergeVaultDocuments`), so a second device still holding the pre-wipe
   * document would union its rows straight back on its next unlock. A
   * tombstone wins by revision on every device instead — the same idiom
   * `deletePortfolioTree` / `deleteTransaction` / `deleteStandingOrder` use.
   * `mergeLog` is preserved for the same reason: it is the bounded convergence
   * history the merge path reads, not user data.
   *
   * The same mutation then seeds one empty default portfolio, so the emptied
   * vault is a usable fresh account (§6.8: an account always owns at least one
   * active portfolio) rather than a document that can neither be added to nor
   * rehydrated back to normal mode.
   */
  discardAllData(): Promise<void>;
}

interface StoreContext {
  engine: VaultSyncEngine;
  now: () => string;
  newId: () => string;
  resolveMarketAsset: (assetId: string, signal?: AbortSignal) => Promise<AssetSummary | null>;
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
    resolveMarketAsset:
      options.resolveMarketAsset ??
      (async (assetId, signal) => (await getAssetDetail(assetId, signal)).asset),
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

    async archivePortfolio(portfolioId) {
      const current = requireDocument(engine);
      const active = portfolioSummariesFromDocument(current).filter(
        (portfolio) => portfolio.archivedAt === null,
      );
      if (active.length <= 1 && active[0]?.id === portfolioId) {
        throw storeError(
          'VAULT_OPERATION_UNAVAILABLE',
          'The last active portfolio cannot be archived.',
        );
      }
      const entity = await updateEntity(context, 'portfolio', portfolioId, (data) => ({
        ...data,
        archivedAt: context.now(),
      }));
      return portfolioSummaryForId(requireDocument(engine), entity.id);
    },

    async restorePortfolio(portfolioId) {
      const entity = await updateEntity(context, 'portfolio', portfolioId, (data) => ({
        ...data,
        archivedAt: null,
      }));
      return portfolioSummaryForId(requireDocument(engine), entity.id);
    },

    async deletePortfolio(portfolioId) {
      await deletePortfolioTree(context, portfolioId);
    },

    async getTaxSettings(signal) {
      signal?.throwIfAborted();
      return userTaxSettingsFromDocument(requireDocument(engine));
    },

    async updateTaxSettings(body) {
      const parsed = updateTaxSettingsRequestSchema.parse(body);
      const document = requireDocument(engine);
      const existing = latestUserTaxSetting(document);
      const value = taxSettingsValue(parsed);
      const userId =
        existing == null ? portfolioOwnerUserId(document) : stringField(existing.data, 'userId');
      const row = (updatedAt: string) =>
        strictTaxSettingData({
          userId,
          mode: value.mode,
          country: value.country,
          manualDefaultAmountEur:
            value.manualDefaultAmountEur == null
              ? null
              : decimalStringFromNumber(value.manualDefaultAmountEur),
          manualDefaultRatePct:
            value.manualDefaultRatePct == null
              ? null
              : decimalStringFromNumber(value.manualDefaultRatePct),
          customParams: value.custom ?? null,
          updatedAt,
        });
      if (existing == null) {
        await appendEntity(context, 'taxSetting', (_next, id, timestamp) =>
          entityRecord(id, engine.deviceId, timestamp, row(timestamp)),
        );
      } else {
        await updateEntity(context, 'taxSetting', existing.id, () => row(context.now()));
      }
      return userTaxSettingsFromDocument(requireDocument(engine));
    },

    async getPortfolioTaxSettings(portfolioId, signal) {
      signal?.throwIfAborted();
      return portfolioTaxSettingsFromDocument(requireDocument(engine), portfolioId);
    },

    async setPortfolioTaxOverride(portfolioId, body) {
      const parsed = updateTaxSettingsRequestSchema.parse(body);
      const document = requireDocument(engine);
      requirePortfolio(document, portfolioId);
      const existing = findPortfolioTaxSetting(document, portfolioId);
      const value = taxSettingsValue(parsed);
      if (existing == null) {
        await appendEntity(context, 'portfolioSetting', (_next, id, timestamp) =>
          entityRecord(
            id,
            engine.deviceId,
            timestamp,
            strictPortfolioSettingData({
              portfolioId,
              key: 'tax',
              value,
              updatedAt: timestamp,
            }),
          ),
        );
      } else {
        await updateEntity(context, 'portfolioSetting', existing.id, (data) =>
          strictPortfolioSettingData({
            ...data,
            value,
            updatedAt: context.now(),
          }),
        );
      }
      return portfolioTaxSettingsFromDocument(requireDocument(engine), portfolioId);
    },

    async clearPortfolioTaxOverride(portfolioId) {
      const document = requireDocument(engine);
      requirePortfolio(document, portfolioId);
      const existing = findPortfolioTaxSetting(document, portfolioId);
      if (existing != null) {
        await engine.mutate(({ document: next }) => {
          const current = findLiveEntity(next, 'portfolioSetting', existing.id);
          if (current == null) return next;
          return replaceEntity(
            next,
            'portfolioSetting',
            tombstoneEntity(current, engine.deviceId, context.now()),
          );
        });
      }
      return portfolioTaxSettingsFromDocument(requireDocument(engine), portfolioId);
    },

    async listCustomAssets(signal) {
      signal?.throwIfAborted();
      const document = requireDocument(engine);
      const assets = liveEntities(document, 'customAsset')
        .filter((entity) => nullableStringField(entity.data, 'ownerId') !== null)
        .map((entity) => {
          const asset = customAssetFromEntity(entity);
          const latestValue =
            valuePointsFromDocument(document, entity.id)
              .sort((left, right) => left.date.localeCompare(right.date))
              .at(-1) ?? null;
          return { ...asset, latestValue };
        });
      return customAssetListResponseSchema.parse({ assets });
    },

    async createCustomAsset(body) {
      return createCustomAsset(context, body);
    },

    async updateCustomAsset(id, patch) {
      const parsed = updateCustomAssetRequestSchema.parse(patch);
      const entity = await updateEntity(context, 'customAsset', id, (data) => {
        if (nullableStringField(data, 'ownerId') === null) {
          throw storeError('VAULT_OPERATION_UNAVAILABLE', 'Only custom assets can be edited.');
        }
        const meta = recordField(data, 'meta') ?? {};
        return strictCustomAssetData({
          ...data,
          ...(parsed.name === undefined
            ? {}
            : { name: parsed.name, symbol: parsed.name, searchText: parsed.name }),
          meta: {
            ...meta,
            ...(parsed.category === undefined ? {} : { category: parsed.category }),
            ...(parsed.smoothing === undefined ? {} : { smoothing: parsed.smoothing }),
          },
        });
      });
      return customAssetFromEntity(entity);
    },

    async getValuePoints(id, signal) {
      signal?.throwIfAborted();
      const document = requireDocument(engine);
      requireOwnedCustomAsset(document, id);
      return valuePointsResponseSchema.parse({
        points: valuePointsFromDocument(document, id).sort((left, right) =>
          left.date.localeCompare(right.date),
        ),
      });
    },

    async putValuePoints(id, points) {
      const parsed = valuePointsResponseSchema.parse({ points });
      await replaceCustomAssetValuePoints(context, id, parsed.points);
      return valuePointsResponseSchema.parse({
        points: valuePointsFromDocument(requireDocument(engine), id).sort((left, right) =>
          left.date.localeCompare(right.date),
        ),
      });
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
      // Snapshot any first-referenced market asset in the SAME mutation as the
      // rows that reference it, so no intermediate document state dangles.
      const marketSnapshots = await marketSnapshotsForMissingAssets(
        context,
        current,
        candidates.map(({ input }) => input.assetId),
      );
      assertLocallySupportedTransactions(current, portfolioId, candidates, context.now());
      const initialCandidate = appendTransactionCandidates(
        appendMarketSnapshots(current, marketSnapshots, engine.deviceId, context.now()),
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
          appendMarketSnapshots(document, marketSnapshots, engine.deviceId, context.now()),
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

    async listCashSources(portfolioId, includeArchived = false, signal) {
      signal?.throwIfAborted();
      const document = requireDocument(engine);
      requirePortfolio(document, portfolioId);
      const balances = cashBalancesBySource(domainCashMovements(document, portfolioId));
      const sources = liveEntities(document, 'cashSource')
        .filter(
          (entity) =>
            stringField(entity.data, 'portfolioId') === portfolioId &&
            (includeArchived || nullableStringField(entity.data, 'archivedAt') === null),
        )
        .map((entity) => cashSourceFromEntity(entity, balances.get(entity.id) ?? 0))
        .sort(compareCashSources);
      return cashSourceListResponseSchema.parse({ sources });
    },

    async createCashSource(portfolioId, body) {
      const parsed = createCashSourceRequestSchema.parse(body);
      const current = requireDocument(engine);
      requirePortfolio(current, portfolioId);
      assertUniqueCashSourceName(current, portfolioId, parsed.name);
      // Materialise Main in the SAME mutation, before the sibling, exactly like
      // the server (`portfolioService.createCashSource` →
      // `cashSourceRepository.getOrCreateMain`). A portfolio a vault created —
      // `createPortfolio`, or the one `discardAllData` seeds — owns no cash
      // source at all, and a portfolio that owns ANY source but no active Main
      // is refused wholesale by the restore boundary ("must have exactly one
      // active main cash source"), which neither `openVaultSession` nor
      // `toStrictRestoreDocument` would have caught: the vault would open and
      // then be impossible to leave. Provisioning first also reserves the name,
      // so a sibling can never squat "Main".
      const provisionMain = (document: VaultDocument) =>
        ensureCashSource(context, document, portfolioId, undefined, context.now()).document;
      const entity = await appendEntity(
        context,
        'cashSource',
        (document, id, timestamp) => {
          requirePortfolio(document, portfolioId);
          assertUniqueCashSourceName(document, portfolioId, parsed.name);
          return entityRecord(
            id,
            engine.deviceId,
            timestamp,
            strictCashSourceData({
              portfolioId,
              name: parsed.name,
              type: parsed.type,
              isMain: false,
              archivedAt: null,
              createdAt: timestamp,
            }),
          );
        },
        provisionMain,
      );
      return cashSourceFromEntity(entity, 0);
    },

    async updateCashSource(portfolioId, sourceId, patch) {
      const parsed = updateCashSourceRequestSchema.parse(patch);
      const { baseSeq: _baseSeq, ...dataPatch } = parsed;
      const entity = await updateEntity(
        context,
        'cashSource',
        sourceId,
        (data, document, existing) => {
          requireOwnedEntity(document, 'cashSource', sourceId, portfolioId);
          if (dataPatch.name !== undefined) {
            assertUniqueCashSourceName(document, portfolioId, dataPatch.name, existing.id);
          }
          return strictCashSourceData({ ...data, ...definedFields(dataPatch) });
        },
      );
      return currentCashSource(requireDocument(engine), entity);
    },

    async archiveCashSource(portfolioId, sourceId) {
      const document = requireDocument(engine);
      const source = requireOwnedEntity(document, 'cashSource', sourceId, portfolioId);
      if (booleanField(source.data, 'isMain', false)) {
        throw storeError('VAULT_OPERATION_UNAVAILABLE', 'The Main cash source cannot be archived.');
      }
      if (nullableStringField(source.data, 'archivedAt') !== null) {
        throw storeError('VAULT_OPERATION_UNAVAILABLE', 'Cash source is already archived.');
      }
      const balance = cashBalancesBySource(domainCashMovements(document, portfolioId)).get(
        sourceId,
      );
      if (floorCents(balance ?? 0) !== 0) {
        throw storeError(
          'VAULT_OPERATION_UNAVAILABLE',
          'Only an empty cash source can be archived.',
        );
      }
      const entity = await updateEntity(context, 'cashSource', sourceId, (data, nextDocument) => {
        requireOwnedEntity(nextDocument, 'cashSource', sourceId, portfolioId);
        return strictCashSourceData({ ...data, archivedAt: context.now() });
      });
      return currentCashSource(requireDocument(engine), entity);
    },

    async restoreCashSource(portfolioId, sourceId) {
      const document = requireDocument(engine);
      const source = requireOwnedEntity(document, 'cashSource', sourceId, portfolioId);
      if (nullableStringField(source.data, 'archivedAt') === null) {
        throw storeError('VAULT_OPERATION_UNAVAILABLE', 'Cash source is not archived.');
      }
      const entity = await updateEntity(context, 'cashSource', sourceId, (data, nextDocument) => {
        requireOwnedEntity(nextDocument, 'cashSource', sourceId, portfolioId);
        return strictCashSourceData({ ...data, archivedAt: null });
      });
      return currentCashSource(requireDocument(engine), entity);
    },

    async getCashMovements(portfolioId, signal) {
      signal?.throwIfAborted();
      const document = requireDocument(engine);
      requirePortfolio(document, portfolioId);
      const all = liveEntities(document, 'cashMovement')
        .filter((entity) => stringField(entity.data, 'portfolioId') === portfolioId)
        .map(cashMovementFromEntity)
        .sort(
          (left, right) =>
            left.executedAt.localeCompare(right.executedAt) || left.id.localeCompare(right.id),
        );
      const balances = cashBalancesBySource(domainCashMovements(document, portfolioId));
      const sources = liveEntities(document, 'cashSource')
        .filter((entity) => stringField(entity.data, 'portfolioId') === portfolioId)
        .map((entity) => cashSourceFromEntity(entity, balances.get(entity.id) ?? 0))
        .sort(compareCashSources);
      return cashMovementsResponseSchema.parse({
        // Floored like every other cash roll-up the store answers with
        // (`transferCash`, `setCashBalance`, `previewCash`) and like the
        // server's `loadCashState().totalEur`.
        balanceEur: floorCents([...balances.values()].reduce((sum, value) => sum + value, 0)),
        movements: all,
        sources,
      });
    },

    async previewCash(portfolioId, body, signal) {
      signal?.throwIfAborted();
      const parsed = cashPreviewRequestSchema.parse(body);
      const document = requireDocument(engine);
      requirePortfolio(document, portfolioId);
      const sourceId = resolveCashSourceId(document, portfolioId, parsed.sourceId);
      const movements = domainCashMovements(document, portfolioId).filter(
        (movement) => movement.sourceId === sourceId,
      );
      const availableEur = floorCents(cashBalance(movements));
      const amountEur = floorCents(parsed.amountEur);
      const afterEur = floorCents(availableEur + amountEur * CASH_MOVEMENT_SIGN[parsed.kind]);
      const sufficient = afterEur >= -CASH_EPSILON;
      const result: CashPreviewResponse = {
        availableEur,
        afterEur,
        sufficient,
        shortfallEur: sufficient ? 0 : -afterEur,
      };
      if (parsed.asOfDate !== undefined && parsed.kind === 'buy') {
        const asOfAvailableEur = floorCents(
          spendableAsOf(movements, `${parsed.asOfDate}T00:00:00.000Z`),
        );
        const asOfAfterEur = floorCents(asOfAvailableEur - amountEur);
        Object.assign(result, {
          asOfDate: parsed.asOfDate,
          asOfAvailableEur,
          asOfAfterEur,
          asOfSufficient: asOfAfterEur >= -CASH_EPSILON,
        });
      }
      return cashPreviewResponseSchema.parse(result);
    },

    async depositCash(portfolioId, body) {
      return createCashMovement(context, portfolioId, body, 'deposit');
    },

    async withdrawCash(portfolioId, body) {
      return createCashMovement(context, portfolioId, body, 'withdrawal');
    },

    async chargeCashFee(portfolioId, body) {
      return createCashMovement(context, portfolioId, body, 'fee');
    },

    async transferCash(portfolioId, body) {
      return transferCash(context, portfolioId, body);
    },

    async setCashBalance(portfolioId, sourceId, body) {
      return setCashBalance(context, portfolioId, sourceId, body);
    },

    async listStandingOrders(portfolioId, signal) {
      signal?.throwIfAborted();
      const document = requireDocument(engine);
      if (portfolioId !== undefined) requirePortfolio(document, portfolioId);
      const orders = liveEntities(document, 'standingOrder')
        .filter(
          (entity) =>
            portfolioId === undefined || stringField(entity.data, 'portfolioId') === portfolioId,
        )
        .map((entity) => standingOrderFromEntity(document, entity, context.now()))
        .sort(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
        );
      return standingOrderListResponseSchema.parse({ orders });
    },

    async createStandingOrder(body) {
      return createStandingOrder(context, body);
    },

    async updateStandingOrder(id, patch) {
      return updateStandingOrder(context, id, patch);
    },

    async pauseStandingOrder(id) {
      return setStandingOrderStatus(context, id, 'paused');
    },

    async resumeStandingOrder(id) {
      return setStandingOrderStatus(context, id, 'active');
    },

    async deleteStandingOrder(id) {
      await deleteStandingOrder(context, id);
    },

    async materializeStandingOrderOccurrence(input, signal) {
      return materializeStandingOrderOccurrence(context, input, signal);
    },

    async discardAllData() {
      await discardAllData(context);
    },
  };
}

/** Public name used by the architecture note. */
export const vaultPortfolioStore = createVaultPortfolioStore;

function requireDocument(engine: VaultSyncEngine): VaultDocument {
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

function requirePortfolio(document: VaultDocument, portfolioId: string): VaultEntity {
  const portfolio = findLiveEntity(document, 'portfolio', portfolioId);
  if (portfolio == null) {
    throw storeError('VAULT_ENTITY_NOT_FOUND', 'Portfolio not found in the active vault document.');
  }
  return portfolio;
}

function requireOwnedEntity(
  document: VaultDocument,
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
  build: (document: VaultDocument, id: string, timestamp: string) => VaultEntity,
  prepare: (document: VaultDocument) => VaultDocument = (document) => document,
): Promise<VaultEntity> {
  requireDocument(context.engine);
  let id: string | null = null;
  let expected: VaultEntity | null = null;
  const mutationState = await context.engine.mutate(({ document }) => {
    const prepared = prepare(document);
    id = safeNewId(context);
    const entity = build(prepared, id, context.now());
    expected = entity;
    return appendEntities(prepared, kind, [entity]);
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
    document: VaultDocument,
    entity: VaultEntity,
  ) => Record<string, unknown>,
  validateDocument?: (document: VaultDocument) => void,
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

/**
 * Tombstone every live entity in one atomic mutation and seed the guaranteed
 * default portfolio — the "start fresh" write behind
 * {@link VaultPortfolioStore.discardAllData}.
 *
 * The wipe is deliberately NOT an `entities: {}` rewrite: see the interface
 * note for why absence is not a delete signal in an entity-union merge. The
 * bucket keys and `mergeLog` are left exactly as they were.
 *
 * The seed is what makes the result a *usable* empty account rather than a
 * dead end. Everything downstream of the wipe assumes the §6.8 invariant that
 * an account always owns at least one active portfolio: the store resolves the
 * owner id from a live portfolio row ({@link portfolioOwnerUserId}), and the
 * server refuses a rehydration whose graph restores no active portfolio, so an
 * all-tombstoned vault could neither create a portfolio nor leave Paranoid
 * mode. Seeding inside the SAME mutation mirrors `portfolioRepository`'s
 * `getOrCreateMain` — the empty account a normal registration (and the
 * locked-vault discard) starts from.
 *
 * The default tax setting is seeded with it. It states the same `none` mode a
 * settings-free account already reads, so nothing about the account changes —
 * but it keeps the owner id resolvable BY CONSTRUCTION (the migration always
 * emits one too) instead of leaving {@link portfolioOwnerUserId}'s tombstone
 * fallback as the only thing standing between a later portfolio delete and an
 * ownerless vault.
 */
async function discardAllData(context: StoreContext): Promise<void> {
  requireDocument(context.engine);
  let seeded: { kind: VaultEntityKind; id: string }[] = [];
  const mutationState = await context.engine.mutate(({ document }) => {
    const timestamp = context.now();
    let next = document;
    // Read the owner before the wipe; it stays readable from the tombstones.
    const userId = portfolioOwnerUserId(next);
    for (const kind of VAULT_ENTITY_KINDS) {
      for (const entity of liveEntities(next, kind)) {
        next = replaceEntity(
          next,
          kind,
          tombstoneEntity(entity, context.engine.deviceId, timestamp),
        );
      }
    }
    const portfolioId = safeNewId(context);
    const taxSettingId = safeNewId(context);
    seeded = [
      { kind: 'portfolio', id: portfolioId },
      { kind: 'taxSetting', id: taxSettingId },
    ];
    next = appendEntities(next, 'portfolio', [
      entityRecord(
        portfolioId,
        context.engine.deviceId,
        timestamp,
        strictPortfolioData({
          userId,
          name: DEFAULT_PORTFOLIO_NAME,
          visibility: 'private',
          sortOrder: 0,
          defaultPayFromCash: false,
          archivedAt: null,
        }),
      ),
    ]);
    return appendEntities(next, 'taxSetting', [
      entityRecord(
        taxSettingId,
        context.engine.deviceId,
        timestamp,
        strictTaxSettingData({
          userId,
          mode: 'none',
          country: null,
          manualDefaultAmountEur: null,
          manualDefaultRatePct: null,
          customParams: null,
          updatedAt: timestamp,
        }),
      ),
    ]);
  });
  const committed = mutationState.active?.document;
  // Exactly the seeded rows survive the wipe, and nothing else.
  const survivors =
    committed == null
      ? []
      : VAULT_ENTITY_KINDS.flatMap((kind) =>
          liveEntities(committed, kind).map((entity) => `${kind}\u0000${entity.id}`),
        );
  const expected = seeded.map((row) => `${row.kind}\u0000${row.id}`);
  if (
    committed == null ||
    survivors.length !== expected.length ||
    !expected.every((key) => survivors.includes(key))
  ) {
    throw storeError('VAULT_DATA_UNAVAILABLE', 'The vault wipe was not committed locally.');
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
  document: VaultDocument,
  transaction: VaultEntity,
  deviceId: string,
  timestamp: string,
): VaultDocument {
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
  kind: 'deposit' | 'withdrawal' | 'fee',
): Promise<CashMovementResponse> {
  requireDocument(context.engine);
  const parsedBody = cashEntryRequestSchema.parse(body);
  const amountEur = floorCents(parsedBody.amountEur);
  let createdId: string | null = null;
  let expected: VaultEntity | null = null;

  const mutationState = await context.engine.mutate(({ document }) => {
    requirePortfolio(document, portfolioId);
    const timestamp = context.now();
    const resolved = ensureCashSource(
      context,
      document,
      portfolioId,
      parsedBody.sourceId,
      timestamp,
    );
    const sourceId = resolved.sourceId;
    const id = safeNewId(context);
    const entity = entityRecord(
      id,
      context.engine.deviceId,
      timestamp,
      strictCashMovementData({
        portfolioId,
        sourceId,
        kind,
        // The sign comes from the domain's own table, never a local ternary: a
        // `kind === 'withdrawal' ? -x : x` check silently stored a POSITIVE `fee`
        // (V5, §16 2026-07-30), and a positive fee LIFTS the return instead of
        // dragging it. One source of truth for direction, shared with the server.
        amountEur: decimalStringFromNumber(CASH_MOVEMENT_SIGN[kind] * amountEur),
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: parsedBody.executedAt ?? timestamp,
        note: parsedBody.note ?? null,
        source: 'manual',
        // V5 cash fusion: NULL on every hand-entered movement, exactly like the
        // server — no statement import to dedupe, and the amount is truly EUR.
        dedupHash: null,
        originalCurrency: null,
        createdAt: timestamp,
      }),
    );
    projectCashLedgerBySource([
      ...domainCashMovements(resolved.document, portfolioId),
      domainCashMovement(entity),
    ]);
    createdId = id;
    expected = entity;
    return appendEntities(resolved.document, 'cashMovement', [entity]);
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
  const sourceBalanceEur = floorCents(balances.get(sourceId) ?? 0);
  const balanceEur = floorCents([...balances.values()].reduce((sum, value) => sum + value, 0));
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

async function transferCash(
  context: StoreContext,
  portfolioId: string,
  body: CashTransferRequest,
): Promise<CashTransferResponse> {
  requireDocument(context.engine);
  const parsed = cashTransferRequestSchema.parse(body);
  if (parsed.fromSourceId === parsed.toSourceId) {
    throw storeError('VAULT_OPERATION_UNAVAILABLE', 'A transfer needs two different cash sources.');
  }
  const amountEur = floorCents(parsed.amountEur);
  const transferId = safeNewId(context);
  const outgoingId = safeNewId(context);
  const incomingId = safeNewId(context);
  let expectedOutgoing: VaultEntity | null = null;
  let expectedIncoming: VaultEntity | null = null;

  const mutationState = await context.engine.mutate(({ document }) => {
    requirePortfolio(document, portfolioId);
    requireActiveCashSource(document, portfolioId, parsed.fromSourceId);
    requireActiveCashSource(document, portfolioId, parsed.toSourceId);
    const timestamp = context.now();
    const executedAt = parsed.executedAt ?? timestamp;
    const common = {
      portfolioId,
      transactionId: null,
      transferId,
      dividendId: null,
      taxYear: null,
      executedAt,
      note: parsed.note ?? null,
      source: 'manual',
      dedupHash: null,
      originalCurrency: null,
      createdAt: timestamp,
    };
    const outgoing = entityRecord(
      outgoingId,
      context.engine.deviceId,
      timestamp,
      strictCashMovementData({
        ...common,
        sourceId: parsed.fromSourceId,
        kind: 'transfer_out',
        amountEur: decimalStringFromNumber(-amountEur),
        counterpartSourceId: parsed.toSourceId,
      }),
    );
    const incoming = entityRecord(
      incomingId,
      context.engine.deviceId,
      timestamp,
      strictCashMovementData({
        ...common,
        sourceId: parsed.toSourceId,
        kind: 'transfer_in',
        amountEur: decimalStringFromNumber(amountEur),
        counterpartSourceId: parsed.fromSourceId,
      }),
    );
    const next = appendEntities(document, 'cashMovement', [outgoing, incoming]);
    projectCashLedgerBySource(domainCashMovements(next, portfolioId));
    expectedOutgoing = outgoing;
    expectedIncoming = incoming;
    return next;
  });

  const outgoing = requireCommittedMutationEntity(
    mutationState,
    'cashMovement',
    outgoingId,
    expectedOutgoing,
  ).entity;
  const incoming = requireCommittedMutationEntity(
    mutationState,
    'cashMovement',
    incomingId,
    expectedIncoming,
  ).entity;
  const document = requireDocument(context.engine);
  const balances = cashBalancesBySource(domainCashMovements(document, portfolioId));
  return cashTransferResponseSchema.parse({
    outgoing: cashMovementFromEntity(outgoing),
    incoming: cashMovementFromEntity(incoming),
    fromBalanceEur: floorCents(balances.get(parsed.fromSourceId) ?? 0),
    toBalanceEur: floorCents(balances.get(parsed.toSourceId) ?? 0),
    balanceEur: floorCents([...balances.values()].reduce((sum, value) => sum + value, 0)),
  });
}

async function setCashBalance(
  context: StoreContext,
  portfolioId: string,
  sourceId: string,
  body: SetCashBalanceRequest,
): Promise<SetCashBalanceResponse> {
  const parsed = setCashBalanceRequestSchema.parse(body);
  const document = requireDocument(context.engine);
  requireActiveCashSource(document, portfolioId, sourceId);
  const movements = domainCashMovements(document, portfolioId);
  const currentEur = floorCents(
    cashBalance(movements.filter((movement) => movement.sourceId === sourceId)),
  );
  const deltaEur = floorCents(parsed.balanceEur) - currentEur;
  if (Math.abs(deltaEur) < CASH_EPSILON) {
    const balances = cashBalancesBySource(movements);
    return setCashBalanceResponseSchema.parse({
      movement: null,
      deltaEur: 0,
      sourceBalanceEur: currentEur,
      balanceEur: floorCents([...balances.values()].reduce((sum, value) => sum + value, 0)),
    });
  }
  const result = await createCashMovement(
    context,
    portfolioId,
    {
      amountEur: Math.abs(deltaEur),
      sourceId,
      note: parsed.note,
    },
    deltaEur > 0 ? 'deposit' : 'withdrawal',
  );
  return setCashBalanceResponseSchema.parse({
    movement: result.movement,
    deltaEur,
    sourceBalanceEur: result.sourceBalanceEur,
    balanceEur: result.balanceEur,
  });
}

async function createStandingOrder(
  context: StoreContext,
  body: CreateStandingOrderRequest,
): Promise<StandingOrder> {
  const parsed = createStandingOrderRequestSchema.parse(body);
  const current = requireDocument(context.engine);
  requirePortfolio(current, parsed.portfolioId);
  const timestamp = context.now();
  const today = calendarDayInTimezone(new Date(timestamp), 'Europe/Vienna');
  const startDate = parsed.startDate ?? today;
  if (parsed.endDate !== undefined && parsed.endDate < startDate) {
    throw storeError('VAULT_DATA_INVALID', 'Standing-order end date precedes its start date.');
  }
  // A first-referenced market asset is snapshotted in the SAME mutation that
  // records the order, so a buy-asset order works for any asset the kept
  // search/detail surfaces can reach — held before or not.
  const marketSnapshots =
    parsed.kind === 'buy-asset'
      ? await marketSnapshotsForMissingAssets(context, current, [parsed.assetId!])
      : new Map<string, Record<string, unknown>>();
  const snapshotted = (document: VaultDocument) =>
    appendMarketSnapshots(document, marketSnapshots, context.engine.deviceId, context.now());
  // Fail fast on an asset that cannot be proven, before the mutation opens.
  // The resolver's own currency is deliberately NOT carried across: see below.
  if (parsed.kind === 'buy-asset') resolveTransactionAsset(snapshotted(current), parsed.assetId!);
  const entity = await appendEntity(
    context,
    'standingOrder',
    (document, id, createdAt) => {
      requirePortfolio(document, parsed.portfolioId);
      // Read the asset from the PREPARED document, never from the pre-mutation
      // resolver read: if a queued mutation or a reconciliation installed the
      // same asset snapshot while the catalog read was in flight,
      // `appendMarketSnapshots` correctly keeps that live winner — so the
      // winner, not the loser, has to decide this order's currency. A buy order
      // whose currency disagrees with its asset is refused by
      // `validatePersistedStandingOrder` on the next `openVaultSession`.
      const orderAsset =
        parsed.kind === 'buy-asset' ? resolveTransactionAsset(document, parsed.assetId!) : null;
      return entityRecord(
        id,
        context.engine.deviceId,
        createdAt,
        strictStandingOrderData({
          userId: portfolioOwnerUserId(document),
          portfolioId: parsed.portfolioId,
          kind: parsed.kind,
          assetId: parsed.assetId ?? null,
          amount: decimalStringFromNumber(parsed.amount),
          currency: orderAsset?.currency ?? 'EUR',
          label: parsed.label ?? null,
          cadence: parsed.cadence,
          anchorDay: parsed.anchorDay ?? null,
          startDate,
          endDate: parsed.endDate ?? null,
          status: 'active',
          lastRunAt: null,
          lastPeriodKey: null,
          createdAt,
          updatedAt: createdAt,
        }),
      );
    },
    snapshotted,
  );
  return standingOrderFromEntity(requireDocument(context.engine), entity, context.now());
}

async function createCustomAsset(
  context: StoreContext,
  body: CreateCustomAssetRequest,
): Promise<CreateCustomAssetResponse> {
  const parsed = createCustomAssetRequestSchema.parse(body);
  const current = requireDocument(context.engine);
  const ownerId = portfolioOwnerUserId(current);
  const entity = await appendEntity(context, 'customAsset', (_document, id, timestamp) =>
    entityRecord(
      id,
      context.engine.deviceId,
      timestamp,
      // The manual-asset identity the server writes for its own custom assets
      // (`customAssetRepository.create`) and re-checks on every rehydrated row
      // (`validateCustomAssetFacts`): the reference IS the asset id, never the
      // name. A row that disagrees would block the vault's only
      // non-destructive exit. The row shape is shared with the enable
      // migration (`assetSnapshot.ts`) so both producers agree by construction.
      strictCustomAssetData(
        ownedAssetSnapshotRow({
          id,
          ownerId,
          symbol: parsed.name,
          name: parsed.name,
          currency: parsed.currency,
          category: parsed.category,
          smoothing: parsed.smoothing,
        }),
      ),
    ),
  );
  let transactionId: string | null = null;
  if (parsed.initialPurchase != null) {
    const defaultPortfolio =
      portfolioSummariesFromDocument(requireDocument(context.engine)).find(
        (portfolio) => portfolio.isDefault,
      ) ?? portfolioSummariesFromDocument(requireDocument(context.engine))[0];
    if (defaultPortfolio == null) {
      throw storeError(
        'VAULT_OPERATION_UNAVAILABLE',
        'A portfolio is required for an initial purchase.',
      );
    }
    const [transaction] = await createVaultPortfolioStore(context.engine, {
      now: context.now,
      newId: context.newId,
    }).createTransactions(defaultPortfolio.id, [
      transactionInputSchema.parse({
        assetId: entity.id,
        side: 'buy',
        quantity: parsed.initialPurchase.quantity,
        price: parsed.initialPurchase.price,
        fee: parsed.initialPurchase.fee,
        executedAt: parsed.initialPurchase.executedAt,
        note: parsed.initialPurchase.note ?? null,
      }),
    ]);
    transactionId = transaction?.id ?? null;
  }
  return createCustomAssetResponseSchema.parse({
    asset: customAssetFromEntity(entity),
    transactionId,
  });
}

async function replaceCustomAssetValuePoints(
  context: StoreContext,
  assetId: string,
  points: ValuePoint[],
): Promise<void> {
  requireOwnedCustomAsset(requireDocument(context.engine), assetId);
  assertUniqueValuePointDates(points);
  await context.engine.mutate(({ document }) => {
    requireOwnedCustomAsset(document, assetId);
    const timestamp = context.now();
    let next = document;
    for (const existing of liveEntities(next, 'customAssetValue').filter(
      (entity) => stringField(entity.data, 'assetId') === assetId,
    )) {
      next = replaceEntity(
        next,
        'customAssetValue',
        tombstoneEntity(existing, context.engine.deviceId, timestamp),
      );
    }
    const entities = points.map((point) =>
      entityRecord(
        safeNewId(context),
        context.engine.deviceId,
        timestamp,
        strictCustomAssetValueData({
          assetId,
          date: point.date,
          close: decimalStringFromNumber(point.value),
        }),
      ),
    );
    return appendEntities(next, 'customAssetValue', entities);
  });
}

/**
 * One value point per day (§6.9), rejected loudly rather than silently
 * collapsed — the same rule `customAssetService.putValuePoints` enforces
 * (`DUPLICATE_VALUE_POINT`) and the reason it exists here: the server holds it
 * with a unique index, while this producer writes one entity per input row, so
 * two contract-valid points for the same day would be durably encrypted under
 * distinct ids and `validateRelationships` would refuse the whole vault as
 * `VAULT_CORRUPT` on the next unlock. It has to fail BEFORE the mutation, with
 * nothing written.
 */
function assertUniqueValuePointDates(points: readonly ValuePoint[]): void {
  const seen = new Set<string>();
  for (const point of points) {
    if (seen.has(point.date)) {
      throw storeError('VAULT_DATA_INVALID', `Duplicate value point for ${point.date}.`);
    }
    seen.add(point.date);
  }
}

async function updateStandingOrder(
  context: StoreContext,
  id: string,
  patch: UpdateStandingOrderRequest,
): Promise<StandingOrder> {
  const parsed = updateStandingOrderRequestSchema.parse(patch);
  const entity = await updateEntity(context, 'standingOrder', id, (data) => {
    const next = {
      ...data,
      ...definedFields({
        amount: parsed.amount === undefined ? undefined : decimalStringFromNumber(parsed.amount),
        label: parsed.label,
        endDate: parsed.endDate,
      }),
      updatedAt: context.now(),
    };
    const startDate = stringField(next, 'startDate');
    const endDate = nullableStringField(next, 'endDate');
    if (endDate !== null && endDate < startDate) {
      throw storeError('VAULT_DATA_INVALID', 'Standing-order end date precedes its start date.');
    }
    return strictStandingOrderData(next);
  });
  return standingOrderFromEntity(requireDocument(context.engine), entity, context.now());
}

async function setStandingOrderStatus(
  context: StoreContext,
  id: string,
  status: 'active' | 'paused',
): Promise<StandingOrder> {
  const entity = await updateEntity(context, 'standingOrder', id, (data) =>
    strictStandingOrderData({
      ...data,
      status,
      updatedAt: context.now(),
    }),
  );
  return standingOrderFromEntity(requireDocument(context.engine), entity, context.now());
}

async function deleteStandingOrder(context: StoreContext, id: string): Promise<void> {
  requireDocument(context.engine);
  await context.engine.mutate(({ document }) => {
    const order = findLiveEntity(document, 'standingOrder', id);
    if (order == null) {
      throw storeError('VAULT_ENTITY_NOT_FOUND', 'Standing order not found in the active vault.');
    }
    const timestamp = context.now();
    let next = replaceEntity(
      document,
      'standingOrder',
      tombstoneEntity(order, context.engine.deviceId, timestamp),
    );
    for (const run of liveEntities(next, 'standingOrderRun').filter(
      (entity) => stringField(entity.data, 'standingOrderId') === id,
    )) {
      next = replaceEntity(
        next,
        'standingOrderRun',
        tombstoneEntity(run, context.engine.deviceId, timestamp),
      );
    }
    return next;
  });
  if (findLiveEntity(requireDocument(context.engine), 'standingOrder', id) != null) {
    throw storeError(
      'VAULT_DATA_UNAVAILABLE',
      'Standing-order deletion was not committed locally.',
    );
  }
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
  assertStandingOrderCandidate(context.engine, current, undefined, input.expectedCandidate);
  assertStandingOrderDefinition(current, requireLiveStandingOrder(current, input.orderId), input);
  const alreadyCommitted = existingStandingOrderOccurrence(current, input);
  if (alreadyCommitted != null) return alreadyCommitted;

  let created = false;
  const mutationState = await context.engine.mutate(({ document, currentVersion }) => {
    signal?.throwIfAborted();
    assertStandingOrderCandidate(context.engine, document, currentVersion, input.expectedCandidate);
    const concurrent = existingStandingOrderOccurrence(document, input);
    if (concurrent != null) return document;

    const order = requireLiveStandingOrder(document, input.orderId);
    assertStandingOrderDefinition(document, order, input);
    assertStandingOrderDue(order, input);
    const timestamp = input.executedAt;
    const rowKind = standingOrderRowKind(order);
    let ledgerEntity: VaultEntity;
    let nextDocument: VaultDocument;

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
              price: decimalStringAtScale(price, TRANSACTION_PRICE_SCALE),
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
      const resolved = ensureCashSource(context, document, portfolioId, undefined, timestamp);
      const sourceId = resolved.sourceId;
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
          // V5 cash fusion: NULL on every engine-posted movement, exactly like
          // the server — no statement import to dedupe, amount is truly EUR.
          dedupHash: null,
          originalCurrency: null,
          createdAt: timestamp,
        }),
      );
      nextDocument = appendEntities(resolved.document, 'cashMovement', [ledgerEntity]);
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
    !Number.isFinite(Date.parse(input.executedAt)) ||
    !Number.isSafeInteger(input.expectedCandidate.vaultVersion) ||
    input.expectedCandidate.vaultVersion < 0 ||
    !uuid.test(input.expectedCandidate.vaultKeyId) ||
    !uuid.test(input.expectedCandidate.writeId)
  ) {
    throw storeError('VAULT_DATA_INVALID', 'The standing-order occurrence identity is invalid.');
  }
}

function assertStandingOrderCandidate(
  engine: VaultSyncEngine,
  document: VaultDocument,
  currentVersion: number | undefined,
  expected: VaultStandingOrderOccurrenceInput['expectedCandidate'],
): void {
  const active = engine.state.active;
  if (
    active === null ||
    active.document !== document ||
    (currentVersion !== undefined && currentVersion !== expected.vaultVersion) ||
    active.header.vaultVersion !== expected.vaultVersion ||
    active.header.keyId !== expected.vaultKeyId ||
    active.header.writeId !== expected.writeId
  ) {
    throw storeError(
      'VAULT_OPERATION_ABORTED',
      'The authenticated vault candidate changed before the standing order could be committed.',
    );
  }
}

function requireLiveStandingOrder(document: VaultDocument, orderId: string): VaultEntity {
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
  document: VaultDocument,
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
  document: VaultDocument,
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
    const lastPeriodKey = order == null ? null : nullableStringField(order.data, 'lastPeriodKey');
    if (order != null && lastPeriodKey != null && lastPeriodKey >= input.dueDate) {
      /*
       * Server semantics: a watermark at or past the due period means "already
       * satisfied — skip" (processDueOrders). A LATER watermark backed by its
       * own durable claim is a legal state (e.g. endDate shrunk below an
       * already-booked period) and must skip, never fail. Only a watermark
       * whose claimed period has no durable run row is corrupt.
       */
      const durableClaim = liveEntities(document, 'standingOrderRun').some(
        (candidate) =>
          stringField(candidate.data, 'standingOrderId') === input.orderId &&
          stringField(candidate.data, 'periodKey') === lastPeriodKey,
      );
      if (!durableClaim) {
        throw storeError(
          'VAULT_DATA_INVALID',
          'A standing order is marked booked without its deterministic occurrence rows.',
        );
      }
      return {
        occurrenceId: input.occurrenceId,
        orderId: input.orderId,
        dueDate: input.dueDate,
        rowKind: standingOrderRowKind(order),
        status: 'existing',
      };
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
  document: VaultDocument,
  kind: VaultEntityKind,
  entities: VaultEntity[],
): VaultDocument {
  return {
    ...document,
    entities: {
      ...document.entities,
      [kind]: [...(document.entities[kind] ?? []), ...entities],
    },
  };
}

function replaceEntity(
  document: VaultDocument,
  kind: VaultEntityKind,
  replacement: VaultEntity,
): VaultDocument {
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

function liveEntities(document: VaultDocument, kind: VaultEntityKind): VaultEntity[] {
  return (document.entities[kind] ?? []).filter((entity) => entity.deletedAt === null);
}

function liveCascadeDescendants(
  document: VaultDocument,
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
  document: VaultDocument,
  kind: VaultEntityKind,
  id: string,
): VaultEntity | undefined {
  return (document.entities[kind] ?? []).find((entity) => entity.id === id);
}

function findLiveEntity(
  document: VaultDocument,
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
): { document: VaultDocument; entity: VaultEntity } {
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
  compensation: boolean;
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
  document: VaultDocument,
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
    let rebasedAsCompensation = group.compensation;
    const completeGroupWon =
      !group.compensation &&
      group.changes.every(
        (change) =>
          !rejectedEntityKeys.has(entityRefKey(change.kind, change.id)) &&
          sameOptionalVaultEntity(findEntity(document, change.kind, change.id), change.local),
      );
    if (!completeGroupWon) {
      reconciled = compensateRejectedGroup(reconciled, group, context);
      rebasedAsCompensation = true;
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
        rebasedAsCompensation = true;
        for (const change of group.changes) {
          rejectedEntityKeys.add(entityRefKey(change.kind, change.id));
        }
      }
    }

    const rebased = rebaseReconcileGroup(group, beforeGroup, reconciled, rebasedAsCompensation);
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
        compensation: mutation.compensation === true,
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
  before: VaultDocument,
  after: VaultDocument,
  compensation: boolean,
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
    ? { sequence: group.sequence, changes, compensation }
    : null;
}

function compensateRejectedGroup(
  document: VaultDocument,
  group: ReconcileGroup,
  context: VaultDocumentReconcileContext,
): VaultDocument {
  let compensated = document;
  for (const change of group.changes) {
    const desired = findEntity(compensated, change.kind, change.id);
    if (sameOptionalVaultEntity(change.local, desired)) continue;
    compensated = setEntity(
      compensated,
      change.kind,
      change.id,
      compensationEntity(change.local, desired, context, group.compensation),
    );
  }
  compensated = enforceDeletionCascades(compensated, context);
  assertPortfolioDocumentInvariants(compensated, context.remote);
  return compensated;
}

function setEntity(
  document: VaultDocument,
  kind: VaultEntityKind,
  id: string,
  entity: VaultEntity | undefined,
): VaultDocument {
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
  document: VaultDocument,
  context: VaultDocumentReconcileContext,
): VaultDocument {
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
  refresh: boolean,
): VaultEntity | undefined {
  if (rejected == null) return desired;
  if (desired == null) {
    return refresh ? rejected : tombstoneEntity(rejected, context.deviceId, context.reconciledAt);
  }
  if (refresh) {
    if (desired.rev >= rejected.rev) return desired;
    return {
      ...desired,
      rev: rejected.rev,
      editedAt: rejected.editedAt,
      editedBy: rejected.editedBy,
      deletedAt: desired.deletedAt === null ? null : (rejected.deletedAt ?? context.reconciledAt),
    };
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
  document: VaultDocument,
  durableBaseline: VaultDocument,
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

function assertCascadeReferences(document: VaultDocument): void {
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

/** The server's cashSourceRepository.MAIN_CASH_SOURCE_NAME. */
const MAIN_CASH_SOURCE_NAME = 'Main';

/**
 * Resolve the target cash source like the server: an explicit id must exist
 * and be active, while the implicit Main source is provisioned on first touch
 * (cashSourceRepository.getOrCreateMain) — a vault captured before any cash
 * activity must book cash work, not fail it. Call inside a serialized
 * mutation; the returned document carries the provisioned source when one was
 * created.
 */
function ensureCashSource(
  context: StoreContext,
  document: VaultDocument,
  portfolioId: string,
  requestedSourceId: string | undefined,
  timestamp: string,
): { document: VaultDocument; sourceId: string } {
  if (requestedSourceId != null) {
    return { document, sourceId: resolveCashSourceId(document, portfolioId, requestedSourceId) };
  }
  const existing = liveEntities(document, 'cashSource')
    .filter(
      (entity) =>
        stringField(entity.data, 'portfolioId') === portfolioId &&
        nullableStringField(entity.data, 'archivedAt') === null &&
        booleanField(entity.data, 'isMain', false),
    )
    .sort((left, right) => left.id.localeCompare(right.id))[0];
  if (existing != null) return { document, sourceId: existing.id };
  requirePortfolio(document, portfolioId);
  const entity = entityRecord(
    safeNewId(context),
    context.engine.deviceId,
    timestamp,
    parseVaultData(
      () =>
        VAULT_ENTITY_ROW_SCHEMAS.cashSource.parse({
          portfolioId,
          name: MAIN_CASH_SOURCE_NAME,
          type: 'cash',
          isMain: true,
          archivedAt: null,
          createdAt: timestamp,
        }),
      'A provisioned Main cash source does not match the strict restore contract.',
    ),
  );
  return { document: appendEntities(document, 'cashSource', [entity]), sourceId: entity.id };
}

function resolveCashSourceId(
  document: VaultDocument,
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

function portfolioSummariesFromDocument(document: VaultDocument): PortfolioSummary[] {
  const portfolios = liveEntities(document, 'portfolio');
  const defaultId = defaultPortfolioId(portfolios);
  return portfolios.map((entity) => portfolioSummaryFromEntity(entity, entity.id === defaultId));
}

function portfolioSummaryForId(document: VaultDocument, portfolioId: string): PortfolioSummary {
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

/** The server's portfolioRepository.DEFAULT_PORTFOLIO_NAME. */
const DEFAULT_PORTFOLIO_NAME = 'Main';

/**
 * The account every vault row belongs to. A live portfolio is the normal
 * source; a TOMBSTONED one (or the tax setting, which carries the same id) is
 * read as a fallback so a momentarily portfolio-less document — the middle of
 * {@link discardAllData}'s wipe — still knows whose vault it is instead of
 * locking the account out of creating its next portfolio.
 */
function portfolioOwnerUserId(document: VaultDocument): string {
  const owner =
    liveEntities(document, 'portfolio')[0] ??
    (document.entities.portfolio ?? [])[0] ??
    (document.entities.taxSetting ?? [])[0];
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

function strictCashSourceData(data: Record<string, unknown>): Record<string, unknown> {
  return parseVaultData(
    () => VAULT_ENTITY_ROW_SCHEMAS.cashSource.parse(data),
    'A vault cash source does not match the strict restore contract.',
  );
}

function strictStandingOrderData(data: Record<string, unknown>): Record<string, unknown> {
  return parseVaultData(
    () => VAULT_ENTITY_ROW_SCHEMAS.standingOrder.parse(data),
    'A vault standing order does not match the strict restore contract.',
  );
}

function strictPortfolioSettingData(data: Record<string, unknown>): Record<string, unknown> {
  return parseVaultData(
    () => VAULT_ENTITY_ROW_SCHEMAS.portfolioSetting.parse(data),
    'A vault portfolio setting does not match the strict restore contract.',
  );
}

function strictTaxSettingData(data: Record<string, unknown>): Record<string, unknown> {
  return parseVaultData(
    () => VAULT_ENTITY_ROW_SCHEMAS.taxSetting.parse(data),
    'A vault tax setting does not match the strict restore contract.',
  );
}

function strictCustomAssetData(data: Record<string, unknown>): Record<string, unknown> {
  return parseVaultData(
    () => VAULT_ENTITY_ROW_SCHEMAS.customAsset.parse(data),
    'A vault custom asset does not match the strict restore contract.',
  );
}

function strictCustomAssetValueData(data: Record<string, unknown>): Record<string, unknown> {
  return parseVaultData(
    () => VAULT_ENTITY_ROW_SCHEMAS.customAssetValue.parse(data),
    'A vault custom-asset value does not match the strict restore contract.',
  );
}

function requireOwnedCustomAsset(document: VaultDocument, id: string): VaultEntity {
  const entity = findLiveEntity(document, 'customAsset', id);
  if (entity == null || nullableStringField(entity.data, 'ownerId') === null) {
    throw storeError('VAULT_ENTITY_NOT_FOUND', 'Custom asset not found in the active vault.');
  }
  return entity;
}

function customAssetFromEntity(entity: VaultEntity): CustomAsset {
  const meta = recordField(entity.data, 'meta') ?? {};
  return customAssetSchema.parse({
    id: entity.id,
    symbol: stringField(entity.data, 'symbol'),
    name: stringField(entity.data, 'name'),
    category: stringField(meta, 'category', 'other'),
    currency: stringField(entity.data, 'currency'),
    type: stringField(entity.data, 'type'),
    smoothing: booleanField(meta, 'smoothing', false),
    needsRecategorization: booleanField(meta, 'recategorize', false),
  });
}

function valuePointsFromDocument(document: VaultDocument, assetId: string): ValuePoint[] {
  return liveEntities(document, 'customAssetValue')
    .filter((entity) => stringField(entity.data, 'assetId') === assetId)
    .map((entity) => ({
      date: stringField(entity.data, 'date'),
      value: numberField(entity.data, 'close'),
    }));
}

function findPortfolioTaxSetting(document: VaultDocument, portfolioId: string): VaultEntity | null {
  return (
    liveEntities(document, 'portfolioSetting').find(
      (entity) =>
        stringField(entity.data, 'portfolioId') === portfolioId &&
        stringField(entity.data, 'key') === 'tax',
    ) ?? null
  );
}

function portfolioTaxSettingsFromDocument(
  document: VaultDocument,
  portfolioId: string,
): PortfolioTaxSettingsResponse {
  const portfolio = requirePortfolio(document, portfolioId);
  const overrideEntity = findPortfolioTaxSetting(document, portfolioId);
  const override =
    overrideEntity == null
      ? null
      : taxSettingsResponseFromData(recordField(overrideEntity.data, 'value'));
  const userId = nullableStringField(portfolio.data, 'userId');
  const userEntity = latestUserTaxSetting(document, userId);
  const userDefault = userTaxSettingsFromDocument(document, userId);
  return portfolioTaxSettingsResponseSchema.parse({
    effective: override ?? userDefault,
    override,
    userDefault,
    source: override != null ? 'portfolio' : userEntity == null ? 'system' : 'user',
  });
}

function latestUserTaxSetting(
  document: VaultDocument,
  userId: string | null = null,
): VaultEntity | null {
  return (
    liveEntities(document, 'taxSetting')
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
      .at(-1) ?? null
  );
}

function userTaxSettingsFromDocument(
  document: VaultDocument,
  userId: string | null = null,
): TaxSettingsResponse {
  const entity = latestUserTaxSetting(document, userId);
  return entity == null
    ? taxSettingsResponseSchema.parse({ mode: 'none', country: null })
    : taxSettingsResponseFromData(entity.data);
}

function taxSettingsResponseFromData(data: Record<string, unknown> | null): TaxSettingsResponse {
  if (data == null) {
    throw storeError('VAULT_DATA_INVALID', 'A vault tax setting is malformed.');
  }
  const mode = taxModeField(data);
  if (mode == null) {
    throw storeError('VAULT_DATA_INVALID', 'A vault tax setting has no mode.');
  }
  const custom = recordField(data, 'custom') ?? recordField(data, 'customParams');
  const manualDefaultAmountEur = nullableNumberField(data, 'manualDefaultAmountEur');
  const manualDefaultRatePct = nullableNumberField(data, 'manualDefaultRatePct');
  return taxSettingsResponseSchema.parse({
    mode,
    country: nullableStringField(data, 'country'),
    ...(mode === 'custom' && custom != null ? { custom } : {}),
    ...(mode === 'manual_per_trade' && manualDefaultAmountEur != null
      ? { manualDefaultAmountEur }
      : {}),
    ...(mode === 'manual_per_trade' && manualDefaultRatePct != null
      ? { manualDefaultRatePct }
      : {}),
  });
}

function taxSettingsValue(body: UpdateTaxSettingsRequest): TaxSettingsResponse {
  return taxSettingsResponseSchema.parse({
    mode: body.mode,
    country: body.country ?? null,
    ...(body.custom === undefined ? {} : { custom: body.custom }),
    ...(body.manualDefaultAmountEur === undefined
      ? {}
      : { manualDefaultAmountEur: body.manualDefaultAmountEur }),
    ...(body.manualDefaultRatePct === undefined
      ? {}
      : { manualDefaultRatePct: body.manualDefaultRatePct }),
  });
}

function resolveTransactionAsset(document: VaultDocument, assetId: string): PortfolioAsset {
  const asset = findLiveEntity(document, 'customAsset', assetId);
  if (asset == null) {
    throw storeError(
      'VAULT_OPERATION_UNAVAILABLE',
      'A local asset snapshot is required before a vault transaction can be created.',
    );
  }
  return portfolioAssetFromEntity(asset);
}

/**
 * The LOCAL ASSET TABLE's write path for first references: any asset the §8
 * kept search/detail surfaces can reach must be recordable against, including
 * one the account has never held. For each referenced id the document has no
 * live snapshot of, resolve the catalog asset and produce its client-only
 * market snapshot row (`assetSnapshot.ts` — identity rules shared with the
 * enable migration by construction). A custom asset that is not already in the
 * vault has ownership facts this client cannot prove — snapshotting it would
 * poison the restore boundary — so that stays genuinely unavailable.
 */
async function marketSnapshotsForMissingAssets(
  context: StoreContext,
  document: VaultDocument,
  assetIds: readonly string[],
): Promise<Map<string, Record<string, unknown>>> {
  const rows = new Map<string, Record<string, unknown>>();
  for (const assetId of new Set(assetIds)) {
    if (findLiveEntity(document, 'customAsset', assetId) !== undefined) continue;
    let summary: AssetSummary | null;
    try {
      summary = await context.resolveMarketAsset(assetId);
    } catch (cause) {
      throw storeError(
        'VAULT_OPERATION_UNAVAILABLE',
        'The referenced asset could not be snapshotted into the vault.',
        cause,
      );
    }
    if (summary == null || summary.isCustom) {
      throw storeError(
        'VAULT_OPERATION_UNAVAILABLE',
        'The referenced asset has no local snapshot the vault can prove.',
      );
    }
    rows.set(assetId, strictCustomAssetData(marketAssetSnapshotRow(summary)));
  }
  return rows;
}

/**
 * Apply resolved market snapshots to one document state. Runs inside `mutate`
 * callbacks too, so it re-checks per document: a live row means another write
 * won the race; a tombstoned row (a `discardAllData` wipe, then the same asset
 * bought again) is revived in place — appending a second entity with the same
 * id would corrupt the vault against `validateStrictEntities`.
 */
function appendMarketSnapshots(
  document: VaultDocument,
  rows: ReadonlyMap<string, Record<string, unknown>>,
  deviceId: string,
  timestamp: string,
): VaultDocument {
  let next = document;
  for (const [assetId, data] of rows) {
    const existing = findEntity(next, 'customAsset', assetId);
    if (existing?.deletedAt === null) continue;
    next =
      existing === undefined
        ? appendEntities(next, 'customAsset', [entityRecord(assetId, deviceId, timestamp, data)])
        : replaceEntity(next, 'customAsset', {
            ...existing,
            rev: existing.rev + 1,
            editedAt: timestamp,
            editedBy: deviceId,
            deletedAt: null,
            data,
          });
  }
  return next;
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

function transactionFromEntity(document: VaultDocument, entity: VaultEntity): Transaction {
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
  document: VaultDocument,
  candidates: readonly TransactionCreateCandidate[],
  deviceId: string,
  timestamp: string,
): { document: VaultDocument; entities: VaultEntity[] } {
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

/**
 * Quantize to the server column's numeric scale with PostgreSQL's
 * round-half-away-from-zero, then trim trailing fraction zeros. Quote-derived
 * float prices carry binary noise (175.33999633789062) the server's
 * numeric(20,6) can never store; persisting them raw breaks #894 parity.
 */
function decimalStringAtScale(value: number, scale: number): string {
  const source = decimalStringFromNumber(value);
  const negative = source.startsWith('-');
  const unsigned = negative ? source.slice(1) : source;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  if (fraction.length <= scale) return source;
  const kept = fraction.slice(0, scale);
  let digits = BigInt(`${whole}${kept}`);
  if (fraction.charCodeAt(scale) >= 0x35) digits += 1n;
  const padded = digits.toString().padStart(scale + 1, '0');
  const integer = padded.slice(0, padded.length - scale);
  const rounded = padded.slice(padded.length - scale).replace(/0+$/, '');
  const magnitude = rounded.length === 0 ? integer : `${integer}.${rounded}`;
  return negative && !/^0(?:\.0*)?$/.test(magnitude) ? `-${magnitude}` : magnitude;
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

/**
 * The single boundary where a raw ledger roll-up becomes a cash-source DTO, so
 * the cent quantization happens here once — exactly like the server, which
 * floors every balance in `loadCashState` before `sourceToDto` ever sees it
 * (§5.4: the domain replay stays unrounded, the service boundary floors).
 * Every read path (`listCashSources`, `getCashMovements`, the source returned
 * by a create/update/archive/restore) goes through this function, so none of
 * them can hand a surface a sub-cent balance the write paths would never store.
 */
function cashSourceFromEntity(
  entity: VaultEntity,
  balanceEur: number,
): CashSourceListResponse['sources'][number] {
  return parseVaultData(
    () =>
      cashSourceSchema.parse({
        id: entity.id,
        name: stringField(entity.data, 'name'),
        type: stringField(entity.data, 'type'),
        isMain: booleanField(entity.data, 'isMain', false),
        archivedAt: nullableStringField(entity.data, 'archivedAt'),
        createdAt: stringField(entity.data, 'createdAt', entity.editedAt),
        balanceEur: floorCents(balanceEur),
      }),
    'A vault cash source does not match the cash-source contract.',
  );
}

function currentCashSource(document: VaultDocument, entity: VaultEntity): CashSource {
  const portfolioId = stringField(entity.data, 'portfolioId');
  const balances = cashBalancesBySource(domainCashMovements(document, portfolioId));
  return cashSourceFromEntity(entity, balances.get(entity.id) ?? 0);
}

function requireActiveCashSource(
  document: VaultDocument,
  portfolioId: string,
  sourceId: string,
): VaultEntity {
  requirePortfolio(document, portfolioId);
  const source = requireOwnedEntity(document, 'cashSource', sourceId, portfolioId);
  if (nullableStringField(source.data, 'archivedAt') !== null) {
    throw storeError(
      'VAULT_OPERATION_UNAVAILABLE',
      'Archived cash sources cannot receive entries.',
    );
  }
  return source;
}

function assertUniqueCashSourceName(
  document: VaultDocument,
  portfolioId: string,
  name: string,
  excludedId?: string,
): void {
  const normalized = name.trim().toLocaleLowerCase();
  const duplicate = liveEntities(document, 'cashSource').some(
    (entity) =>
      entity.id !== excludedId &&
      stringField(entity.data, 'portfolioId') === portfolioId &&
      stringField(entity.data, 'name').trim().toLocaleLowerCase() === normalized,
  );
  if (duplicate) {
    throw storeError('VAULT_OPERATION_UNAVAILABLE', 'A cash source with that name already exists.');
  }
}

function standingOrderFromEntity(
  document: VaultDocument,
  entity: VaultEntity,
  now: string,
): StandingOrder {
  const portfolioId = stringField(entity.data, 'portfolioId');
  const portfolio = VAULT_ENTITY_ROW_SCHEMAS.portfolio.parse(
    requirePortfolio(document, portfolioId).data,
  );
  const suspendedByArchive = portfolio.archivedAt !== null;
  const kind = stringField(entity.data, 'kind');
  const assetId = nullableStringField(entity.data, 'assetId');
  const asset =
    kind === 'buy-asset' && assetId !== null ? resolveTransactionAsset(document, assetId) : null;
  const cadence = stringField(entity.data, 'cadence');
  const anchorDay = nullableNumberField(entity.data, 'anchorDay');
  const startDate = stringField(entity.data, 'startDate');
  const endDate = nullableStringField(entity.data, 'endDate');
  const status = stringField(entity.data, 'status');
  const lastPeriodKey = nullableStringField(entity.data, 'lastPeriodKey');
  const today = calendarDayInTimezone(new Date(now), 'Europe/Vienna');
  return parseVaultData(
    () =>
      standingOrderSchema.parse({
        id: entity.id,
        portfolioId,
        kind,
        assetId,
        assetSymbol: asset?.symbol ?? null,
        assetName: asset?.name ?? null,
        amount: numberField(entity.data, 'amount'),
        currency: stringField(entity.data, 'currency'),
        label: nullableStringField(entity.data, 'label'),
        cadence,
        anchorDay,
        startDate,
        endDate,
        status,
        suspendedByArchive,
        lastRunAt: nullableStringField(entity.data, 'lastRunAt'),
        lastPeriodKey,
        nextRunDate: nextStandingOrderRunDate(
          {
            cadence: cadence === 'daily' ? 'daily' : 'monthly',
            anchorDay,
            startDate,
            endDate,
          },
          today,
          lastPeriodKey,
          status === 'active' && !suspendedByArchive,
        ),
        createdAt: stringField(entity.data, 'createdAt', entity.editedAt),
        updatedAt: stringField(entity.data, 'updatedAt', entity.editedAt),
      }),
    'A vault standing order does not match the management contract.',
  );
}

function compareCashSources(
  left: CashSourceListResponse['sources'][number],
  right: CashSourceListResponse['sources'][number],
): number {
  return (
    Number(right.isMain) - Number(left.isMain) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function domainCashMovements(document: VaultDocument, portfolioId: string): SourcedCashMovement[] {
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
  document: VaultDocument,
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
  document: VaultDocument,
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
  left: VaultDocument,
  right: VaultDocument,
  portfolioId: string,
  assetId: string,
): boolean {
  const timeline = (document: VaultDocument) =>
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
  document: VaultDocument,
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
  document: VaultDocument,
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
  document: VaultDocument,
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
  document: VaultDocument,
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
  return nullableTaxMode(data?.mode);
}

function nullableTaxMode(mode: unknown): VaultTaxMode | null {
  if (mode == null) return null;
  if (
    mode === 'none' ||
    mode === 'manual_per_trade' ||
    mode === 'country_specific' ||
    mode === 'custom'
  ) {
    return mode;
  }
  throw new VaultCryptoError('update-required', 'This vault was written by a newer app version.');
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
  return nullableTaxMode(entity.data.taxMode);
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
