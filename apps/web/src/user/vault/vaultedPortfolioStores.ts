import type { PortfolioSummary, VaultConfig } from '@bettertrack/contracts';

import {
  createBetterTrackMarketDataSource,
  type MarketDataSource,
} from '../../lib/marketDataSource';
import { apiPortfolioStore, type PortfolioStore } from '../../lib/portfolioStore';
import { apiVaultDocEnvelopeReader } from '../../lib/vaultsApi';
import type {
  DecryptedPortfolioDocumentSet,
  DecryptedVaultDocumentSet,
} from './engine/portfolioDocumentSet';
import { endpointVaultKeystore } from './keystore/runtime';
import {
  PortfolioStoreResolutionError,
  resolvePortfolioStoresSettled,
  type PortfolioStoreResolverDependencies,
} from './portfolioStoreResolver';
import { EndpointKeystoreError } from './keystore/errors';
import {
  createUnlockedVaultPortfolioAccess,
  type UnlockedVaultPortfolioAccess,
} from './resolvedPortfolioStore';

/**
 * Production owner of the E6 per-portfolio store resolution (#1416).
 *
 * This is the module that finally gives `resolvePortfolioStores` a caller. It
 * is deliberately the HEAVY half — it pulls the keystore, the document-set
 * loader and the client money engine — and is reached only through the lazy
 * import in `useVaultedPortfolioStores`, so a session with no vaulted portfolio
 * never loads any of it.
 */

export interface VaultedPortfolioStoresInput {
  /** Authenticated account id; its digest is bound into every AEAD address. */
  accountId: string;
  portfolios: readonly PortfolioSummary[];
  vaults: readonly VaultConfig[];
  signal?: AbortSignal;
}

/**
 * Why one vaulted portfolio could not be opened on this device although its
 * vault is not (or not merely) locked. The `code` is the resolver's or the
 * keystore's own typed code when there is one, so a surface can pick copy by
 * it; `message` is the engineer-facing sentence, shown folded for a bug report.
 */
export interface VaultedPortfolioFailure {
  vaultId: string;
  code: string;
  message: string;
}

export interface VaultedPortfolioStoresBatch {
  /** Vaulted portfolios unlocked on THIS device, by portfolio id. */
  unlocked: ReadonlyMap<string, UnlockedVaultPortfolioAccess>;
  /**
   * Vaulted portfolios this device tried to open and could not, by portfolio
   * id. A LOCKED vault is not a failure (it never got as far as an open); this
   * map holds the ones whose open or document set refused.
   */
  failures: ReadonlyMap<string, VaultedPortfolioFailure>;
  /** Revokes every access object in this batch and releases its lock listener. */
  dispose(): void;
}

export interface VaultedPortfolioStoresOverrides {
  keys?: PortfolioStoreResolverDependencies['keys'];
  reader?: PortfolioStoreResolverDependencies['reader'];
  market?: MarketDataSource;
  plainStore?: PortfolioStore;
  resolve?: typeof resolvePortfolioStoresSettled;
  subscribeToSessionEnd?: (listener: () => void) => () => void;
}

/** Name a resolution failure for the surface that has to show it. */
export function describeVaultedPortfolioFailure(
  vaultId: string,
  cause: unknown,
): VaultedPortfolioFailure {
  if (cause instanceof PortfolioStoreResolutionError || cause instanceof EndpointKeystoreError) {
    return { vaultId, code: cause.code, message: cause.message };
  }
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const code = (cause as { code: unknown }).code;
    const message = (cause as { message?: unknown }).message;
    if (typeof code === 'string') {
      return { vaultId, code, message: typeof message === 'string' ? message : code };
    }
  }
  return {
    vaultId,
    code: 'VAULT_OPEN_FAILED',
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

/**
 * One market adapter for the whole app, created on first use.
 *
 * A per-batch adapter would give every re-resolution a cold quote/FX cache and
 * re-request the same prices the previous batch had just fetched — for the same
 * portfolios, from the same device, seconds apart.
 */
let sharedMarket: MarketDataSource | null = null;
function marketDataSource(): MarketDataSource {
  sharedMarket ??= createBetterTrackMarketDataSource();
  return sharedMarket;
}

/**
 * Resolve every vaulted portfolio in the roster and keep the ones this device
 * can actually open.
 *
 * A LOCKED vault resolves and is dropped here, exactly as before: it produces
 * no store, no read and no request beyond the local custody check. Nothing in
 * this path can turn a locked vault into a server money read — the resolver
 * returns before any document is fetched, and the store built for an unlocked
 * one issues no money request either.
 */
export async function resolveVaultedPortfolioStores(
  input: VaultedPortfolioStoresInput,
  overrides: VaultedPortfolioStoresOverrides = {},
): Promise<VaultedPortfolioStoresBatch> {
  const empty: VaultedPortfolioStoresBatch = {
    unlocked: new Map(),
    failures: new Map(),
    dispose: () => {},
  };
  if (!input.portfolios.some((portfolio) => portfolio.vaultId != null)) return empty;

  /**
   * Batch-scoped currency. Two independent reasons a resolution stops being
   * current, both fatal and both synchronous:
   *
   *  1. the endpoint key session ended (manual lock, logout, PIN idle-lock,
   *     custody change) — every batch resolved under the old session dies;
   *  2. the loaded envelope set for a vault is no longer the one this batch
   *     authenticated — pinned by IDENTITY, so a re-load cannot be mistaken
   *     for the set the engine derived from.
   */
  let revoked = false;
  const pinnedSets = new Map<string, DecryptedPortfolioDocumentSet | DecryptedVaultDocumentSet>();
  const subscribe = overrides.subscribeToSessionEnd ?? sessionEndSubscription;
  const releaseSessionListener = subscribe(() => {
    revoked = true;
  });

  const dependencies: PortfolioStoreResolverDependencies = {
    accountId: input.accountId,
    keys: overrides.keys ?? endpointVaultKeystore,
    reader: overrides.reader ?? apiVaultDocEnvelopeReader,
    market: overrides.market ?? marketDataSource(),
    plainStore: overrides.plainStore ?? apiPortfolioStore,
    isDocumentSetCurrent(set) {
      if (revoked) return false;
      const pinned = pinnedSets.get(set.vaultId);
      if (pinned === undefined) {
        pinnedSets.set(set.vaultId, set);
        return true;
      }
      return pinned === set;
    },
  };

  const resolve = overrides.resolve ?? resolvePortfolioStoresSettled;
  let outcomes;
  try {
    outcomes = await resolve(input.portfolios, input.vaults, dependencies, input.signal);
  } catch (cause) {
    releaseSessionListener();
    throw cause;
  }

  const unlocked = new Map<string, UnlockedVaultPortfolioAccess>();
  const failures = new Map<string, VaultedPortfolioFailure>();
  for (const outcome of outcomes) {
    if (outcome.status === 'failed') {
      const vaultId = outcome.portfolio.vaultId;
      // A plain portfolio cannot fail here (its resolution is a constant); the
      // guard only keeps the type honest.
      if (vaultId != null) {
        failures.set(outcome.portfolio.id, describeVaultedPortfolioFailure(vaultId, outcome.cause));
      }
      continue;
    }
    const { resolution } = outcome;
    if (resolution.kind !== 'vaulted-unlocked') continue;
    unlocked.set(
      resolution.portfolio.id,
      createUnlockedVaultPortfolioAccess(resolution, {
        plainStore: overrides.plainStore ?? apiPortfolioStore,
      }),
    );
  }

  let disposed = false;
  return {
    unlocked,
    failures,
    dispose() {
      if (disposed) return;
      disposed = true;
      revoked = true;
      releaseSessionListener();
      for (const access of unlocked.values()) access.dispose();
      pinnedSets.clear();
    },
  };
}

/**
 * The endpoint session-end signal, which every lock path already funnels
 * through: `endSession()` is what manual lock, logout, tab teardown and the PIN
 * idle-lock call, and the cross-tab `VAULT_LOCK_REQUEST_EVENT` reaches it via
 * the keystore's own binding. Subscribing HERE rather than to the DOM event
 * keeps this batch on the same boundary the key material uses.
 */
export function sessionEndSubscription(listener: () => void): () => void {
  return endpointVaultKeystore.subscribeToSessionEnd(listener);
}

/**
 * The other edge: a vault became openable on this endpoint. Without it an
 * unlock would leave every already-resolved roster stale — resolved while
 * locked, and never asked again — so the portfolio the user just unlocked would
 * keep rendering as a stub until the next full navigation. The listener is told
 * WHICH vault opened, so a consumer can tell an open it caused itself from a
 * foreign one per vault rather than by the outcome of the run it interrupted.
 */
export function vaultOpenedSubscription(listener: (vaultId: string) => void): () => void {
  return endpointVaultKeystore.subscribeToVaultOpened(listener);
}
