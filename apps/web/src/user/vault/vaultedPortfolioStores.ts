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
  resolvePortfolioStores,
  type PortfolioStoreResolverDependencies,
} from './portfolioStoreResolver';
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

export interface VaultedPortfolioStoresBatch {
  /** Vaulted portfolios unlocked on THIS device, by portfolio id. */
  unlocked: ReadonlyMap<string, UnlockedVaultPortfolioAccess>;
  /** Revokes every access object in this batch and releases its lock listener. */
  dispose(): void;
}

export interface VaultedPortfolioStoresOverrides {
  keys?: PortfolioStoreResolverDependencies['keys'];
  reader?: PortfolioStoreResolverDependencies['reader'];
  market?: MarketDataSource;
  plainStore?: PortfolioStore;
  resolve?: typeof resolvePortfolioStores;
  subscribeToSessionEnd?: (listener: () => void) => () => void;
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
  const empty: VaultedPortfolioStoresBatch = { unlocked: new Map(), dispose: () => {} };
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

  const resolve = overrides.resolve ?? resolvePortfolioStores;
  let resolutions;
  try {
    resolutions = await resolve(input.portfolios, input.vaults, dependencies, input.signal);
  } catch (cause) {
    releaseSessionListener();
    throw cause;
  }

  const unlocked = new Map<string, UnlockedVaultPortfolioAccess>();
  for (const resolution of resolutions) {
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
 * keep rendering as a stub until the next full navigation.
 */
export function vaultOpenedSubscription(listener: () => void): () => void {
  return endpointVaultKeystore.subscribeToVaultOpened(listener);
}
