import type { PortfolioSummary, PortfolioTotals } from '@bettertrack/contracts';

import { apiPortfolioStore, type PortfolioStore } from '../../lib/portfolioStore';
import { moneyFailure } from './engine/errors';
import { createParanoidAppPortfolioStore } from './engine/paranoidPortfolioStore';
import type { UnlockedVaultPortfolioStoreResolution } from './portfolioStoreResolver';
import {
  createVaultPortfolioStore,
  VaultPortfolioStoreError,
  type VaultPortfolioDocumentSource,
  type VaultPortfolioStore,
} from './vaultPortfolioStore';

/**
 * The wiring half of the PARANOID-E6 store resolver (#1416).
 *
 * `resolvePortfolioStore` already authenticates one vaulted portfolio's split
 * document set and hands back a derivation engine. What no production surface
 * had was a {@link PortfolioStore} over that resolution — so `usePortfolioStore`
 * always yielded `apiPortfolioStore` and an unlocked vault still rendered as a
 * locked stub. This module is that adapter, and only that: it maps store calls
 * onto the resolution's engine and refuses everything the resolution cannot
 * answer. It computes nothing.
 *
 * THE READ FENCE, stated exactly. This store never asks the server for THIS
 * portfolio's money: no `GET /portfolios/:id`, no transactions, no cash, no
 * history. `getPortfolio`/`getPortfolioHistory` are derived from the decrypted
 * document by the client engine. The only endpoint it delegates to is
 * `listPortfolios`, which returns the same content-free stub roster every
 * surface already reads and is what binds a vaulted row to its vault at all.
 *
 * It is NOT a claim of total network silence: the client engine prices its
 * holdings through the ordinary market-data source, exactly as the shipped
 * paranoid engine already does (asset quotes and FX, never portfolio rows).
 * That boundary is the vault design's, not this module's, and nothing here
 * widens it.
 *
 * Everything the resolution cannot answer refuses with a typed error — never an
 * empty list, never a zero. An empty ledger and an unreadable ledger look
 * identical on screen, and only one of them is true.
 *
 * ROW READS (#1532). The projections behind transactions, cash sources,
 * movements, standing orders, custom assets and tax settings are the account
 * store's own — `createVaultPortfolioStore`, now taking a document source
 * rather than a sync engine — pointed at this resolution's authenticated
 * document. There is exactly ONE implementation of that money-adjacent mapping
 * and this module is not a second one. What stays refused is every WRITE: a
 * resolution is a read of an authenticated snapshot and owns no CAS write path,
 * so its document source refuses at `mutate`, which is where a write actually
 * becomes a write.
 */

/** Everything a surface needs from one unlocked, resolver-backed portfolio. */
export interface UnlockedVaultPortfolioAccess {
  /**
   * Identity of THIS access object — the store instance behind it, not the
   * documents it opened.
   *
   * Deliberately NOT `resolution.snapshotId`, which is content-derived and
   * therefore identical across two resolutions of the same unchanged documents
   * (`documentSetSnapshotId`). That is precisely the case this id exists for:
   * unlocking fires the vault-opened edge, the registry disposes the batch and
   * re-resolves the SAME documents, and the disposed access's in-flight
   * `getPortfolio` rejects. Keyed by snapshot the rejection would land on the
   * live store's cache entry and paint a fat error over a perfectly readable
   * portfolio (paranoid-UX failure map #1); keyed by access it lands on the
   * dead store's own entry, where nothing reads it.
   *
   * Cache scoping only. It is minted client-side, means nothing to the server,
   * and carries no vault or account material.
   */
  accessId: string;
  portfolioId: string;
  vaultId: string;
  /** The TRUE portfolio fields, decrypted — not the stub's alias. */
  portfolio: PortfolioSummary;
  /** Client store for this portfolio; no server money call reaches it. */
  store: PortfolioStore;
  /**
   * Synchronous liveness check for the render fork and for Home's composition
   * provenance. False the instant the vault locks, the session is revoked, or
   * the synchronized document set moves.
   */
  isCurrent(): boolean;
  /**
   * The figures Home composes, branded with the snapshot that produced them.
   * Separate from `store.getPortfolio` because the composition boundary refuses
   * any vaulted value that cannot name its authenticated document set.
   */
  readTotals(signal?: AbortSignal): Promise<{ totals: PortfolioTotals; snapshotId: string }>;
  /** Drops the decrypted references this access object holds. */
  dispose(): void;
}

/**
 * Monotonic per-tab counter behind {@link UnlockedVaultPortfolioAccess.accessId}.
 * A counter, not a random id: it never collides within a tab, it costs nothing,
 * and reading `vault-access-3` in React Query devtools tells you which
 * resolution an entry belongs to.
 */
let accessSequence = 0;

export interface ResolvedPortfolioStoreOptions {
  /**
   * Where the content-free portfolio roster comes from. Production is the
   * server list; tests substitute it to prove no other call escapes.
   */
  plainStore?: PortfolioStore;
}

/**
 * Build the client store for one unlocked resolution.
 *
 * The `PortfolioResponse` shaping is deliberately NOT reimplemented here: it is
 * `createParanoidAppPortfolioStore`'s, which is T1-reviewed and pinned by the
 * engine arithmetic baseline. This module supplies that composition with the
 * two things a per-portfolio resolution can honestly provide — the derivation
 * engine and the authenticated document — and a refusing row store in place of
 * the account-level mutation store it normally sits on.
 */
export function createUnlockedVaultPortfolioAccess(
  resolution: UnlockedVaultPortfolioStoreResolution,
  options: ResolvedPortfolioStoreOptions = {},
): UnlockedVaultPortfolioAccess {
  const plainStore = options.plainStore ?? apiPortfolioStore;
  const portfolioId = resolution.portfolio.id;
  const rows = resolutionRowStore(resolution, plainStore);

  const store = createParanoidAppPortfolioStore({
    engine: resolution.engine,
    sync: documentAccess(resolution),
    store: rows,
  });

  function isCurrent(): boolean {
    return resolution.documentSnapshot() !== null;
  }

  async function readTotals(
    signal?: AbortSignal,
  ): Promise<{ totals: PortfolioTotals; snapshotId: string }> {
    const response = await store.getPortfolio(portfolioId, signal);
    // Re-checked AFTER the derivation, not before: a lock that lands mid-read
    // must not be reported as a readable figure carrying a live snapshot id.
    if (!isCurrent()) {
      throw moneyFailure('VAULT_LOCKED', 'The vault locked while its portfolio totals were read.', {
        retryable: true,
      });
    }
    return { totals: response.totals, snapshotId: resolution.snapshotId };
  }

  return {
    accessId: `vault-access-${(accessSequence += 1)}`,
    portfolioId,
    vaultId: resolution.vault.id,
    portfolio: resolution.portfolio,
    store,
    isCurrent,
    readTotals,
    dispose: () => resolution.dispose(),
  };
}

/**
 * The document seam `createParanoidAppPortfolioStore` reads, served from the
 * resolution instead of from an account-wide sync coordinator. `null` once the
 * resolution is revoked, which the composition already translates into a typed
 * `VAULT_DATA_UNAVAILABLE` rather than an empty holdings list.
 */
function documentAccess(resolution: UnlockedVaultPortfolioStoreResolution) {
  return {
    get state() {
      const document = resolution.documentSnapshot();
      return { active: document === null ? null : { document } };
    },
  };
}

/**
 * The account store's projections, pointed at this resolution's document.
 *
 * `listPortfolios` is the ONE call that does not come from the vault. The
 * resolution's document holds this portfolio's rows and the vault's shared
 * common bucket — not the account's other portfolios — so projecting a roster
 * out of it would silently drop every plain and every other-vault row from the
 * switcher. The content-free server stub roster is the fact that binds a
 * vaulted portfolio to its vault at all, and every surface already reads it.
 */
function resolutionRowStore(
  resolution: UnlockedVaultPortfolioStoreResolution,
  plainStore: PortfolioStore,
): VaultPortfolioStore {
  const projections = createVaultPortfolioStore(readOnlyDocumentSource(resolution), {
    // The account store resolves an unseen market asset through `GET /assets/:id`
    // before writing its catalog snapshot into the document. Only write paths
    // reach it, and they all refuse below — but they refuse at `mutate`, which
    // is AFTER this lookup, so leaving the default in place would let a refused
    // write still put a request on the wire for a sealed portfolio's asset.
    resolveMarketAsset: async () => refuseResolutionWrite('resolveMarketAsset'),
  });

  return { ...projections, listPortfolios: (...args) => plainStore.listPortfolios(...args) };
}

/**
 * The document seam {@link createVaultPortfolioStore} reads, served from the
 * resolution's authenticated snapshot.
 *
 * `status` is derived, not stored: while the snapshot is live the source is
 * `synced`, and the instant the resolution stops vouching for it — disposed,
 * locked, or the synchronized set moved underneath — it reports `locked` with
 * no active document, which the projections already translate into a typed
 * `VAULT_LOCKED` rather than an empty list. There is no third state to model,
 * because a resolution never holds a conflicting or pending branch: it opened
 * one authenticated set and either still vouches for it or does not.
 */
function readOnlyDocumentSource(
  resolution: UnlockedVaultPortfolioStoreResolution,
): VaultPortfolioDocumentSource {
  return {
    // A resolution authors nothing, so it has no write provenance to stamp. The
    // value is unreachable — every path that would use it goes through `mutate`
    // — and naming it is more honest than borrowing a real device id.
    deviceId: 'resolver-backed-read-only',
    get state() {
      const document = resolution.documentSnapshot();
      return document === null
        ? { status: 'locked' as const, active: null }
        : { status: 'synced' as const, active: { document } };
    },
    // THE WRITE FENCE. Every mutation in the projection set funnels through
    // here, so one refusal covers all of them and no future write path can be
    // added that quietly bypasses it.
    mutate: async () => refuseResolutionWrite('mutate'),
  };
}

/**
 * The store's OWN error type, not the engine's: `asMoneyFailure` already maps
 * it to a typed money failure, so one refusal reads identically whether a
 * caller catches it raw or receives it through a money outcome.
 */
function refuseResolutionWrite(operation: string): never {
  throw new VaultPortfolioStoreError(
    'VAULT_OPERATION_UNAVAILABLE',
    `"${operation}" is not available from a resolver-backed vault portfolio store: a resolution reads an authenticated snapshot and owns no vault write path.`,
  );
}
