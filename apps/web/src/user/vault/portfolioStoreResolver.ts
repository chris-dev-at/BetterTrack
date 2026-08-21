import {
  VAULT_ENTITY_ROW_SCHEMAS,
  portfolioSummarySchema,
  type PortfolioSummary,
  type VaultConfig,
} from '@bettertrack/contracts';

import type { MarketDataSource } from '../../lib/marketDataSource';
import { apiPortfolioStore, type PortfolioStore } from '../../lib/portfolioStore';
import {
  createClientCleartextExport,
  type ClientCleartextExport,
  type ClientCleartextExportOptions,
} from './export';
import { asMoneyFailure, moneyFailure, type VaultMoneyOutcome } from './engine/errors';
import {
  createPortfolioDocumentSetEngine,
  createVaultDocumentSetSession,
  loadDecryptedVaultDocumentSet,
  type DecryptedPortfolioDocumentSet,
  type DecryptedVaultDocumentSet,
  type PortfolioDocumentSetEngine,
  type VaultContentKeyBorrower,
  type VaultDocEnvelopeReader,
} from './engine/portfolioDocumentSet';
import type { ClientPortfolioDerivation, ClientTaxReport } from './engine/types';
import type { EndpointVaultState, FetchVaultHeaderEnvelope, OpenedVault } from './keystore';

export const PORTFOLIO_STORE_RESOLUTION_ERROR_CODES = [
  'VAULT_CONFIG_MISSING',
  'VAULT_DOCUMENT_INVALID',
  'VAULT_ROSTER_REQUIRED',
] as const;

export type PortfolioStoreResolutionErrorCode =
  (typeof PORTFOLIO_STORE_RESOLUTION_ERROR_CODES)[number];

export class PortfolioStoreResolutionError extends Error {
  constructor(
    readonly code: PortfolioStoreResolutionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PortfolioStoreResolutionError';
  }
}

export interface PortfolioVaultKeystore extends VaultContentKeyBorrower {
  stateFor(vaultId: string): Promise<EndpointVaultState>;
  openStoredVault(
    vaultId: string,
    fetchHeaderEnvelope: FetchVaultHeaderEnvelope,
    expectedFingerprint?: VaultConfig['keyFingerprint'],
  ): Promise<OpenedVault>;
}

export interface PortfolioStoreResolverDependencies {
  /** Authenticated account identity bound into every split-document AEAD address. */
  accountId: string;
  keys: PortfolioVaultKeystore;
  reader: VaultDocEnvelopeReader;
  market: MarketDataSource;
  plainStore?: PortfolioStore;
  /**
   * Synchronous CAS/sync-owner check for the exact loaded envelope set. The
   * resolver invokes it before and after every result-producing operation.
   */
  isDocumentSetCurrent(set: DecryptedPortfolioDocumentSet | DecryptedVaultDocumentSet): boolean;
  /** Focused injection seams; production always uses the authenticated E3/E6 path. */
  loadVaultDocumentSet?: typeof loadDecryptedVaultDocumentSet;
  createEngine?: typeof createPortfolioDocumentSetEngine;
  createVaultExportSession?: typeof createVaultDocumentSetSession;
  createCleartextExport?: typeof createClientCleartextExport;
}

export interface PortfolioStoreResolutionOptions {
  signal?: AbortSignal;
  /**
   * Complete server-stub roster for this vault. Required before any unlocked
   * read can prove that an encrypted header did not silently omit members.
   */
  expectedVaultPortfolioIds?: readonly string[];
}

export interface PlainPortfolioStoreResolution {
  kind: 'plain';
  portfolio: PortfolioSummary;
  /** Identity is deliberate: plain rows stay on the existing server store. */
  store: PortfolioStore;
}

export interface LockedVaultPortfolioStoreResolution {
  kind: 'vaulted-locked';
  /** The content-free server stub is the only portfolio fact exposed here. */
  portfolio: PortfolioSummary;
  vault: VaultConfig;
  requiredAction: EndpointVaultState['requiredAction'];
}

export interface UnlockedVaultPortfolioStoreResolution {
  kind: 'vaulted-unlocked';
  /** True encrypted portfolio fields overlaid with the server routing identity. */
  portfolio: PortfolioSummary;
  vault: VaultConfig;
  engine: PortfolioDocumentSetEngine;
  exportCleartext(
    options?: ClientCleartextExportOptions,
  ): Promise<VaultMoneyOutcome<ClientCleartextExport>>;
  /** Drops engine caches and decrypted snapshot references. */
  dispose(): void;
}

export type PortfolioStoreResolution =
  | PlainPortfolioStoreResolution
  | LockedVaultPortfolioStoreResolution
  | UnlockedVaultPortfolioStoreResolution;

/**
 * Resolve the data home at the portfolio seam, never at account level. A
 * locked vault returns before any document read; an unlocked vault opens and
 * authenticates its header/common/portfolio set through E3.
 */
export async function resolvePortfolioStore(
  stub: PortfolioSummary,
  vaults: readonly VaultConfig[],
  dependencies: PortfolioStoreResolverDependencies,
  options: PortfolioStoreResolutionOptions = {},
): Promise<PortfolioStoreResolution> {
  return resolvePortfolioStoreWithCoordination(
    stub,
    vaults,
    dependencies,
    options,
    createResolutionCoordination(),
  );
}

interface PortfolioStoreResolutionCoordination {
  endpointStates: Map<string, Promise<EndpointVaultState>>;
  openedVaults: Map<string, Promise<OpenedVault>>;
  documentSets: Map<string, Promise<DecryptedVaultDocumentSet>>;
}

async function resolvePortfolioStoreWithCoordination(
  stub: PortfolioSummary,
  vaults: readonly VaultConfig[],
  dependencies: PortfolioStoreResolverDependencies,
  options: PortfolioStoreResolutionOptions,
  coordination: PortfolioStoreResolutionCoordination,
): Promise<PortfolioStoreResolution> {
  const signal = options.signal;
  signal?.throwIfAborted();
  if (stub.vaultId == null) {
    return { kind: 'plain', portfolio: stub, store: dependencies.plainStore ?? apiPortfolioStore };
  }

  const matchedVault = vaults.find((candidate) => candidate.id === stub.vaultId);
  if (matchedVault === undefined) {
    throw new PortfolioStoreResolutionError(
      'VAULT_CONFIG_MISSING',
      `Portfolio ${stub.id} names an unavailable vault configuration.`,
    );
  }
  const vault: VaultConfig = matchedVault;

  const endpointState = await coordinatedStateFor(vault.id, dependencies, coordination);
  signal?.throwIfAborted();
  if (!endpointStateCanOpenSilently(endpointState)) {
    return {
      kind: 'vaulted-locked',
      portfolio: stub,
      vault,
      requiredAction: endpointState.requiredAction,
    };
  }

  if (options.expectedVaultPortfolioIds === undefined) {
    throw new PortfolioStoreResolutionError(
      'VAULT_ROSTER_REQUIRED',
      'A complete server-stub roster is required before an unlocked vault can be resolved.',
    );
  }
  const opened = await coordinatedOpen(vault, dependencies, coordination, signal);
  signal?.throwIfAborted();
  let activeVaultSet: DecryptedVaultDocumentSet | null = await coordinatedDocumentSet(
    vault,
    options.expectedVaultPortfolioIds,
    dependencies,
    coordination,
    signal,
  );
  signal?.throwIfAborted();
  const createEngine = dependencies.createEngine ?? createPortfolioDocumentSetEngine;
  const prepared: {
    value: { portfolio: PortfolioSummary; engine: PortfolioDocumentSetEngine } | null;
  } = { value: null };
  try {
    await dependencies.keys.withContentKey(
      vault.id,
      async (_borrowedContentKey, keyId, assertSessionCurrent) => {
        assertSessionCurrent();
        const currentSet = activeVaultSet;
        if (
          currentSet === null ||
          opened.keyId !== keyId ||
          keyId !== currentSet.header.envelope.keyId
        ) {
          throw new PortfolioStoreResolutionError(
            'VAULT_DOCUMENT_INVALID',
            'The opened vault key does not match the authenticated vault document set.',
          );
        }
        assertDocumentSetCurrent(dependencies, currentSet);
        prepared.value = prepareUnlockedPortfolio(
          stub,
          currentSet,
          createEngine,
          dependencies.market,
          () => activeVaultSet !== null && dependencies.isDocumentSetCurrent(activeVaultSet),
        );
        // No decrypted summary/session can cross this E3 borrow after a lock or
        // custody change that raced the synchronous engine preparation.
        assertDocumentSetCurrent(dependencies, currentSet);
        assertSessionCurrent();
      },
    );
  } catch (cause) {
    prepared.value?.engine.revoke();
    activeVaultSet = null;
    throw cause;
  }
  if (prepared.value === null) {
    activeVaultSet = null;
    throw new PortfolioStoreResolutionError(
      'VAULT_DOCUMENT_INVALID',
      'The unlocked portfolio engine could not be prepared.',
    );
  }
  const { portfolio, engine: unguardedEngine } = prepared.value;
  let disposed = false;

  const guard = async <T>(
    operation: () => Promise<VaultMoneyOutcome<T>>,
    discard?: (value: T) => void,
    currentSet?: DecryptedVaultDocumentSet,
  ): Promise<VaultMoneyOutcome<T>> => {
    if (disposed) {
      return {
        ok: false,
        error: {
          code: 'VAULT_LOCKED',
          message: 'The per-portfolio vault session is closed.',
          retryable: true,
        },
      };
    }
    const guardedSet = currentSet ?? activeVaultSet;
    if (guardedSet === null) {
      return {
        ok: false,
        error: {
          code: 'VAULT_LOCKED',
          message: 'The per-portfolio vault session is closed.',
          retryable: true,
        },
      };
    }
    try {
      return await dependencies.keys.withContentKey(
        vault.id,
        async (_borrowedContentKey, keyId, assertSessionCurrent) => {
          assertSessionCurrent();
          if (keyId !== opened.keyId) {
            throw moneyFailure(
              'OPERATION_ABORTED',
              'The vault content key changed before the client operation began.',
              { retryable: true },
            );
          }
          if (activeVaultSet !== guardedSet) {
            throw moneyFailure(
              'OPERATION_ABORTED',
              'The resolved vault document set is no longer active.',
              { retryable: true },
            );
          }
          assertDocumentSetCurrent(dependencies, guardedSet);
          const outcome = await operation();
          try {
            if (activeVaultSet !== guardedSet) {
              throw moneyFailure(
                'OPERATION_ABORTED',
                'The resolved vault document set changed during the client operation.',
                { retryable: true },
              );
            }
            assertDocumentSetCurrent(dependencies, guardedSet);
            // E3: no result/ZIP bytes cross this callback after a lock race.
            assertSessionCurrent();
          } catch (cause) {
            if (outcome.ok) discard?.(outcome.value);
            throw cause;
          }
          return outcome;
        },
      );
    } catch (cause) {
      return { ok: false, error: asMoneyFailure(cause) };
    }
  };

  const engine: PortfolioDocumentSetEngine = {
    derivePortfolio: (...args): Promise<VaultMoneyOutcome<ClientPortfolioDerivation>> =>
      guard(() => unguardedEngine.derivePortfolio(...args)),
    deriveTaxReport: (...args): Promise<VaultMoneyOutcome<ClientTaxReport>> =>
      guard(() => unguardedEngine.deriveTaxReport(...args)),
    clearCache: () => unguardedEngine.clearCache(),
    clearTaxCache: () => unguardedEngine.clearTaxCache(),
    revoke: dispose,
  };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    unguardedEngine.revoke();
    // Drop the last resolver-owned reference to every decrypted doc. The
    // engine session has already nulled its derived document snapshot above.
    activeVaultSet = null;
  }

  function requireActiveVaultSet(): DecryptedVaultDocumentSet {
    if (disposed || activeVaultSet === null) {
      throw moneyFailure('VAULT_LOCKED', 'The per-portfolio vault session is closed.', {
        retryable: true,
      });
    }
    return activeVaultSet;
  }

  async function exportCleartext(
    exportOptions?: ClientCleartextExportOptions,
  ): Promise<VaultMoneyOutcome<ClientCleartextExport>> {
    if (disposed) {
      return {
        ok: false,
        error: {
          code: 'VAULT_LOCKED',
          message: 'The per-vault export session is closed.',
          retryable: true,
        },
      };
    }
    let exportSession: ReturnType<typeof createVaultDocumentSetSession> | null = null;
    try {
      const fullSet = requireActiveVaultSet();
      exportOptions?.signal?.throwIfAborted();
      if (fullSet.header.envelope.keyId !== opened.keyId) {
        throw moneyFailure(
          'OPERATION_ABORTED',
          'The vault content key changed while the export roster was loading.',
          { retryable: true },
        );
      }
      assertDocumentSetCurrent(dependencies, fullSet);
      const createExportSession =
        dependencies.createVaultExportSession ?? createVaultDocumentSetSession;
      exportSession = createExportSession(fullSet, {
        isSessionCurrent: () =>
          activeVaultSet === fullSet && dependencies.isDocumentSetCurrent(fullSet),
      });
      const createExport = dependencies.createCleartextExport ?? createClientCleartextExport;
      return await guard(
        () => createExport(exportSession!, exportOptions),
        (exported) => exported.bytes.fill(0),
        fullSet,
      );
    } catch (cause) {
      return { ok: false, error: asMoneyFailure(cause) };
    } finally {
      exportSession?.revoke();
    }
  }

  return {
    kind: 'vaulted-unlocked',
    portfolio,
    vault,
    engine,
    exportCleartext,
    dispose,
  };
}

/** Resolve a mixed roster while preserving input order for account composition. */
export function resolvePortfolioStores(
  portfolios: readonly PortfolioSummary[],
  vaults: readonly VaultConfig[],
  dependencies: PortfolioStoreResolverDependencies,
  signal?: AbortSignal,
): Promise<PortfolioStoreResolution[]> {
  const coordination = createResolutionCoordination();
  const expectedPortfolioIds = new Map<string, string[]>();
  for (const portfolio of portfolios) {
    const vaultId = portfolio.vaultId;
    if (vaultId == null) continue;
    const ids = expectedPortfolioIds.get(vaultId);
    if (ids === undefined) expectedPortfolioIds.set(vaultId, [portfolio.id]);
    else ids.push(portfolio.id);
  }
  return Promise.all(
    portfolios.map((portfolio) => {
      const vaultId = portfolio.vaultId;
      return resolvePortfolioStoreWithCoordination(
        portfolio,
        vaults,
        dependencies,
        {
          signal,
          ...(vaultId == null
            ? {}
            : { expectedVaultPortfolioIds: expectedPortfolioIds.get(vaultId)! }),
        },
        coordination,
      );
    }),
  );
}

function createResolutionCoordination(): PortfolioStoreResolutionCoordination {
  return { endpointStates: new Map(), openedVaults: new Map(), documentSets: new Map() };
}

function coordinatedDocumentSet(
  vault: VaultConfig,
  expectedPortfolioIds: readonly string[],
  dependencies: PortfolioStoreResolverDependencies,
  coordination: PortfolioStoreResolutionCoordination,
  signal?: AbortSignal,
): Promise<DecryptedVaultDocumentSet> {
  let pending = coordination.documentSets.get(vault.id);
  if (pending === undefined) {
    const loadVaultDocumentSet = dependencies.loadVaultDocumentSet ?? loadDecryptedVaultDocumentSet;
    pending = loadVaultDocumentSet({
      vault,
      accountId: dependencies.accountId,
      expectedPortfolioIds,
      keys: dependencies.keys,
      reader: dependencies.reader,
      signal,
    });
    coordination.documentSets.set(vault.id, pending);
  }
  return pending;
}

function coordinatedStateFor(
  vaultId: string,
  dependencies: PortfolioStoreResolverDependencies,
  coordination: PortfolioStoreResolutionCoordination,
): Promise<EndpointVaultState> {
  let pending = coordination.endpointStates.get(vaultId);
  if (pending === undefined) {
    pending = dependencies.keys.stateFor(vaultId);
    coordination.endpointStates.set(vaultId, pending);
  }
  return pending;
}

function coordinatedOpen(
  vault: VaultConfig,
  dependencies: PortfolioStoreResolverDependencies,
  coordination: PortfolioStoreResolutionCoordination,
  signal?: AbortSignal,
): Promise<OpenedVault> {
  let pending = coordination.openedVaults.get(vault.id);
  if (pending === undefined) {
    const headerEnvelope = async ({ vaultId }: { vaultId: string }): Promise<Uint8Array> => {
      const read = await dependencies.reader.read(vaultId, vault.headerDocId, signal);
      return read.envelope;
    };
    pending = dependencies.keys.openStoredVault(vault.id, headerEnvelope, vault.keyFingerprint);
    coordination.openedVaults.set(vault.id, pending);
  }
  return pending;
}

function assertDocumentSetCurrent(
  dependencies: PortfolioStoreResolverDependencies,
  set: DecryptedPortfolioDocumentSet | DecryptedVaultDocumentSet,
): void {
  if (dependencies.isDocumentSetCurrent(set)) return;
  throw moneyFailure(
    'OPERATION_ABORTED',
    'The synchronized vault document set changed during the client operation.',
    { retryable: true },
  );
}

function prepareUnlockedPortfolio(
  stub: PortfolioSummary,
  vaultSet: DecryptedVaultDocumentSet,
  createEngine: typeof createPortfolioDocumentSetEngine,
  market: MarketDataSource,
  isSessionCurrent: () => boolean,
): { portfolio: PortfolioSummary; engine: PortfolioDocumentSetEngine } {
  const matchedDocuments = vaultSet.portfolios.filter(
    ({ envelope, document }) => envelope.docId === stub.id && document.portfolioId === stub.id,
  );
  if (matchedDocuments.length !== 1) {
    throw new PortfolioStoreResolutionError(
      'VAULT_DOCUMENT_INVALID',
      'The authenticated vault document set has no unique matching portfolio document.',
    );
  }
  const set: DecryptedPortfolioDocumentSet = {
    vaultId: vaultSet.vaultId,
    portfolioId: stub.id,
    header: vaultSet.header,
    common: vaultSet.common,
    portfolio: matchedDocuments[0]!,
  };
  return {
    portfolio: truePortfolioSummary(stub, set),
    engine: createEngine(set, market, { isSessionCurrent }),
  };
}

function endpointStateCanOpenSilently(state: EndpointVaultState): boolean {
  return (
    state.status === 'stored+plain' ||
    (state.status === 'stored+wrapped' && state.session === 'unlocked')
  );
}

function truePortfolioSummary(
  stub: PortfolioSummary,
  set: DecryptedPortfolioDocumentSet,
): PortfolioSummary {
  const rows = (set.portfolio.document.entities.portfolio ?? []).filter(
    (row) => row.id === stub.id && row.deletedAt === null,
  );
  if (rows.length !== 1) {
    throw new PortfolioStoreResolutionError(
      'VAULT_DOCUMENT_INVALID',
      'The authenticated portfolio document has no unique live portfolio anchor.',
    );
  }
  const row = VAULT_ENTITY_ROW_SCHEMAS.portfolio.safeParse(rows[0]!.data);
  if (!row.success) {
    throw new PortfolioStoreResolutionError(
      'VAULT_DOCUMENT_INVALID',
      'The authenticated portfolio anchor does not match its row contract.',
    );
  }
  const roster = set.header.document.portfolios.filter((entry) => entry.id === stub.id);
  if (roster.length !== 1 || roster[0]!.name !== row.data.name) {
    throw new PortfolioStoreResolutionError(
      'VAULT_DOCUMENT_INVALID',
      'The encrypted header roster and portfolio anchor disagree.',
    );
  }
  return portfolioSummarySchema.parse({
    id: stub.id,
    name: row.data.name,
    visibility: row.data.visibility,
    sortOrder: row.data.sortOrder,
    isDefault: stub.isDefault,
    defaultPayFromCash: row.data.defaultPayFromCash,
    archivedAt: row.data.archivedAt,
    kind: row.data.kind ?? null,
    vaultId: stub.vaultId,
    vaultAlias: stub.vaultAlias ?? vaultAlias(set),
  });
}

function vaultAlias(set: DecryptedPortfolioDocumentSet): string {
  return set.header.document.name;
}
