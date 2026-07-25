import type {
  CashEntryRequest,
  CashMovementResponse,
  PortfolioListResponse,
  PortfolioSummary,
  Transaction,
  TransactionListResponse,
  VaultDocumentV1,
  VaultEntity,
} from '@bettertrack/contracts';

import type { PortfolioStore } from '../../lib/portfolioStore';

import { VaultCryptoError } from './errors';
import type { VaultSyncEngine } from './sync';

/**
 * PD5's paranoid PortfolioStore implementation exposes raw vault entities only.
 * Financial projection/validation (holdings, valuation, tax, cash balances) is
 * intentionally PD7 work; this store never manufactures figures or falls back
 * to normal-account endpoints while the vault is locked or corrupt.
 */
export function createVaultPortfolioStore(engine: VaultSyncEngine): PortfolioStore {
  return {
    async listPortfolios() {
      return {
        portfolios: liveEntities(requireDocument(engine), 'portfolio').map(
          portfolioSummaryFromEntity,
        ),
      } satisfies PortfolioListResponse;
    },

    async createPortfolio(name) {
      const entity = await appendEntity(engine, 'portfolio', (id, deviceId, timestamp) => ({
        id,
        rev: 0,
        editedAt: timestamp,
        editedBy: deviceId,
        deletedAt: null,
        data: {
          name,
          visibility: 'private',
          sortOrder: liveEntities(requireDocument(engine), 'portfolio').length,
          isDefault: liveEntities(requireDocument(engine), 'portfolio').length === 0,
          defaultPayFromCash: false,
          archivedAt: null,
        },
      }));
      return portfolioSummaryFromEntity(entity);
    },

    async getPortfolio(portfolioId) {
      requirePortfolio(engine, portfolioId);
      throw unavailable(
        'Client portfolio valuation is unavailable until the vault valuation engine is active.',
      );
    },

    async updatePortfolio(portfolioId, patch) {
      const entity = await updateEntity(engine, 'portfolio', portfolioId, (data) => ({
        ...data,
        ...patch,
      }));
      return portfolioSummaryFromEntity(entity);
    },

    async deletePortfolio(portfolioId) {
      await deleteEntity(engine, 'portfolio', portfolioId);
    },

    async listTransactions(portfolioId, params = {}) {
      requirePortfolio(engine, portfolioId);
      const all = liveEntities(requireDocument(engine), 'transaction')
        .filter((entity) => stringField(entity.data, 'portfolioId') === portfolioId)
        .filter(
          (entity) =>
            params.source == null || stringField(entity.data, 'source', 'manual') === params.source,
        )
        .sort((left, right) => right.editedAt.localeCompare(left.editedAt));
      const limit = params.limit ?? 50;
      const start =
        params.cursor == null
          ? 0
          : Math.max(0, all.findIndex((entity) => entity.id === params.cursor) + 1);
      const items = all.slice(start, start + limit).map(transactionFromEntity);
      return {
        items,
        nextCursor: all[start + limit]?.id ?? null,
      } satisfies TransactionListResponse;
    },

    async createTransactions(portfolioId, inputs) {
      requirePortfolio(engine, portfolioId);
      const created: VaultEntity[] = [];
      await engine.mutate(({ document }) => {
        const timestamp = now();
        const deviceId = requireDeviceId(engine);
        const entities = inputs.map((input) => {
          const entity: VaultEntity = {
            id: newId(),
            rev: 0,
            editedAt: timestamp,
            editedBy: deviceId,
            deletedAt: null,
            data: { ...input, portfolioId, source: 'manual' },
          };
          created.push(entity);
          return entity;
        });
        return {
          ...document,
          entities: {
            ...document.entities,
            transaction: [...(document.entities.transaction ?? []), ...entities],
          },
        };
      });
      return created.map(transactionFromEntity);
    },

    async updateTransaction(portfolioId, transactionId, patch) {
      requirePortfolio(engine, portfolioId);
      const entity = findLiveEntity(requireDocument(engine), 'transaction', transactionId);
      if (entity == null || stringField(entity.data, 'portfolioId') !== portfolioId) {
        throw unavailable('Transaction not found in the unlocked vault.');
      }
      return transactionFromEntity(
        await updateEntity(engine, 'transaction', transactionId, (data) => ({ ...data, ...patch })),
      );
    },

    async deleteTransaction(portfolioId, transactionId) {
      requirePortfolio(engine, portfolioId);
      const entity = findLiveEntity(requireDocument(engine), 'transaction', transactionId);
      if (entity == null || stringField(entity.data, 'portfolioId') !== portfolioId) {
        throw unavailable('Transaction not found in the unlocked vault.');
      }
      await deleteEntity(engine, 'transaction', transactionId);
    },

    async depositCash(portfolioId, body) {
      return createCashMovement(engine, portfolioId, body, 'deposit');
    },

    async withdrawCash(portfolioId, body) {
      return createCashMovement(engine, portfolioId, body, 'withdrawal');
    },
  };
}

/** Public named implementation matching the architecture note nomenclature. */
export const vaultPortfolioStore = createVaultPortfolioStore;

function requireDocument(engine: VaultSyncEngine): VaultDocumentV1 {
  const state = engine.state;
  if (state.active == null || state.status === 'corrupt' || state.status === 'locked') {
    throw unavailable('Vault portfolio data is unavailable while the vault is locked or corrupt.');
  }
  return state.active.document;
}

function requireDeviceId(engine: VaultSyncEngine): string {
  const state = engine.state;
  if (state.active == null) throw unavailable('Vault is locked.');
  return state.active.header.deviceId;
}

function requirePortfolio(engine: VaultSyncEngine, portfolioId: string): void {
  if (findLiveEntity(requireDocument(engine), 'portfolio', portfolioId) == null) {
    throw unavailable('Portfolio not found in the unlocked vault.');
  }
}

async function appendEntity(
  engine: VaultSyncEngine,
  kind: keyof VaultDocumentV1['entities'],
  build: (id: string, deviceId: string, timestamp: string) => VaultEntity,
): Promise<VaultEntity> {
  let created: VaultEntity | null = null;
  await engine.mutate(({ document }) => {
    created = build(newId(), requireDeviceId(engine), now());
    return {
      ...document,
      entities: { ...document.entities, [kind]: [...(document.entities[kind] ?? []), created] },
    };
  });
  if (created == null) throw unavailable('Vault mutation did not produce an entity.');
  return created;
}

async function updateEntity(
  engine: VaultSyncEngine,
  kind: keyof VaultDocumentV1['entities'],
  id: string,
  mutateData: (data: Record<string, unknown>) => Record<string, unknown>,
): Promise<VaultEntity> {
  let updated: VaultEntity | null = null;
  await engine.mutate(({ document }) => {
    const entities = document.entities[kind] ?? [];
    const existing = entities.find((entity) => entity.id === id && entity.deletedAt === null);
    if (existing == null) throw unavailable('Vault entity does not exist.');
    updated = {
      ...existing,
      rev: existing.rev + 1,
      editedAt: now(),
      editedBy: requireDeviceId(engine),
      data: mutateData(existing.data),
    };
    return {
      ...document,
      entities: {
        ...document.entities,
        [kind]: entities.map((entity) => (entity.id === id ? updated! : entity)),
      },
    };
  });
  if (updated == null) throw unavailable('Vault mutation did not update an entity.');
  return updated;
}

async function deleteEntity(
  engine: VaultSyncEngine,
  kind: keyof VaultDocumentV1['entities'],
  id: string,
): Promise<void> {
  await engine.mutate(({ document }) => {
    const entities = document.entities[kind] ?? [];
    const existing = entities.find((entity) => entity.id === id && entity.deletedAt === null);
    if (existing == null) throw unavailable('Vault entity does not exist.');
    const timestamp = now();
    return {
      ...document,
      entities: {
        ...document.entities,
        [kind]: entities.map((entity) =>
          entity.id === id
            ? {
                ...existing,
                rev: existing.rev + 1,
                editedAt: timestamp,
                editedBy: requireDeviceId(engine),
                deletedAt: timestamp,
              }
            : entity,
        ),
      },
    };
  });
}

async function createCashMovement(
  engine: VaultSyncEngine,
  portfolioId: string,
  body: CashEntryRequest,
  kind: 'deposit' | 'withdrawal',
): Promise<CashMovementResponse> {
  requirePortfolio(engine, portfolioId);
  const movement = await appendEntity(engine, 'cashMovement', (id, deviceId, timestamp) => ({
    id,
    rev: 0,
    editedAt: timestamp,
    editedBy: deviceId,
    deletedAt: null,
    data: {
      ...body,
      portfolioId,
      kind,
      source: 'manual',
      sourceId: body.sourceId ?? id,
      executedAt: body.executedAt ?? timestamp,
      createdAt: timestamp,
      transactionId: null,
      transferId: null,
      counterpartSourceId: null,
      dividendId: null,
      taxYear: null,
    },
  }));
  // Cash balances require the PD7 valuation/cash-ledger projection. The write
  // itself is synchronous local vault data; surface neutral projections instead
  // of dispatching to server endpoints.
  return { movement: cashMovementFromEntity(movement), sourceBalanceEur: 0, balanceEur: 0 };
}

function liveEntities(
  document: VaultDocumentV1,
  kind: keyof VaultDocumentV1['entities'],
): VaultEntity[] {
  return (document.entities[kind] ?? []).filter((entity) => entity.deletedAt === null);
}

function findLiveEntity(
  document: VaultDocumentV1,
  kind: keyof VaultDocumentV1['entities'],
  id: string,
): VaultEntity | undefined {
  return liveEntities(document, kind).find((entity) => entity.id === id);
}

function portfolioSummaryFromEntity(entity: VaultEntity): PortfolioSummary {
  return {
    id: entity.id,
    name: stringField(entity.data, 'name'),
    visibility: stringField(entity.data, 'visibility', 'private') as PortfolioSummary['visibility'],
    sortOrder: numberField(entity.data, 'sortOrder', 0),
    isDefault: booleanField(entity.data, 'isDefault', false),
    defaultPayFromCash: booleanField(entity.data, 'defaultPayFromCash', false),
    archivedAt: nullableStringField(entity.data, 'archivedAt'),
  };
}

function transactionFromEntity(entity: VaultEntity): Transaction {
  return {
    id: entity.id,
    assetId: stringField(entity.data, 'assetId'),
    side: stringField(entity.data, 'side') as Transaction['side'],
    quantity: numberField(entity.data, 'quantity'),
    price: numberField(entity.data, 'price'),
    fee: numberField(entity.data, 'fee', 0),
    executedAt: stringField(entity.data, 'executedAt'),
    note: nullableStringField(entity.data, 'note'),
    allowUncovered: booleanField(entity.data, 'allowUncovered', false),
    uncoveredEntryPrice: nullableNumberField(entity.data, 'uncoveredEntryPrice'),
    source: stringField(entity.data, 'source', 'manual') as Transaction['source'],
    asset: entity.data.asset as Transaction['asset'],
  };
}

function cashMovementFromEntity(entity: VaultEntity): CashMovementResponse['movement'] {
  return {
    id: entity.id,
    kind: stringField(entity.data, 'kind') as CashMovementResponse['movement']['kind'],
    amountEur: numberField(entity.data, 'amountEur'),
    sourceId: stringField(entity.data, 'sourceId', entity.id),
    transactionId: nullableStringField(entity.data, 'transactionId'),
    transferId: nullableStringField(entity.data, 'transferId'),
    counterpartSourceId: nullableStringField(entity.data, 'counterpartSourceId'),
    dividendId: nullableStringField(entity.data, 'dividendId'),
    taxYear: nullableNumberField(entity.data, 'taxYear'),
    executedAt: stringField(entity.data, 'executedAt', entity.editedAt),
    note: nullableStringField(entity.data, 'note'),
    source: stringField(
      entity.data,
      'source',
      'manual',
    ) as CashMovementResponse['movement']['source'],
    createdAt: stringField(entity.data, 'createdAt', entity.editedAt),
  };
}

function stringField(data: Record<string, unknown>, field: string, fallback?: string): string {
  const value = data[field];
  if (typeof value === 'string') return value;
  if (fallback !== undefined) return fallback;
  throw unavailable(`Vault entity field ${field} is missing.`);
}

function nullableStringField(data: Record<string, unknown>, field: string): string | null {
  const value = data[field];
  return typeof value === 'string' ? value : null;
}

function numberField(data: Record<string, unknown>, field: string, fallback?: number): number {
  const value = data[field];
  if (typeof value === 'number') return value;
  if (fallback !== undefined) return fallback;
  throw unavailable(`Vault entity field ${field} is missing.`);
}

function nullableNumberField(data: Record<string, unknown>, field: string): number | null {
  const value = data[field];
  return typeof value === 'number' ? value : null;
}

function booleanField(data: Record<string, unknown>, field: string, fallback: boolean): boolean {
  return typeof data[field] === 'boolean' ? (data[field] as boolean) : fallback;
}

function now(): string {
  return new Date().toISOString();
}

function newId(): string {
  if (globalThis.crypto?.randomUUID == null) throw unavailable('crypto.randomUUID is unavailable.');
  return globalThis.crypto.randomUUID();
}

function unavailable(message: string): VaultCryptoError {
  return new VaultCryptoError('locked', message);
}
