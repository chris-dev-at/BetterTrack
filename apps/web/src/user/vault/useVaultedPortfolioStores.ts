import { useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import { QueryClientContext, type QueryClient } from '@tanstack/react-query';

import type { PortfolioSummary } from '@bettertrack/contracts';

import { useOptionalAuth } from '../AuthContext';
import { isVaultedPortfolio } from '../portfolio/lockedPortfolio';
import { removePlaintextQueries } from './plaintextQueries';
import type { UnlockedVaultPortfolioAccess } from './resolvedPortfolioStore';
import type {
  VaultedPortfolioFailure,
  VaultedPortfolioStoresBatch,
} from './vaultedPortfolioStores';

/**
 * The one seam production surfaces use to ask "can this device read that
 * vaulted portfolio right now?" (PARANOID-E6 residual, #1416).
 *
 * DELIBERATELY LIGHT. Everything imported statically here is already in the
 * app's main graph; the resolver, the keystore and the client money engine
 * arrive through a dynamic import that only fires once the account actually
 * holds a vaulted portfolio. A normal account keeps loading exactly the API
 * portfolio adapter it loads today, and issues not one extra request.
 *
 * ONE RESOLUTION PER ROSTER, NOT PER CALLER. The registry below is module-level
 * and reference-counted because the alternative is genuinely bad: `useRollup`
 * runs inside every Home widget, so a per-hook resolution would open the vault,
 * fetch its documents and decrypt them once per widget on the board — the same
 * plaintext, materialized N times, each with its own lifetime to revoke.
 *
 * FAIL-CLOSED. No account, no vault configs, a rejected chunk load, a resolver
 * error, a locked vault — every one lands on the same empty map, which is
 * precisely today's behaviour: the stub, the locked qualifier, no server money
 * read. This hook can only ever ADD readability, never remove a guard.
 */

export interface VaultedPortfolioStores {
  /** Vaulted portfolios unlocked on this device, by portfolio id. */
  unlocked: ReadonlyMap<string, UnlockedVaultPortfolioAccess>;
  /**
   * Vaulted portfolios this device tried to open and could not, by portfolio
   * id — a vault that IS unlocked but whose documents refused, or a resolution
   * that failed before any vault was looked at (the vault directory could not
   * be read, the heavy chunk failed to load). Never a merely locked vault: the
   * stub for one of those still shows its unlock step, not an error.
   *
   * Surfacing these is what turns "unlock worked, portfolio still shows the
   * locked stub with an Open link" into a sentence the user can act on.
   */
  failures: ReadonlyMap<string, VaultedPortfolioFailure>;
}

const NO_UNLOCKED_PORTFOLIOS: VaultedPortfolioStores = { unlocked: new Map(), failures: new Map() };

interface RegistryEntry {
  refs: number;
  /** The account and roster this entry resolves for — kept so a re-run can be asked for from outside the hook. */
  accountId: string | null;
  portfolios: readonly PortfolioSummary[];
  /** Stable snapshot identity — `useSyncExternalStore` compares by reference. */
  stores: VaultedPortfolioStores;
  batch: VaultedPortfolioStoresBatch | null;
  listeners: Set<() => void>;
  /**
   * Cancels the CURRENT resolution only. `release` aborts it, so a later
   * `acquire` on the same entry has to install a fresh one: an AbortController
   * never un-aborts, and a dead signal would reject the loader's very first
   * awaited call for the rest of the tab's life.
   */
  abort: AbortController;
  releaseKeystoreListeners: (() => void) | null;
  released: boolean;
  /**
   * True while a resolution is running. The vault-opened edge fires from inside
   * `openStoredVault`, i.e. from inside OUR OWN resolution — reacting to that
   * would re-resolve forever. Only an unlock that happens while we are idle is
   * news.
   */
  resolving: boolean;
  /**
   * The vaults whose open edge arrived mid-resolution, waiting to be judged when
   * the run settles. `consumeVaultOpenEdges` decides what each one was about.
   * A SET, not a flag: two vaults unlocked inside one resolution window are two
   * independent pieces of news, and collapsing them into one dropped the second
   * (#1533).
   */
  pendingVaultOpens: Set<string>;
  /**
   * Vaults whose edge already bought a re-run in the current chain. The chain
   * bound (see `consumeVaultOpenEdges`), per vault instead of per run.
   */
  rerunVaultIds: Set<string>;
  /** A user Retry that landed while a run was in flight; honoured when it settles. */
  rerunRequested: boolean;
  /**
   * Id of the newest resolution on this entry. A run whose id is no longer
   * current has been superseded (a re-acquire, a re-run) and must publish
   * nothing: two loaders on one entry would otherwise dispose each other's
   * batch and leave the snapshot at whichever happened to finish last.
   */
  loadSeq: number;
}

const registry = new Map<string, RegistryEntry>();

/**
 * The query caches to sweep when a vault session ends.
 *
 * DROPPING THE BATCH IS NOT ENOUGH. `dispose()` releases the decrypted
 * documents this module holds, but every figure derived from them has already
 * been copied into React Query — the portfolio response, its history, Home's
 * `readTotals` — and those entries outlive the lock by `gcTime`. The
 * account-level v1 stack always swept on its lock (`AccountModeRoot` →
 * `removePlaintextQueries`); the per-portfolio model had no equivalent, so a
 * lock left decrypted holdings sitting in the cache, servable to the next
 * mount, with the vault itself correctly closed.
 *
 * Registered by the hook rather than imported: the app owns exactly one
 * `QueryClient`, but importing it here would pull the whole `UserApp` graph
 * into the module that exists to stay light, and every test builds its own.
 *
 * REFERENCE-COUNTED, like the resolution registry above and for the same
 * reason: the hook runs in the workspace, the switcher, the manager and every
 * Home widget at once, so a plain Set would let the first of them to unmount
 * deregister the cache the others are still filling.
 */
const plaintextCaches = new Map<QueryClient, number>();

function retainPlaintextCache(cache: QueryClient): () => void {
  plaintextCaches.set(cache, (plaintextCaches.get(cache) ?? 0) + 1);
  return () => {
    const refs = (plaintextCaches.get(cache) ?? 1) - 1;
    if (refs <= 0) plaintextCaches.delete(cache);
    else plaintextCaches.set(cache, refs);
  };
}

function sweepPlaintextCaches(): void {
  for (const cache of [...plaintextCaches.keys()]) removePlaintextQueries(cache);
}

interface VaultGraph {
  listVaults: typeof import('../../lib/vaultApi').listVaults;
  resolveVaultedPortfolioStores: typeof import('./vaultedPortfolioStores').resolveVaultedPortfolioStores;
  sessionEndSubscription: typeof import('./vaultedPortfolioStores').sessionEndSubscription;
  vaultOpenedSubscription: typeof import('./vaultedPortfolioStores').vaultOpenedSubscription;
}

let pendingVaultGraph: Promise<VaultGraph> | null = null;

/**
 * ONE import of the heavy half per tab, shared by every loader.
 *
 * A remount runs a second loader while the first one's imports are still in
 * flight, and each entry arms its own keystore listeners from whatever the
 * import returned — so those subscriptions must provably come from ONE module
 * instance rather than from two resolutions of the same specifier. The bundler
 * already caches `import()`; this only makes the guarantee explicit.
 */
function loadVaultGraph(): Promise<VaultGraph> {
  pendingVaultGraph ??= importVaultGraph().catch((cause: unknown) => {
    // A failed chunk load must fail THIS resolution, not poison every later
    // one: drop the cached promise so the next acquire imports again.
    pendingVaultGraph = null;
    throw cause;
  });
  return pendingVaultGraph;
}

async function importVaultGraph(): Promise<VaultGraph> {
  const { listVaults } = await import('../../lib/vaultApi');
  const { resolveVaultedPortfolioStores, sessionEndSubscription, vaultOpenedSubscription } =
    await import('./vaultedPortfolioStores');
  return {
    listVaults,
    resolveVaultedPortfolioStores,
    sessionEndSubscription,
    vaultOpenedSubscription,
  };
}

export function useVaultedPortfolioStores(
  portfolios: readonly PortfolioSummary[],
): VaultedPortfolioStores {
  // OPTIONAL auth: this hook sits under `useRollup`, which every Home widget
  // reaches. Throwing outside an `AuthProvider` would turn "no account context
  // here" into a crashed widget board; the honest answer is that without an
  // authenticated account there is no vault to open.
  const auth = useOptionalAuth();
  const accountId = auth?.status === 'authenticated' ? (auth.user?.id ?? null) : null;

  // Read through the CONTEXT rather than `useQueryClient()`, which throws when
  // there is no provider above. Same reason `useOptionalAuth` is used above:
  // this hook sits under every Home widget, and "no query client in this thin
  // tree" must not become a crashed board. No client simply means there is no
  // derived plaintext here to sweep.
  const queryClient = useContext(QueryClientContext);
  useEffect(() => {
    if (queryClient === undefined) return;
    return retainPlaintextCache(queryClient);
  }, [queryClient]);

  /**
   * Identity of the ROSTER, not of the array.
   *
   * Every portfolio is in it, plain ones included: the loader's in-flight
   * roster tolerance (#1528 F1) is derived from which ids are currently PLAIN,
   * so two callers holding different plain sets must not share one resolution.
   * And it is a string because `useQueries`-style callers hand back a fresh
   * array on every render — keying on identity would re-open the vault
   * continuously.
   */
  const rosterKey = useMemo(
    () =>
      portfolios
        .map((portfolio) => `${portfolio.id}:${portfolio.vaultId ?? ''}`)
        .sort()
        .join('|'),
    [portfolios],
  );
  const hasVaulted = portfolios.some(isVaultedPortfolio);
  const token = accountId === null || !hasVaulted ? null : `${accountId}#${rosterKey}`;

  // The roster this token stands for, held in a ref rather than a dependency.
  // `token` already encodes every field of it the resolution depends on, while
  // the ARRAY's identity changes on every render of a `useQueries`-style
  // caller — depending on that would re-open the vault continuously.
  const latestRoster = useRef(portfolios);
  latestRoster.current = portfolios;

  useEffect(() => {
    if (token === null || accountId === null) return;
    acquire(token, accountId, latestRoster.current);
    return () => release(token);
  }, [accountId, token]);

  return useSyncExternalStore(
    useCallback(
      (onChange: () => void) => (token === null ? () => {} : subscribe(token, onChange)),
      [token],
    ),
    useCallback(() => (token === null ? NO_UNLOCKED_PORTFOLIOS : snapshot(token)), [token]),
  );
}

function snapshot(token: string): VaultedPortfolioStores {
  return registry.get(token)?.stores ?? NO_UNLOCKED_PORTFOLIOS;
}

function subscribe(token: string, onChange: () => void): () => void {
  const entry = registry.get(token);
  if (entry === undefined) {
    // Subscribed before the acquiring effect ran (React subscribes during
    // commit, effects run after). A placeholder keeps the listener attached to
    // the same entry the loader will fill in.
    registry.set(token, placeholderEntry());
  }
  const target = registry.get(token)!;
  target.listeners.add(onChange);
  return () => {
    target.listeners.delete(onChange);
    // `release` runs BEFORE this — the acquiring effect is registered first, so
    // React tears it down first — and can only keep the entry because a
    // listener was still attached. Removing the last one is the second half of
    // that decision; without this re-check every roster token the account ever
    // mounted leaves a dead entry behind for the tab's lifetime.
    if (target.refs <= 0 && target.listeners.size === 0 && registry.get(token) === target) {
      registry.delete(token);
    }
  };
}

function placeholderEntry(): RegistryEntry {
  return {
    refs: 0,
    accountId: null,
    portfolios: [],
    stores: NO_UNLOCKED_PORTFOLIOS,
    batch: null,
    listeners: new Set(),
    abort: new AbortController(),
    releaseKeystoreListeners: null,
    released: false,
    resolving: false,
    pendingVaultOpens: new Set(),
    rerunVaultIds: new Set(),
    rerunRequested: false,
    loadSeq: 0,
  };
}

function publish(entry: RegistryEntry, stores: VaultedPortfolioStores): void {
  entry.stores = stores;
  for (const listener of [...entry.listeners]) listener();
}

function acquire(token: string, accountId: string, portfolios: readonly PortfolioSummary[]): void {
  const existing = registry.get(token);
  if (existing !== undefined && existing.refs > 0) {
    existing.refs += 1;
    return;
  }
  const entry = existing ?? placeholderEntry();
  entry.refs += 1;
  entry.released = false;
  // A REUSED ENTRY CARRIES A DEAD SIGNAL. `release` aborted this controller and
  // an AbortController never comes back, so handing the same signal to the
  // loader makes `listVaults` reject instantly and the entry then serves the
  // empty map forever — which is what shipped: StrictMode hit it on every dev
  // mount, production on every Home → Portfolio → Home round trip.
  //
  // The second lock on the same door. `release` only keeps an entry while a
  // listener is attached, and the unsubscribe path now drops it as soon as the
  // last one goes — so today this branch is unreachable through the hook. It
  // stays because `release`'s keep-the-entry decision is the one that is
  // allowed to change: reusing an entry is only ever safe with a live signal.
  if (entry.abort.signal.aborted) entry.abort = new AbortController();
  entry.accountId = accountId;
  entry.portfolios = portfolios;
  registry.set(token, entry);

  void load(entry, accountId, portfolios);
}

/**
 * Ask every live roster to resolve again — the "Retry" behind a surfaced
 * failure. It re-runs exactly what a mount would, against the same registry
 * entries, so a stub that just reported "could not be opened" re-asks the
 * keystore and the media instead of waiting for the next navigation. Entries
 * nothing is rendering are left alone.
 */
export function rerunVaultedPortfolioStores(): void {
  for (const entry of registry.values()) {
    if (entry.refs <= 0 || entry.released || entry.accountId === null) continue;
    if (entry.resolving) {
      // A Retry pressed while a run is in flight is not a no-op: the run that
      // is settling may be the very one that will fail again, so one more run
      // is queued and starts the moment this one settles (see `load`'s finally).
      entry.rerunRequested = true;
      continue;
    }
    entry.batch?.dispose();
    entry.batch = null;
    void load(entry, entry.accountId, entry.portfolios, true);
  }
}

async function load(
  entry: RegistryEntry,
  accountId: string,
  portfolios: readonly PortfolioSummary[],
  isRerun = false,
): Promise<void> {
  const seq = (entry.loadSeq += 1);
  const superseded = () => entry.released || entry.loadSeq !== seq;
  entry.resolving = true;
  // A fresh resolution starts a new edge chain, so the per-vault bound below
  // starts over with it.
  if (!isRerun) entry.rerunVaultIds.clear();
  try {
    const {
      listVaults,
      resolveVaultedPortfolioStores,
      sessionEndSubscription,
      vaultOpenedSubscription,
    } = await loadVaultGraph();
    if (superseded()) return;
    if (entry.releaseKeystoreListeners === null) {
      // Armed BEFORE the resolution, so a lock landing while documents are in
      // flight still drops the batch this loader is about to publish.
      const releaseSessionEnd = sessionEndSubscription(() => {
        entry.batch?.dispose();
        entry.batch = null;
        publish(entry, NO_UNLOCKED_PORTFOLIOS);
        // Evict the DERIVED plaintext too, not just the documents it came from
        // (see `plaintextCaches`). Ordered after `publish` so the surfaces have
        // already been told to fall back to their stubs: the sweep then removes
        // entries nothing is reading, rather than yanking data out from under a
        // render that is still showing it.
        sweepPlaintextCaches();
      });
      const releaseVaultOpened = vaultOpenedSubscription((vaultId: string) => {
        if (entry.released) return;
        // A vault no portfolio in THIS roster lives in cannot change this
        // snapshot, however it was opened: re-resolving for it would decrypt
        // the same documents again for nothing.
        if (!rosterHoldsVault(portfolios, vaultId)) return;
        // Our own `openStoredVault` fires this too, so an edge that lands while
        // a resolution is in flight cannot be acted on blind. Remember which
        // vault it named and let `consumeVaultOpenEdges` judge it once the run
        // has settled and its outcome is known.
        if (entry.resolving) {
          entry.pendingVaultOpens.add(vaultId);
          return;
        }
        entry.batch?.dispose();
        entry.batch = null;
        void load(entry, accountId, portfolios);
      });
      entry.releaseKeystoreListeners = () => {
        releaseSessionEnd();
        releaseVaultOpened();
      };
    }
    // Pinned once: `release` swaps in a fresh controller for the NEXT
    // resolution, and this run must keep cancelling on the one it started with.
    const signal = entry.abort.signal;
    const vaults = await listVaults(signal);
    if (superseded()) return;
    const batch = await resolveVaultedPortfolioStores({
      accountId,
      portfolios,
      vaults,
      signal,
    });
    if (superseded()) {
      batch.dispose();
      return;
    }
    entry.batch?.dispose();
    entry.batch = batch;
    publish(entry, { unlocked: batch.unlocked, failures: batch.failures });
  } catch (cause) {
    // Fail closed to the stub — but SAY SO. A cancelled navigation is silent
    // (its entry is superseded); everything else that reaches here failed
    // before a single vault could be judged — the vault directory read, the
    // heavy chunk, the resolver's own preconditions — and hiding that behind
    // a "Locked" stub is what made a working unlock look broken. Every vaulted
    // portfolio in the roster carries the same failure, because the failure
    // is the roster's.
    if (!superseded()) publish(entry, rosterWideFailure(portfolios, cause));
  } finally {
    if (entry.loadSeq === seq) {
      entry.resolving = false;
      if (entry.rerunRequested && !entry.released) {
        // A Retry that arrived mid-run (see `rerunVaultedPortfolioStores`).
        entry.rerunRequested = false;
        entry.batch?.dispose();
        entry.batch = null;
        void load(entry, accountId, portfolios, true);
      } else {
        entry.rerunRequested = false;
        consumeVaultOpenEdges(entry, accountId, portfolios);
      }
    }
  }
}

function rosterWideFailure(
  portfolios: readonly PortfolioSummary[],
  cause: unknown,
): VaultedPortfolioStores {
  const failures = new Map<string, VaultedPortfolioFailure>();
  const message = cause instanceof Error ? cause.message : String(cause);
  const code =
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    typeof (cause as { code: unknown }).code === 'string'
      ? (cause as { code: string }).code
      : 'VAULT_RESOLUTION_FAILED';
  for (const portfolio of portfolios) {
    if (!isVaultedPortfolio(portfolio)) continue;
    failures.set(portfolio.id, { vaultId: portfolio.vaultId, code, message });
  }
  return { unlocked: new Map(), failures };
}

/** Does any portfolio in this roster live in that vault? */
function rosterHoldsVault(portfolios: readonly PortfolioSummary[], vaultId: string): boolean {
  return portfolios.some((portfolio) => portfolio.vaultId === vaultId);
}

/**
 * Did the settled run leave that vault's portfolios stale?
 *
 * The question the edge really asks. A run that opened the vault itself ends
 * with every one of its portfolios in the published batch, so its own edge
 * answers no; an unlock that landed WHILE the resolver was looking at a locked
 * vault leaves them missing, and that is the news worth another resolution.
 */
function vaultLeftStale(
  entry: RegistryEntry,
  portfolios: readonly PortfolioSummary[],
  vaultId: string,
): boolean {
  const unlocked = entry.batch?.unlocked;
  return portfolios.some(
    (portfolio) => portfolio.vaultId === vaultId && unlocked?.has(portfolio.id) !== true,
  );
}

/**
 * Decide what the vault-opened edges that arrived MID-RESOLUTION were about,
 * now that the run they interrupted has settled.
 *
 * Each signal on its own is ambiguous: the resolver's own `openStoredVault`
 * raises one, and so does the user unlocking through the access surface a
 * moment later. The vault id disambiguates it PER VAULT. This resolution can
 * only have raised the edge for a vault it opened — and a vault it opened has
 * its portfolios in the batch just published. So an edge naming a vault whose
 * portfolios are still missing is the real case (#1531 F2): the vault was
 * locked when the resolver looked, the user unlocked while documents were in
 * flight, and what was just published is already stale.
 *
 * Judging that by the RUN's outcome instead — "opened nothing, saw an edge" —
 * was right for one vault and wrong for two (#1533): a re-run that unlocks the
 * first vault publishes a non-empty batch, and a second vault unlocked inside
 * that window was then indistinguishable from the re-run's own open, so its
 * portfolios stayed stubs until the next remount.
 *
 * STILL BOUNDED, now per vault: a vault's edge buys at most one re-run per
 * chain, so a chain is at most one resolution per roster vault however the
 * keystore notifies. The keystore's own silence on a no-op re-open (#1531)
 * keeps the ordinary case at two.
 */
function consumeVaultOpenEdges(
  entry: RegistryEntry,
  accountId: string,
  portfolios: readonly PortfolioSummary[],
): void {
  const pending = [...entry.pendingVaultOpens];
  entry.pendingVaultOpens.clear();
  if (pending.length === 0 || entry.released) return;
  const stale = pending.filter(
    (vaultId) => !entry.rerunVaultIds.has(vaultId) && vaultLeftStale(entry, portfolios, vaultId),
  );
  if (stale.length === 0) return;
  for (const vaultId of stale) entry.rerunVaultIds.add(vaultId);
  entry.batch?.dispose();
  entry.batch = null;
  void load(entry, accountId, portfolios, true);
}

function release(token: string): void {
  const entry = registry.get(token);
  if (entry === undefined) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  entry.released = true;
  entry.pendingVaultOpens.clear();
  entry.rerunVaultIds.clear();
  entry.rerunRequested = false;
  entry.abort.abort();
  entry.releaseKeystoreListeners?.();
  entry.releaseKeystoreListeners = null;
  entry.batch?.dispose();
  entry.batch = null;
  entry.stores = NO_UNLOCKED_PORTFOLIOS;
  // Only drop the entry when nothing is still listening, so a subscriber that
  // outlives the last acquirer keeps reading the same (now empty) snapshot.
  if (entry.listeners.size === 0) registry.delete(token);
}

/**
 * Test-only reset; production has exactly one registry for the tab's lifetime.
 *
 * Returns how many entries it had to clear, which is the only way to observe
 * the leak the unsubscribe re-check closes (#1531 F4): a dead entry holds no
 * key material — `release` disposed the batch and dropped the keystore
 * listeners — so its ONLY symptom is that it is still there.
 */
export function resetVaultedPortfolioStoreRegistry(): number {
  // A retained cache outliving its suite would let one test's `QueryClient` be
  // swept by the next test's lock.
  plaintextCaches.clear();
  const cleared = registry.size;
  for (const token of [...registry.keys()]) {
    const entry = registry.get(token)!;
    entry.released = true;
    entry.abort.abort();
    entry.releaseKeystoreListeners?.();
    entry.batch?.dispose();
    registry.delete(token);
  }
  return cleared;
}
