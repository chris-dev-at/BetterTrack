import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import type { PortfolioSummary } from '@bettertrack/contracts';

import { useOptionalAuth } from '../AuthContext';
import { isVaultedPortfolio } from '../portfolio/lockedPortfolio';
import type { UnlockedVaultPortfolioAccess } from './resolvedPortfolioStore';
import type { VaultedPortfolioStoresBatch } from './vaultedPortfolioStores';

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
}

const NO_UNLOCKED_PORTFOLIOS: VaultedPortfolioStores = { unlocked: new Map() };

interface RegistryEntry {
  refs: number;
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
   * A vault-opened edge that arrived mid-resolution, waiting to be judged when
   * the run settles. `consumeRerunRequest` decides what it was really about.
   */
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
    stores: NO_UNLOCKED_PORTFOLIOS,
    batch: null,
    listeners: new Set(),
    abort: new AbortController(),
    releaseKeystoreListeners: null,
    released: false,
    resolving: false,
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
  registry.set(token, entry);

  void load(entry, accountId, portfolios);
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
      });
      const releaseVaultOpened = vaultOpenedSubscription(() => {
        if (entry.released) return;
        // Our own `openStoredVault` fires this too, so an edge that lands while
        // a resolution is in flight cannot be acted on blind. Remember it and
        // let `consumeRerunRequest` judge it once the run has settled and its
        // outcome is known.
        if (entry.resolving) {
          entry.rerunRequested = true;
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
    publish(entry, { unlocked: batch.unlocked });
  } catch {
    // Fail closed to the stub. Nothing here is worth a console line: a locked
    // vault, a cancelled navigation and a failed chunk load all produce the
    // same, already-correct, screen.
    if (!superseded()) publish(entry, NO_UNLOCKED_PORTFOLIOS);
  } finally {
    if (entry.loadSeq === seq) {
      entry.resolving = false;
      consumeRerunRequest(entry, accountId, portfolios, isRerun);
    }
  }
}

/**
 * Decide what a vault-opened edge that arrived MID-RESOLUTION was about, now
 * that the run it interrupted has settled.
 *
 * The signal itself is ambiguous: the resolver's own `openStoredVault` raises
 * it, and so does the user unlocking through the access surface a moment later.
 * The OUTCOME disambiguates it. This resolution can only have raised the edge
 * if it opened a vault — and a run that opened one publishes a non-empty batch.
 * So a run that opened nothing and still saw an edge is the real case (#1531
 * F2): the vault was locked when the resolver looked, the user unlocked while
 * documents were in flight, and the empty batch just published is already
 * stale. Dropping that edge left the portfolio a stub until a reload.
 *
 * Bounded twice over. A re-run never queues another, so an edge chain is at
 * most two resolutions whatever the keystore notifies; and the keystore only
 * raises the edge on a REAL key transition, so the no-op re-open inside the
 * second run is silent anyway.
 */
function consumeRerunRequest(
  entry: RegistryEntry,
  accountId: string,
  portfolios: readonly PortfolioSummary[],
  isRerun: boolean,
): void {
  if (!entry.rerunRequested) return;
  entry.rerunRequested = false;
  if (entry.released || isRerun) return;
  if ((entry.batch?.unlocked.size ?? 0) > 0) return;
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
